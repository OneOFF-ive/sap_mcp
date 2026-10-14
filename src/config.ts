import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

export const connectionSchema = z.object({
  connection_id: z.string().uuid(), name: z.string().regex(/^[a-zA-Z0-9_-]+$/),
  base_url: z.string().transform(normalizeUrl), client: z.string().regex(/^\d{3}$/),
  username: z.string().min(1), language: z.string().regex(/^[A-Z]{2}$/),
  write_enabled: z.boolean().default(false), allowed_packages: z.array(z.string().regex(/^[A-Z0-9_$/]+$/).max(128)).default([])
}).strict().refine(c => !c.write_enabled || c.allowed_packages.length > 0, 'Writing requires allowed packages');
export type Connection = z.infer<typeof connectionSchema>;
const configSchema = z.object({ schema_version: z.literal(1), connections: z.array(connectionSchema),
  tokens: z.array(z.object({ id: z.string(), hash: z.string(), created_at: z.string() })) });
export type Config = z.infer<typeof configSchema>;
export function normalizeUrl(value: string): string {
  const u = new URL(value);
  if (u.protocol !== 'http:' || u.username || u.password || u.search || u.hash ||
      !['/', '/sap/bc/adt', '/sap/bc/adt/'].includes(u.pathname)) {
    throw new Error('Use an HTTP server URL without credentials, query or custom path');
  }
  return u.origin;
}
export const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export class ConfigStore {
  constructor(public directory = process.env.SAP_MCP_CONFIG_DIR ?? join(process.env.APPDATA ?? homedir(), 'sap-mcp')) {}
  async load(): Promise<Config> {
    try { return configSchema.parse(JSON.parse(await readFile(join(this.directory, 'config.json'), 'utf8'))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { schema_version: 1, connections: [], tokens: [] }; throw error; }
  }
  async save(config: Config) {
    configSchema.parse(config);
    await mkdir(this.directory, { recursive: true });
    const temp = join(this.directory, `${randomUUID()}.tmp`);
    await writeFile(temp, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
    await rename(temp, join(this.directory, 'config.json'));
  }
  async createToken() {
    const config = await this.load();
    const token = randomBytes(32).toString('base64url');
    const id = randomUUID();
    config.tokens.push({ id, hash: digest(token), created_at: new Date().toISOString() });
    await this.save(config);
    return { id, token };
  }
  async authenticate(token: string) {
    const hash = Buffer.from(digest(token), 'hex');
    return (await this.load()).tokens.some(t => {
      const expected = Buffer.from(t.hash, 'hex');
      return expected.length === hash.length && timingSafeEqual(expected, hash);
    });
  }
}

export interface Credentials { get(id: string): Promise<string>; set(id: string, password: string): Promise<void>; remove(id: string): Promise<void> }
export class WindowsCredentials implements Credentials {
  private async entry(id: string) {
    if (process.platform !== 'win32') throw new Error('Windows Credential Manager is required');
    const { Entry } = await import('@napi-rs/keyring');
    return new Entry('sap-mcp', id);
  }
  async get(id: string) { const password = (await this.entry(id)).getPassword(); if (!password) throw new Error('SAP credential is missing'); return password; }
  async set(id: string, password: string) { (await this.entry(id)).setPassword(password); }
  async remove(id: string) { (await this.entry(id)).deletePassword(); }
}
