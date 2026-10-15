import { randomUUID } from 'node:crypto';
import { AdtBackend, adtUri, programUri, functionGroupUri, isFunctionGroup, compareSavedSource, savedSourceHash, definitionCommentsHash, type Backend, type Version, type ProgramKind } from './adt.js';
import { ConfigStore, digest, type Connection, type Credentials } from './config.js';
import { AuditLog } from './audit.js';
import { AppError, safeError } from './errors.js';
import { functionModuleGuidance } from './function-help.js';
import { tableQuerySchema, readOnlySql, type TableQuery } from './data-query.js';

export type Input = {
  connection_id?: string; query?: string; type?: string; limit?: number; package_name?: string;
  object_uri?: string; source_uri?: string; version?: Version; source?: string; expected_revision?: string;
  name?: string; description?: string; transport_task?: string; request_id?: string;
  program_kind?: ProgramKind;
  function_group_uri?: string;
  table_name?: string; fields?: string[]; filters?: TableQuery['filters']; sql?: string;
  objects?: { object_uri: string; expected_revision: string }[];
};
type SourceSaveState = { saved: boolean | 'unknown'; verification: 'not_run' | 'pending' | 'passed' | 'failed' | 'unavailable'; object_uri: string; source_uri?: string; inactive_revision?: string; next_action?: string; normalization_applied?: boolean; difference?: string };
export type Result = { operation_id: string; status: string; completed_steps: string[]; data?: unknown; source_save?: SourceSaveState;
  outcome?: string; write_dispatched?: boolean; error?: ReturnType<typeof safeError>; warnings?: string[] };
type Context = { steps: string[]; dispatched: boolean; confirmed: boolean; warnings: string[]; source_save?: SourceSaveState; event: (phase: string) => Promise<void> };
export type BackendFactory = (c: Connection, password: string) => Backend;
const writes = new Set(['create_program', 'create_function_group', 'create_function_module', 'create_transport_request', 'update_source', 'activate_objects']);
const recoverableSessionErrors = new Set(['AUTH_FAILED', 'CSRF_FAILED', 'HTTP_FORBIDDEN', 'ADT_ERROR', 'OUTCOME_UNKNOWN']);
const cachedResultLimit = 32 * 1024;
function cacheResult(result: Result): Result {
  const compact: Result = JSON.parse(JSON.stringify(result, (key, value) => key === 'source' ? undefined : value));
  if (Buffer.byteLength(JSON.stringify(compact), 'utf8') <= cachedResultLimit) return compact;
  return { operation_id: result.operation_id, status: result.status, completed_steps: result.completed_steps,
    outcome: result.outcome, write_dispatched: result.write_dispatched,
    error: result.error ? { code: result.error.code, message: result.error.message.slice(0, 2048) } : undefined,
    warnings: [...(result.warnings ?? []), 'CACHED_DETAILS_OMITTED'] };
}

export class Operations {
  private sessions = new Map<string, Backend>();
  private queues = new Map<string, Promise<unknown>>();
  private requests = new Map<string, { hash: string; result: Promise<Result> }>();
  private pending = 0;
  private poisoned = new Set<Backend>();
  private closing = false;
  constructor(private store: ConfigStore, private credentials: Credentials, private audit = new AuditLog(),
    private factory: BackendFactory = (c, p) => new AdtBackend(c, p), private cacheEntryLimit = 512) {}
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
      if (this.requests.size >= this.cacheEntryLimit) throw new AppError('REQUEST_LIMIT', 'Request cache is full; confirm pending operations before restarting');
      const result = this.enqueue(tool, input);
      this.requests.set(key, { hash, result: result.then(cacheResult) });
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
        config.connections.map(c => ({ connection_id: c.connection_id, name: c.name, base_url: c.base_url,
          client: c.client, language: c.language, username: c.username, write_enabled: c.write_enabled })) };
      const connection = config.connections.find(c => c.connection_id === input.connection_id);
      if (!connection) throw new AppError('CONNECTION_NOT_FOUND', 'Unknown connection ID');
      if (writes.has(tool) && !connection.write_enabled) throw new AppError('WRITE_DISABLED', 'Enable writes in local connection settings first');
      let backend = this.sessions.get(connection.connection_id);
      const cachedSession = Boolean(backend);
      if (!backend) {
        backend = this.factory(connection, await this.credentials.get(connection.connection_id));
        this.sessions.set(connection.connection_id, backend);
      }
      if (writes.has(tool) && this.poisoned.has(backend)) throw new AppError('SESSION_NEEDS_REVIEW', 'Previous lock cleanup failed; verify SAP locks before restarting the service');
      if (writes.has(tool)) {
        // Connection queues ensure no other operation is using the session during replacement.
        if (cachedSession) {
          this.sessions.delete(connection.connection_id);
          await backend.close().catch(() => {});
          backend = this.factory(connection, await this.credentials.get(connection.connection_id));
          this.sessions.set(connection.connection_id, backend);
        }
        ctx.steps.push('write_session_check_started');
        try {
          await backend.capabilities();
          ctx.steps.push('write_session_ready');
        } catch (error) {
          this.sessions.delete(connection.connection_id);
          await backend.close().catch(() => {});
          throw error;
        }
      }
      let data: unknown;
      try {
        data = await this.dispatch(tool, input, connection, backend, ctx);
      } catch (error) {
        // Retry only read operations, once, on a previously cached and unlocked session.
        if (writes.has(tool) || !cachedSession || this.poisoned.has(backend) ||
            !recoverableSessionErrors.has(safeError(error).code)) throw error;
        await backend.close().catch(() => {});
        this.sessions.delete(connection.connection_id);
        backend = this.factory(connection, await this.credentials.get(connection.connection_id));
        this.sessions.set(connection.connection_id, backend);
        ctx.steps.push('session_recreated');
        data = await this.dispatch(tool, input, connection, backend, ctx);
      }
      return { operation_id: id, status: 'success', completed_steps: ctx.steps, data, ...(ctx.source_save ? { source_save: ctx.source_save } : {}),
        ...(writes.has(tool) ? { outcome: 'confirmed', write_dispatched: ctx.dispatched } : {}), ...(ctx.warnings.length ? { warnings: ctx.warnings } : {}) };
    } catch (error) {
      const failure = safeError(error);
      const details = failure.details as Record<string, unknown> | undefined;
      if (tool === 'read_source' && input.version === 'inactive' && failure.code === 'VERSION_UNAVAILABLE') {
        failure.details = { ...details, requested_version: 'inactive', object_uri: input.object_uri,
          guidance: 'The requested inactive version is unavailable. This can be normal for an activated object; it does not by itself prove activation success. Explicitly read active to obtain its source and revision. Review that source before using its revision in update_source; do not blindly overwrite. No version fallback was performed.',
          next_action: { tool: 'read_source', arguments: { connection_id: input.connection_id,
            object_uri: input.object_uri, version: 'active' } } };
      }
      if (tool === 'update_source' && (input.object_uri ?? input.source_uri)?.includes('/fmodules/') &&
          details?.http_status === 400 && details.sap_error_type === 'ExceptionResourceScanDuringSaveFailure') {
        failure.details = { ...details, hints: [
          'Check the FUNCTION definition, not CALL FUNCTION syntax: EXCEPTIONS lists names only (e.g. INVALID_INPUT.), never name = 1.',
          'Use ADT parameter typing, e.g. TABLES T_RETURN TYPE BAPIRET2 OPTIONAL. End the definition with a period.',
          'Definition comments may be regenerated; do not use reserved implementation comment prefixes *" or *"---. These are possible causes, not a definitive diagnosis.',
          'Read inactive and active source before retrying with a new request_id; do not assume the backend is unchanged.'
        ] };
      }
      if (writes.has(tool)) {
        try { await this.audit.append({ operation_id: id, request_id: input.request_id, connection_id: input.connection_id,
          event: 'failed', completed_steps: ctx.steps, error_code: failure.code }); } catch { ctx.warnings.push('LOG_WRITE_FAILED'); }
      }
      return { operation_id: id, status: 'error', completed_steps: ctx.steps, error: failure, ...(ctx.source_save ? { source_save: ctx.source_save } : {}),
        ...(writes.has(tool) ? { outcome: ctx.confirmed ? 'partial' : ctx.dispatched ? 'unknown' : 'confirmed', write_dispatched: ctx.dispatched } : {}),
        ...(ctx.warnings.length ? { warnings: ctx.warnings } : {}) };
    }
  }
  private async requireTransport(b: Backend, object: string, pkg: string, operation: 'I' | 'U', transport?: string) {
    if (transport || pkg.toUpperCase() === '$TMP') return;
    const details = { object_uri: object, package_name: pkg, operation,
      guidance: 'Use list_transport_requests to select a modifiable task for the configured SAP user, or ask the user. No write has been dispatched; retry with a new request_id after review.' };
    if (!b.transportRequirement) throw new AppError('TRANSPORT_CHECK_UNAVAILABLE', 'Cannot determine whether SAP requires a transport task; provide an explicit task or verify CTS settings.', details);
    let requirement;
    try { requirement = await b.transportRequirement(object, pkg, operation); }
    catch (error) {
      throw new AppError('TRANSPORT_CHECK_UNAVAILABLE', 'SAP transport check failed; no write was sent. Provide an explicit task or verify CTS settings.', { ...details, cause: safeError(error) });
    }
    if (requirement === 'not_required') return;
    if (requirement === 'required') throw new AppError('TRANSPORT_REQUIRED', 'SAP requires a transport task for this operation; pass transport_task explicitly on this call.', details);
    throw new AppError('TRANSPORT_CHECK_UNAVAILABLE', 'SAP transport requirement is unknown; no write was sent.', details);
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
      case 'query_table': {
        const query = tableQuerySchema.parse({ table_name: p.table_name, fields: p.fields, filters: p.filters, limit: p.limit });
        if (!b.queryTable) throw new AppError('CAPABILITY_UNSUPPORTED', 'Table data preview is unavailable');
        return b.queryTable(query);
      }
      case 'query_sql': {
        const query = readOnlySql({ sql: p.sql!, limit: p.limit });
        if (!b.querySql) throw new AppError('CAPABILITY_UNSUPPORTED', 'SQL data preview is unavailable');
        return b.querySql(query);
      }
      case 'search_objects': return b.search(p.query!, p.type, p.limit ?? 100);
      case 'list_package_objects': return b.listPackage(p.package_name!, p.limit ?? 100);
      case 'read_source': return b.read(adtUri(p.object_uri!), p.version ?? 'active', p.source_uri);
      case 'syntax_check': return b.check(adtUri(p.object_uri!), p.version ?? 'inactive');
      case 'list_transport_requests': return b.transports();
      case 'create_transport_request': {
        if (!b.createTransportRequest || !b.verifyTransportRequest || !b.transportRequirement) {
          throw new AppError('CAPABILITY_UNSUPPORTED', 'Transport request creation or verification is unavailable');
        }
        const object = programUri(p.object_uri!);
        if (object !== p.object_uri) throw new AppError('INVALID_URI', 'Provide an object URI, not its source URI');
        if (p.package_name!.toUpperCase() === '$TMP') throw new AppError('TRANSPORT_NOT_REQUIRED', 'Temporary package $TMP does not need a development transport request');
        const requirement = await b.transportRequirement(object, p.package_name!, 'I');
        if (requirement === 'not_required') throw new AppError('TRANSPORT_NOT_REQUIRED', 'SAP reports no change recording requirement for this object and package');
        if (requirement !== 'required') throw new AppError('TRANSPORT_CHECK_UNAVAILABLE', 'Cannot determine the CTS requirement; no request was created');
        await ctx.event('started');
        ctx.dispatched = true;
        const number = await b.createTransportRequest(object, p.package_name!, p.description!);
        ctx.confirmed = true;
        const recovery = { created: true, transport_number: number,
          next_action: { tool: 'list_transport_requests', arguments: { connection_id: c.connection_id } },
          guidance: 'Creation was accepted. Query requests and tasks before retrying; do not create another request blindly. The returned number may be a request or a task.' };
        await ctx.event('created');
        let verified;
        try { verified = await b.verifyTransportRequest(number); }
        catch (error) { throw new AppError('TRANSPORT_VERIFY_FAILED', 'SAP accepted creation but request readback failed', { ...recovery, cause: safeError(error) }); }
        if (!verified) throw new AppError('TRANSPORT_VERIFY_FAILED', 'Created number was not found in the current user modifiable workbench requests', recovery);
        await ctx.event('verified');
        return { ...recovery, ...verified, released: false,
          guidance: 'Use a confirmed modifiable task belonging to the configured SAP user as transport_task. Do not confuse the parent request with a task. No request was released and no source was changed.' };
      }
      case 'list_function_group_members': {
        if (!b.listFunctionGroupMembers) throw new AppError('CAPABILITY_UNSUPPORTED', 'Function group browsing unavailable');
        return b.listFunctionGroupMembers(p.function_group_uri!, p.limit ?? 100);
      }
      case 'get_function_group': {
        if (!b.functionGroupSnapshot) throw new AppError('CAPABILITY_UNSUPPORTED', 'Function group snapshots unavailable');
        return b.functionGroupSnapshot(p.function_group_uri!);
      }
      case 'create_function_group': {
        if (!b.createFunctionGroup) throw new AppError('CAPABILITY_UNSUPPORTED', 'Function group creation unavailable');
        await this.requireTransport(b, `/sap/bc/adt/functions/groups/${encodeURIComponent(p.name!.toLowerCase())}`, p.package_name!, 'I', p.transport_task);
        await ctx.event('started'); ctx.dispatched = true;
        const uri = await b.createFunctionGroup(p.name!, p.description!, p.package_name!, p.transport_task);
        ctx.confirmed = true; await ctx.event('created');
        return { object_uri: uri, type: 'FUGR/F', activated: false,
          next_action: { tool: 'get_function_group', arguments: { connection_id: c.connection_id, function_group_uri: uri } } };
      }
      case 'create_function_module': {
        if (!b.createFunctionModule) throw new AppError('CAPABILITY_UNSUPPORTED', 'Function module creation unavailable');
        const group = functionGroupUri(p.function_group_uri!);
        if (group !== p.function_group_uri) throw new AppError('INVALID_URI', 'Specify the parent function group itself');
        await this.requireTransport(b, `${group}/fmodules/${encodeURIComponent(p.name!.toLowerCase())}`, await b.packageOf(group), 'I', p.transport_task);
        await ctx.event('started');
        return this.locked(b, group, ctx, async () => {
          ctx.dispatched = true;
          const uri = await b.createFunctionModule!(p.name!, p.description!, group, p.transport_task);
          ctx.confirmed = true; await ctx.event('created');
          return { object_uri: uri, function_group_uri: group, type: 'FUGR/FF', activated: false,
            interface_help: functionModuleGuidance(p.name!),
            next_action: { tool: 'read_source', arguments: { connection_id: c.connection_id, object_uri: uri, version: 'inactive' } } };
        });
      }
      case 'create_program': {
        await this.requireTransport(b, `/sap/bc/adt/programs/${p.program_kind === 'include' ? 'includes' : 'programs'}/${encodeURIComponent(p.name!.toLowerCase())}`, p.package_name!, 'I', p.transport_task);
        await ctx.event('started');
        ctx.dispatched = true;
        const uri = await b.create(p.name!, p.description!, p.package_name!, p.transport_task, p.program_kind ?? 'report');
        ctx.confirmed = true;
        await ctx.event('created');
        return { object_uri: uri, program_kind: p.program_kind ?? 'report', activated: false,
          next_action: { tool: 'read_source', arguments: { connection_id: c.connection_id, object_uri: uri, version: 'inactive' } } };
      }
      case 'update_source': {
        if (!p.object_uri && !p.source_uri) throw new AppError('INVALID_URI', 'Provide object_uri or the source_uri returned by read_source');
        const object = programUri(p.object_uri ?? p.source_uri!);
        if (p.object_uri && object !== p.object_uri) throw new AppError('INVALID_URI', 'object_uri must identify the object, not its source');
        if (p.source_uri && programUri(p.source_uri) !== object) throw new AppError('INVALID_URI', 'object_uri and source_uri identify different objects');
        const saveState: SourceSaveState = { saved: false, verification: 'not_run', object_uri: object, ...(p.source_uri ? { source_uri: p.source_uri } : {}) };
        ctx.source_save = saveState;
        if (isFunctionGroup(object)) throw new AppError('CAPABILITY_UNSUPPORTED', 'Edit a function module or group Include, not the function group container');
        await this.requireTransport(b, object, await b.packageOf(object), 'U', p.transport_task);
        await ctx.event('started');
        return this.locked(b, object, ctx, async handle => {
          ctx.steps.push('locked');
          // Revisions from either version are accepted, but that exact version is re-read under lock.
          const active = await b.read(object, 'active').catch(error => {
            if (safeError(error).code === 'OBJECT_NOT_FOUND' || safeError(error).code === 'VERSION_UNAVAILABLE') return undefined;
            throw error;
          });
          let current = active;
          if (!active || active.revision !== p.expected_revision) current = await b.read(object, 'inactive').catch(error => {
            if (['OBJECT_NOT_FOUND', 'VERSION_UNAVAILABLE'].includes(safeError(error).code)) return undefined;
            throw error;
          });
          const conflict = (reason: string, latest = current) => new AppError('VERSION_CONFLICT', reason, {
            object_uri: object, ...(active ? { active_revision: active.revision } : {}),
            ...(latest?.version === 'inactive' ? { inactive_revision: latest.revision } : {}),
            next_action: { tool: 'read_source', arguments: { connection_id: c.connection_id, object_uri: object, version: latest?.version ?? active?.version ?? 'inactive' } },
            guidance: 'Read and review current source before using its revision. Do not blindly overwrite or automatically retry.'
          });
          if (!current || current.revision !== p.expected_revision) throw conflict('Source changed; read it again');
          if (p.source_uri && current.source_uri !== p.source_uri) throw new AppError('INVALID_URI', 'Source is not the discovered main source');
          saveState.source_uri = current.source_uri;
          // An inactive draft must not be silently overwritten from an active revision.
          if (current.version === 'active') {
            const draft = await b.read(object, 'inactive').catch(error => {
              if (['OBJECT_NOT_FOUND', 'VERSION_UNAVAILABLE'].includes(safeError(error).code)) return undefined;
              throw error;
            });
            if (draft && draft.hash !== current.hash) throw conflict('An inactive draft exists; read inactive before editing', draft);
          }
          await ctx.event('version_checked');
          ctx.dispatched = true;
          saveState.saved = 'unknown';
          saveState.next_action = 'Read inactive and active source to establish backend state before any new write; do not blindly retry.';
          await b.save(current.source_uri, p.source!, handle, p.transport_task);
          ctx.confirmed = true;
          saveState.saved = true;
          saveState.verification = 'pending';
          await ctx.event('saved');
          let saved;
          try { saved = await b.read(object, 'inactive'); }
          catch (error) { saveState.verification = 'unavailable'; throw error; }
          saveState.inactive_revision = saved.revision;
          const comparison = compareSavedSource(p.source!, saved.source, object);
          saveState.normalization_applied = comparison.normalization_applied;
          ctx.warnings.push(...comparison.warnings);
          if (!comparison.equivalent) {
            saveState.verification = 'failed';
            saveState.difference = comparison.difference;
            throw new AppError('VERIFY_FAILED', 'SAP accepted the save, but inactive source differs from the submitted source. Read inactive before editing or activating.', { difference: comparison.difference });
          }
          saveState.verification = 'passed';
          delete saveState.next_action;
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
          if (isFunctionGroup(uri)) {
            if (!b.functionGroupSnapshot) throw new AppError('CAPABILITY_UNSUPPORTED', 'Function group snapshots unavailable');
            const snapshot = await this.locked(b, uri, ctx, async () => {
              const snapshot = await b.functionGroupSnapshot!(uri);
              if (snapshot.revision !== o.expected_revision) throw new AppError('VERSION_CONFLICT', 'Function group members changed');
              return snapshot;
            });
            if (this.poisoned.has(b)) throw new AppError('LOCK_CLEANUP_FAILED', 'Group editor lock was not released');
            if ((await b.functionGroupSnapshot(uri)).revision !== snapshot.revision) throw new AppError('VERSION_CONFLICT', 'Function group changed after unlocking');
            await ctx.event('activation_version_checked'); ctx.dispatched = true; ctx.confirmed = false;
            const activated = await b.activate(uri, snapshot); ctx.confirmed = true;
            await ctx.event(activated.success ? 'activated' : 'activation_failed');
            results.push({ object_uri: uri, ...activated });
            if (!activated.success) throw new AppError('ACTIVATION_FAILED', 'Function group activation failed', { results });
            for (const member of snapshot.members) {
              const active = await b.read(member.object_uri, 'active');
              if (savedSourceHash(active.source, member.object_uri) !== member.hash) throw new AppError('VERIFY_FAILED', 'Function group member differs after activation', { object_uri: member.object_uri });
              if (member.definition_comments_hash && definitionCommentsHash(active.source, member.object_uri) !== member.definition_comments_hash) {
                ctx.warnings.push('FUNCTION_DEFINITION_COMMENTS_CHANGED');
              }
            }
            await ctx.event('activation_verified');
            continue;
          }
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
              const comparison = compareSavedSource(source.source, active.source, uri);
              ctx.warnings.push(...comparison.warnings);
              if (!comparison.equivalent) throw new AppError('VERIFY_FAILED', 'Active source differs after activation', { difference: comparison.difference });
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
