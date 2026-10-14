import { ADTClient, session_types, type HttpClient } from 'abap-adt-api';
import { HttpClientException, type HttpClientOptions } from 'abap-adt-api/build/AdtHTTP.js';
import axios from 'axios';
import type { Connection } from './config.js';
import { digest } from './config.js';
import { AppError } from './errors.js';

export type Version = 'active' | 'inactive';
export function adtUri(uri: string): string {
  if (!uri.startsWith('/sap/bc/adt/') || /[?#\\\s]/.test(uri)) throw new AppError('INVALID_URI', 'Use an ADT relative object URI');
  let decoded: string;
  try { decoded = decodeURIComponent(uri); } catch { throw new AppError('INVALID_URI', 'Invalid URI encoding'); }
  if (decoded.includes('%') || decoded.includes('\\') || /[?#\x00-\x20]/.test(decoded) || decoded.split('/').some(s => s === '.' || s === '..')) {
    throw new AppError('INVALID_URI', 'Unsafe ADT URI');
  }
  return uri;
}
export function programUri(uri: string): string {
  adtUri(uri);
  if (!/^\/sap\/bc\/adt\/programs\/programs\/[a-zA-Z0-9_%]+(?:\/source\/main)?$/.test(uri)) {
    throw new AppError('CAPABILITY_UNSUPPORTED', 'First release writes REPORT program main sources only');
  }
  return uri.replace(/\/source\/main$/, '');
}
export type Source = { object_uri: string; source_uri: string; source: string; version: Version; revision: string; hash: string };
export function sourceResult(connectionId: string, object: string, uri: string, source: string, version: Version): Source {
  const hash = digest(source);
  return { object_uri: object, source_uri: uri, source, version, hash,
    revision: digest(JSON.stringify([connectionId, uri, version, hash])) };
}
export interface Backend {
  capabilities(): Promise<unknown>;
  search(query: string, type: string | undefined, limit: number): Promise<unknown>;
  listPackage(name: string, limit: number): Promise<unknown>;
  read(object: string, version: Version, source?: string): Promise<Source>;
  packageOf(object: string): Promise<string>;
  lock(object: string): Promise<string>;
  unlock(object: string, handle: string): Promise<void>;
  save(source: string, code: string, handle: string, transport?: string): Promise<void>;
  create(name: string, description: string, pkg: string, transport?: string): Promise<string>;
  check(object: string, version: Version): Promise<unknown>;
  activate(object: string): Promise<{ success: boolean; messages: unknown[] }>;
  transports(): Promise<unknown>;
  close(): Promise<void>;
}

// Use a bounded client that never redirects authentication to another server.
class BoundedHttp implements HttpClient {
  constructor(private base: string) {}
  async request(o: HttpClientOptions) {
    const url = new URL(o.url, this.base);
    if (url.origin !== this.base) throw new AppError('INVALID_URI', 'Cross-origin backend request rejected');
    try {
    const r = await axios.request<string>({ url: url.href, method: o.method ?? 'GET', headers: o.headers,
      params: o.qs, auth: o.auth, data: o.body, timeout: 15000, maxRedirects: 0,
      maxContentLength: 4 * 1024 * 1024, maxBodyLength: 2 * 1024 * 1024, responseType: 'text', proxy: false,
      validateStatus: () => true });
    if (r.status >= 300) throw new HttpClientException('Backend HTTP request failed', undefined, r.status, undefined, o);
    return { body: r.data, status: r.status, statusText: r.statusText, headers: r.headers as Record<string, string> };
    } catch (error) {
      if (error instanceof HttpClientException) throw error;
      throw new HttpClientException('Backend network request failed', axios.isAxiosError(error) ? error.code : undefined,
        undefined, undefined, o);
    }
  }
}
export class AdtBackend implements Backend {
  private client: ADTClient;
  constructor(private connection: Connection, password: string) {
    this.client = new ADTClient(new BoundedHttp(connection.base_url), connection.username, password, connection.client, connection.language);
    this.client.stateful = session_types.stateful;
  }
  async capabilities() {
    const discovery = await this.client.adtDiscovery();
    if (!discovery.length) throw new AppError('ADT_UNAVAILABLE', 'Backend did not return a usable ADT discovery document');
    return { discovery, probed_at: new Date().toISOString(),
      limitations: ['Writes are limited to REPORT main sources', 'Source revision checks use hashes under SAP object locks'] };
  }
  async search(query: string, type: string | undefined, limit: number) {
    const rows = await this.client.searchObject(query, type, limit + 1);
    return { objects: rows.slice(0, limit).map(r => ({ name: r['adtcore:name'], type: r['adtcore:type'],
      package_name: r['adtcore:packageName'], object_uri: adtUri(r['adtcore:uri']), description: r['adtcore:description'] })), truncated: rows.length > limit };
  }
  async listPackage(name: string, limit: number) {
    const result = await this.client.nodeContents('DEVC/K', name);
    return { objects: result.nodes.slice(0, limit), truncated: result.nodes.length > limit,
      pagination_supported: false };
  }
  async read(object: string, version: Version, requestedSource?: string) {
    adtUri(object);
    const metadata = await this.client.objectStructure(object, version);
    if (metadata.metaData['adtcore:version'] !== version) throw new AppError('VERSION_UNAVAILABLE', 'Backend did not return the requested version');
    const sourceUri = adtUri(ADTClient.mainInclude(metadata, false));
    if (sourceUri === object) throw new AppError('CAPABILITY_UNSUPPORTED', 'Object does not expose a main source');
    if (requestedSource && adtUri(requestedSource) !== sourceUri) throw new AppError('INVALID_URI', 'Only the discovered main source is supported');
    return sourceResult(this.connection.connection_id, object, sourceUri, await this.client.getObjectSource(sourceUri, { version }), version);
  }
  async packageOf(object: string) {
    const metadata = await this.client.objectStructure(programUri(object));
    if (!('program:programType' in metadata.metaData) || metadata.metaData['program:programType'] !== 'executableProgram') {
      throw new AppError('CAPABILITY_UNSUPPORTED', 'Only executable REPORT programs are writable');
    }
    const path = await this.client.findObjectPath(adtUri(object));
    const pkg = [...path].reverse().find(p => p['adtcore:type'] === 'DEVC/K');
    if (!pkg) throw new AppError('PACKAGE_UNKNOWN', 'Cannot verify the owning package');
    return pkg['adtcore:name'];
  }
  async lock(object: string) { return (await this.client.lock(programUri(object))).LOCK_HANDLE; }
  async unlock(object: string, handle: string) { await this.client.unLock(programUri(object), handle); }
  async save(source: string, code: string, handle: string, transport?: string) {
    programUri(source); await this.client.setObjectSource(source, code, handle, transport);
  }
  async create(name: string, description: string, pkg: string, transport?: string) {
    const validation = await this.client.validateNewObject({ objtype: 'PROG/P', objname: name, description, packagename: pkg });
    if (!validation.success) throw new AppError('CREATE_VALIDATION_FAILED', 'Backend rejected program creation', validation);
    await this.client.createObject({ objtype: 'PROG/P', name, description, parentName: pkg,
      parentPath: `/sap/bc/adt/packages/${encodeURIComponent(pkg.toLowerCase())}`, responsible: this.connection.username,
      language: this.connection.language, transport });
    const matches = await this.client.searchObject(name, 'PROG/P', 20);
    const row = matches.find(r => r['adtcore:name'].toUpperCase() === name.toUpperCase());
    if (!row) throw new AppError('OUTCOME_UNKNOWN', 'Program creation returned success but its URI could not be resolved');
    const uri = adtUri(row['adtcore:uri']);
    const metadata = await this.client.objectStructure(uri, 'inactive');
    if (!('program:programType' in metadata.metaData) || metadata.metaData['program:programType'] !== 'executableProgram') {
      throw new AppError('CAPABILITY_UNSUPPORTED', 'Created object must be verified as an executable REPORT', { object_uri: uri });
    }
    return uri;
  }
  async check(object: string, version: Version) {
    const source = await this.read(object, version);
    const diagnostics = await this.client.syntaxCheck(object, source.source_uri, source.source, undefined, version);
    return { passed: !diagnostics.some(d => ['E', 'A', 'X', 'error'].includes(d.severity)), diagnostics,
      position_format: 'backend-native; line and offset require real-system verification' };
  }
  async activate(object: string) {
    const metadata = await this.client.objectStructure(programUri(object), 'inactive');
    return this.client.activate(metadata.metaData['adtcore:name'], object);
  }
  async transports() { return this.client.userTransports(this.connection.username); }
  async close() { if (this.client.loggedin) await this.client.logout(); }
}
