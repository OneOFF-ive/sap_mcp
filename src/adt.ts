import { ADTClient, session_types, type HttpClient } from 'abap-adt-api';
import { HttpClientException, type HttpClientOptions } from 'abap-adt-api/build/AdtHTTP.js';
import axios from 'axios';
import { XMLBuilder } from 'fast-xml-parser';
import type { Connection } from './config.js';
import { digest } from './config.js';
import { AppError } from './errors.js';

export type Version = 'active' | 'inactive';
export type ProgramKind = 'report' | 'include' | 'module_pool' | 'subroutine_pool';
const programTypes = { report: 'executableProgram', module_pool: 'modulePool', subroutine_pool: 'subroutinePool' } as const;
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
  if (!/^\/sap\/bc\/adt\/programs\/(?:programs|includes)\/[a-zA-Z0-9_%]+(?:\/source\/main)?$/.test(uri)) {
    throw new AppError('CAPABILITY_UNSUPPORTED', 'Writes support Program and Include main sources only');
  }
  return uri.replace(/\/source\/main$/, '');
}
export type Source = { object_uri: string; source_uri: string; source: string; version: Version; revision: string; hash: string };
export function sameSavedSource(left: string, right: string): boolean {
  // SAP may remove final line breaks; preserve every other character for verification.
  const withoutFinalLineBreaks = (source: string) => source.replace(/[\r\n]+$/, '');
  return withoutFinalLineBreaks(left) === withoutFinalLineBreaks(right);
}
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
  create(name: string, description: string, pkg: string, transport?: string, kind?: ProgramKind): Promise<string>;
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
    if (r.status >= 300) throw new HttpClientException('Backend HTTP request failed', undefined, r.status, undefined, o,
      { body: r.data, status: r.status, statusText: r.statusText, headers: {} });
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
      limitations: ['Creation and writes support Programs and Includes; backend permissions and type support apply', 'Source revision checks use hashes under SAP object locks'] };
  }
  async search(query: string, type: string | undefined, limit: number) {
    const requestedType = type?.toUpperCase();
    // The ADT library sends only the type family (PROG), so enforce subtypes locally.
    const fetchLimit = requestedType?.includes('/') ? 501 : limit + 1;
    const rows = await this.client.searchObject(query, requestedType, fetchLimit);
    const matches = rows.filter(r => !requestedType || (requestedType.includes('/')
      ? r['adtcore:type'].toUpperCase() === requestedType
      : r['adtcore:type'].split('/')[0].toUpperCase() === requestedType));
    return { objects: matches.slice(0, limit).map(r => ({ name: r['adtcore:name'], type: r['adtcore:type'],
      package_name: r['adtcore:packageName'], object_uri: adtUri(r['adtcore:uri']), description: r['adtcore:description'] })),
      truncated: matches.length > limit || rows.length >= fetchLimit };
  }
  async listPackage(name: string, limit: number) {
    const result = await this.client.nodeContents('DEVC/K', name);
    const objects = result.nodes.filter(node => typeof node.OBJECT_URI === 'string' && node.OBJECT_URI.trim().length > 0);
    return { objects: objects.slice(0, limit), truncated: objects.length > limit,
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
    const objectUri = programUri(object);
    const metadata = await this.client.objectStructure(objectUri);
    const expectedType = objectUri.startsWith('/sap/bc/adt/programs/includes/') ? 'PROG/I' : 'PROG/P';
    if (metadata.metaData['adtcore:type'] !== expectedType) {
      throw new AppError('CAPABILITY_UNSUPPORTED', 'Object metadata does not match its Program or Include URI');
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
  async create(name: string, description: string, pkg: string, transport?: string, kind: ProgramKind = 'report') {
    const include = kind === 'include';
    const objectType = include ? 'PROG/I' : 'PROG/P';
    const collection = include ? 'includes' : 'programs';
    const prefix = include ? 'include' : 'program';
    const validation = await this.client.validateNewObject({ objtype: objectType, objname: name, description, packagename: pkg });
    if (!validation.success) throw new AppError('CREATE_VALIDATION_FAILED', 'Backend rejected program creation', validation);
    const root = `${prefix}:${include ? 'abapInclude' : 'abapProgram'}`;
    const body = new XMLBuilder({ ignoreAttributes: false }).build({ [root]: {
      [`@_xmlns:${prefix}`]: `http://www.sap.com/adt/programs/${collection}`,
      '@_xmlns:adtcore': 'http://www.sap.com/adt/core', '@_adtcore:name': name,
      '@_adtcore:type': objectType, '@_adtcore:description': description,
      '@_adtcore:responsible': this.connection.username, '@_adtcore:language': this.connection.language,
      '@_adtcore:masterLanguage': this.connection.language,
      ...(!include ? { '@_program:programType': programTypes[kind] } : {}),
      'adtcore:packageRef': { '@_adtcore:name': pkg }
    } });
    const uri = `/sap/bc/adt/programs/${collection}/${encodeURIComponent(name.toLowerCase())}`;
    await this.client.httpClient.request(`/sap/bc/adt/programs/${collection}`, {
      method: 'POST', headers: { 'Content-Type': 'application/*' }, body,
      ...(transport ? { qs: { corrNr: transport } } : {})
    });
    const metadata = await this.client.objectStructure(uri, 'inactive');
    if (metadata.metaData['adtcore:type'] !== objectType || (!include &&
        (!('program:programType' in metadata.metaData) || metadata.metaData['program:programType'] !== programTypes[kind]))) {
      throw new AppError('VERIFY_FAILED', 'Created object does not match the requested type', { object_uri: uri, program_kind: kind });
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
