#!/usr/bin/env node
import { Command } from 'commander';
import { input, password, confirm } from '@inquirer/prompts';
import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { ConfigStore, WindowsCredentials, connectionSchema, type Connection } from './config.js';
import { AdtBackend } from './adt.js';
import { Operations } from './operations.js';
import { startHttp } from './server.js';
import { safeError } from './errors.js';

const store = new ConfigStore();
const credentials = new WindowsCredentials();
async function lease(filename = 'runtime.lock') {
  await mkdir(store.directory, { recursive: true });
  const path = join(store.directory, filename);
  try { const pid = Number(await readFile(path, 'utf8'));
    try { process.kill(pid, 0); throw new Error('Service or another configuration command is running'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
    await unlink(path);
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const file = await open(path, 'wx');
  await file.writeFile(String(process.pid)); await file.close();
  return () => unlink(path);
}
async function mutate(action: () => Promise<void>, connectionChange = true) {
  const releaseRuntime = connectionChange ? await lease() : undefined;
  let releaseConfig: (() => Promise<void>) | undefined;
  try { releaseConfig = await lease('config.lock'); await action(); }
  finally { await releaseConfig?.(); await releaseRuntime?.(); }
}
async function promptConnection(name: string, old?: Connection) {
  const base_url = await input({ message: 'ADT HTTP server URL:', default: old?.base_url });
  const client = await input({ message: 'Client (three digits):', default: old?.client ?? '100' });
  const username = await input({ message: 'SAP username:', default: old?.username });
  const language = await input({ message: 'Language:', default: old?.language ?? 'EN' });
  const write_enabled = await confirm({ message: 'Enable program writes?', default: old?.write_enabled ?? false });
  return connectionSchema.parse({ connection_id: old?.connection_id ?? randomUUID(), name,
    base_url, client, username, language: language.toUpperCase(), write_enabled });
}
const cli = new Command().name('sap-mcp').description('Standalone SAP HTTP ADT MCP server').version('0.1.0');
const connections = cli.command('connection').description('Manage SAP connections');
connections.command('list').action(async () => {
  const config = await store.load(); console.table(config.connections.map(({ connection_id, name, base_url, client, username, write_enabled }) =>
    ({ connection_id, name, base_url, client, username, write_enabled })));
});
connections.command('add <name>').action(name => mutate(async () => {
  const config = await store.load();
  if (config.connections.some(c => c.name === name)) throw new Error('Connection name already exists');
  const connection = await promptConnection(name);
  const secret = await password({ message: 'SAP password:', mask: '*' });
  if (!secret) throw new Error('Password cannot be empty');
  await credentials.set(connection.connection_id, secret);
  config.connections.push(connection);
  try { await store.save(config); } catch (error) { await credentials.remove(connection.connection_id); throw error; }
  console.log(`Added ${name}: ${connection.connection_id}`);
}));
connections.command('edit <name>').action(name => mutate(async () => {
  const config = await store.load(); const index = config.connections.findIndex(c => c.name === name);
  if (index < 0) throw new Error('Connection not found');
  const old = config.connections[index]; const updated = await promptConnection(name, old);
  const changePassword = await confirm({ message: 'Replace stored password?', default: updated.username !== old.username || updated.base_url !== old.base_url || updated.client !== old.client });
  let previousPassword: string | undefined;
  if (changePassword) { const secret = await password({ message: 'SAP password:', mask: '*' });
    previousPassword = await credentials.get(old.connection_id);
    if (!secret) throw new Error('Password cannot be empty'); await credentials.set(old.connection_id, secret); }
  config.connections[index] = updated;
  try { await store.save(config); } catch (error) { if (previousPassword) await credentials.set(old.connection_id, previousPassword); throw error; }
  console.log(`Updated ${name}`);
}));
connections.command('remove <name>').action(name => mutate(async () => {
  const config = await store.load(); const connection = config.connections.find(c => c.name === name);
  if (!connection) throw new Error('Connection not found');
  if (!(await confirm({ message: `Remove ${name} and its credential?`, default: false }))) return;
  const previousPassword = await credentials.get(connection.connection_id);
  await credentials.remove(connection.connection_id);
  config.connections = config.connections.filter(c => c !== connection);
  try { await store.save(config); } catch (error) { await credentials.set(connection.connection_id, previousPassword); throw error; }
}));
connections.command('test <name>').action(async name => {
  const c = (await store.load()).connections.find(c => c.name === name);
  if (!c) throw new Error('Connection not found');
  const backend = new AdtBackend(c, await credentials.get(c.connection_id));
  try { console.log(JSON.stringify(await backend.capabilities(), null, 2)); }
  finally { await backend.close().catch(() => {}); }
});
const token = cli.command('token').description('Manage local MCP access tokens');
token.command('create').action(() => mutate(async () => { console.log(JSON.stringify(await store.createToken(), null, 2)); }, false));
token.command('revoke <id>').action(id => mutate(async () => {
  const config = await store.load(); if (!config.tokens.some(t => t.id === id)) throw new Error('Token not found');
  config.tokens = config.tokens.filter(t => t.id !== id); await store.save(config); console.log('Token revoked');
}, false));
cli.command('serve').option('--port <port>', 'Local port', '8765').action(async options => {
  const port = Number(options.port); if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid port');
  if (!(await store.load()).tokens.length) throw new Error('Create a token before starting the service');
  const release = await lease();
  try {
    const runtime = await startHttp(store, new Operations(store, credentials), port);
    console.log(`SAP MCP listening at http://127.0.0.1:${port}/mcp`);
    let closing = false;
    const stop = async () => { if (closing) return; closing = true;
      try { await runtime.close(); } finally { await release(); } };
    process.once('SIGINT', () => { void stop(); }); process.once('SIGTERM', () => { void stop(); });
  } catch (error) { await release(); throw error; }
});
try { await cli.parseAsync(); }
catch (error) {
  // CLI validation errors do not carry HTTP responses or credentials.
  const message = error instanceof Error && !('response' in error) && !('request' in error) ? error.message : safeError(error).message;
  console.error(message); process.exitCode = 1;
}
