import { randomUUID } from 'node:crypto';
import { AdtBackend, adtUri, programUri, sameSavedSource, type Backend, type Version } from './adt.js';
import { ConfigStore, digest, type Connection, type Credentials } from './config.js';
import { AuditLog } from './audit.js';
import { AppError, safeError } from './errors.js';

export type Input = {
  connection_id?: string; query?: string; type?: string; limit?: number; package_name?: string;
  object_uri?: string; source_uri?: string; version?: Version; source?: string; expected_revision?: string;
  name?: string; description?: string; transport_task?: string; request_id?: string;
  objects?: { object_uri: string; expected_revision: string }[];
};
export type Result = { operation_id: string; status: string; completed_steps: string[]; data?: unknown;
  outcome?: string; error?: ReturnType<typeof safeError>; warnings?: string[] };
type Context = { steps: string[]; dispatched: boolean; confirmed: boolean; warnings: string[]; event: (phase: string) => Promise<void> };
export type BackendFactory = (c: Connection, password: string) => Backend;
const writes = new Set(['create_program', 'update_source', 'activate_objects']);

export class Operations {
  private sessions = new Map<string, Backend>();
  private queues = new Map<string, Promise<unknown>>();
  private requests = new Map<string, { hash: string; result: Promise<Result> }>();
  private pending = 0;
  private poisoned = new Set<Backend>();
  private closing = false;
  constructor(private store: ConfigStore, private credentials: Credentials, private audit = new AuditLog(),
    private factory: BackendFactory = (c, p) => new AdtBackend(c, p)) {}
  async run(tool: string, input: Input): Promise<Result> {
    if (this.closing) throw new AppError('SERVER_STOPPING', 'Server is stopping');
    if (this.pending >= 100) throw new AppError('BUSY', 'Too many pending operations');
    if (writes.has(tool)) {
      const key = JSON.stringify([input.connection_id, input.request_id]);
      const hash = digest(JSON.stringify([tool, input]));
      const existing = this.requests.get(key);
      if (existing) {
        if (existing.hash !== hash) throw new AppError('REQUEST_ID_CONFLICT', 'Request ID was already used with different parameters');
        return existing.result;
      }
      if (this.requests.size >= 10000) throw new AppError('REQUEST_LIMIT', 'Request index is full; restart after confirming pending operations');
      const result = this.enqueue(tool, input);
      this.requests.set(key, { hash, result });
      return result;
    }
    return this.enqueue(tool, input);
  }
  private enqueue(tool: string, input: Input) {
    const key = input.connection_id ?? 'list';
    this.pending++;
    const result = (this.queues.get(key) ?? Promise.resolve()).catch(() => {}).then(() => this.execute(tool, input));
    const tail = result.finally(() => { this.pending--; if (this.queues.get(key) === tail) this.queues.delete(key); });
    this.queues.set(key, tail);
    return tail;
  }
  private async execute(tool: string, input: Input): Promise<Result> {
    const id = randomUUID();
    const ctx: Context = { steps: [], dispatched: false, confirmed: false, warnings: [], event: async phase => {
      ctx.steps.push(phase);
      try { await this.audit.append({ operation_id: id, request_id: input.request_id, connection_id: input.connection_id,
        tool, object_uri: input.object_uri ?? input.source_uri, event: phase, completed_steps: [...ctx.steps] }); }
      catch { if (!ctx.dispatched) throw new AppError('LOG_UNAVAILABLE', 'Cannot record operation before writing');
        ctx.warnings.push('LOG_WRITE_FAILED'); }
    } };
    try {
      const config = await this.store.load();
      if (tool === 'list_connections') return { operation_id: id, status: 'success', completed_steps: [], data:
        config.connections.map(c => ({ connection_id: c.connection_id, name: c.name, write_enabled: c.write_enabled })) };
      const connection = config.connections.find(c => c.connection_id === input.connection_id);
      if (!connection) throw new AppError('CONNECTION_NOT_FOUND', 'Unknown connection ID');
      if (writes.has(tool) && !connection.write_enabled) throw new AppError('WRITE_DISABLED', 'Enable writes in local connection settings first');
      let backend = this.sessions.get(connection.connection_id);
      if (!backend) {
        backend = this.factory(connection, await this.credentials.get(connection.connection_id));
        this.sessions.set(connection.connection_id, backend);
      }
      if (writes.has(tool) && this.poisoned.has(backend)) throw new AppError('SESSION_NEEDS_REVIEW', 'Previous lock cleanup failed; verify SAP locks before restarting the service');
      const data = await this.dispatch(tool, input, connection, backend, ctx);
      return { operation_id: id, status: 'success', completed_steps: ctx.steps, data,
        ...(writes.has(tool) ? { outcome: 'confirmed' } : {}), ...(ctx.warnings.length ? { warnings: ctx.warnings } : {}) };
    } catch (error) {
      const failure = safeError(error);
      if (writes.has(tool)) {
        try { await this.audit.append({ operation_id: id, request_id: input.request_id, connection_id: input.connection_id,
          event: 'failed', completed_steps: ctx.steps, error_code: failure.code }); } catch { ctx.warnings.push('LOG_WRITE_FAILED'); }
      }
      return { operation_id: id, status: 'error', completed_steps: ctx.steps, error: failure,
        ...(writes.has(tool) ? { outcome: ctx.confirmed ? 'partial' : ctx.dispatched ? 'unknown' : 'confirmed' } : {}),
        ...(ctx.warnings.length ? { warnings: ctx.warnings } : {}) };
    }
  }
  private requireTransport(pkg: string, transport?: string) {
    if (pkg.toUpperCase() !== '$TMP' && !transport) throw new AppError('TRANSPORT_REQUIRED', 'A transport task is required for this package');
  }
  private async locked<T>(b: Backend, object: string, ctx: Context, action: (handle: string) => Promise<T>): Promise<T> {
    let handle: string;
    try { handle = await b.lock(object); }
    catch (error) {
      if (safeError(error).code === 'OUTCOME_UNKNOWN') { this.poisoned.add(b); ctx.warnings.push('LOCK_STATE_UNKNOWN'); }
      throw error;
    }
    if (!handle) throw new AppError('LOCK_FAILED', 'Backend did not return a lock handle');
    let value: T | undefined;
    let failure: unknown;
    try { value = await action(handle); } catch (error) { failure = error; }
    try { await b.unlock(object, handle); ctx.steps.push('unlocked'); }
    catch { ctx.warnings.push('LOCK_CLEANUP_FAILED'); this.poisoned.add(b); }
    await ctx.event('lock_cleanup_finished').catch(() => { ctx.warnings.push('LOG_WRITE_FAILED'); });
    if (failure) throw failure;
    return value as T;
  }
  private async dispatch(tool: string, p: Input, c: Connection, b: Backend, ctx: Context): Promise<unknown> {
    switch (tool) {
      case 'get_capabilities': return b.capabilities();
      case 'search_objects': return b.search(p.query!, p.type, p.limit ?? 100);
      case 'list_package_objects': return b.listPackage(p.package_name!, p.limit ?? 100);
      case 'read_source': return b.read(adtUri(p.object_uri!), p.version ?? 'active', p.source_uri);
      case 'syntax_check': return b.check(adtUri(p.object_uri!), p.version ?? 'inactive');
      case 'list_transport_requests': return b.transports();
      case 'create_program': {
        this.requireTransport(p.package_name!, p.transport_task);
        await ctx.event('started');
        ctx.dispatched = true;
        const uri = await b.create(p.name!, p.description!, p.package_name!, p.transport_task);
        ctx.confirmed = true;
        await ctx.event('created');
        return { object_uri: uri, activated: false };
      }
      case 'update_source': {
        const object = programUri(p.source_uri!);
        this.requireTransport(await b.packageOf(object), p.transport_task);
        await ctx.event('started');
        return this.locked(b, object, ctx, async handle => {
          ctx.steps.push('locked');
          // Revisions from either version are accepted, but that exact version is re-read under lock.
          const active = await b.read(object, 'active').catch(error => {
            if (safeError(error).code === 'OBJECT_NOT_FOUND' || safeError(error).code === 'VERSION_UNAVAILABLE') return undefined;
            throw error;
          });
          let current = active;
          if (!active || active.revision !== p.expected_revision) current = await b.read(object, 'inactive');
          if (!current || current.revision !== p.expected_revision) throw new AppError('VERSION_CONFLICT', 'Source changed; read it again');
          if (current.source_uri !== p.source_uri) throw new AppError('INVALID_URI', 'Source is not the program main source');
          // An inactive draft must not be silently overwritten from an active revision.
          if (current.version === 'active') {
            const draft = await b.read(object, 'inactive').catch(error => {
              if (['OBJECT_NOT_FOUND', 'VERSION_UNAVAILABLE'].includes(safeError(error).code)) return undefined;
              throw error;
            });
            if (draft && draft.hash !== current.hash) throw new AppError('VERSION_CONFLICT', 'An inactive draft exists; read inactive before editing');
          }
          await ctx.event('version_checked');
          ctx.dispatched = true;
          await b.save(p.source_uri!, p.source!, handle, p.transport_task);
          ctx.confirmed = true;
          await ctx.event('saved');
          const saved = await b.read(object, 'inactive');
          if (!sameSavedSource(saved.source, p.source!)) throw new AppError('VERIFY_FAILED', 'Saved source differs from the submitted source');
          await ctx.event('verified');
          return { ...saved, activated: false };
        });
      }
      case 'activate_objects': {
        for (const o of p.objects!) await b.packageOf(programUri(o.object_uri));
        await ctx.event('started');
        const results: unknown[] = [];
        for (const o of p.objects!) {
          const uri = programUri(o.object_uri);
          try {
          const source = await this.locked(b, uri, ctx, async () => {
            const source = await b.read(uri, 'inactive');
            if (source.revision !== o.expected_revision) throw new AppError('VERSION_CONFLICT', 'Inactive source changed; read it again');
            return source;
          });
          // SAP activation must acquire its own enqueue lock; release our editor lock first.
          if (this.poisoned.has(b)) throw new AppError('LOCK_CLEANUP_FAILED', 'Editor lock was not released; activation was not sent');
          const checked = await b.read(uri, 'inactive');
          if (checked.revision !== source.revision) throw new AppError('VERSION_CONFLICT', 'Inactive source changed after unlocking');
          await ctx.event('activation_version_checked');
            ctx.dispatched = true;
            ctx.confirmed = false;
            const result = await b.activate(uri);
            ctx.confirmed = true;
            await ctx.event(result.success ? 'activated' : 'activation_failed');
            if (result.success) {
              const active = await b.read(uri, 'active');
              if (!sameSavedSource(active.source, source.source)) throw new AppError('VERIFY_FAILED', 'Active source differs after activation');
              await ctx.event('activation_verified');
            }
          results.push({ object_uri: uri, ...result });
          if (!result.success) throw new AppError('ACTIVATION_FAILED', 'Activation failed', { results });
          } catch (error) {
            const failure = safeError(error);
            throw new AppError(failure.code, failure.message, { results, failed_object_uri: uri, cause: failure.details });
          }
        }
        return { results };
      }
      default: throw new AppError('UNKNOWN_TOOL', 'Unknown tool');
    }
  }
  async close() {
    this.closing = true;
    await Promise.allSettled([...this.queues.values()]);
    await Promise.allSettled([...this.sessions.values()].map(s => s.close()));
  }
}
