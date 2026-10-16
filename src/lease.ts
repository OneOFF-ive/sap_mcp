import { access, mkdir, open, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { AppError } from './errors.js';

const execute = promisify(execFile);
async function guarded<T>(path: string, action: () => Promise<T>): Promise<T> {
  const guardPath = `${path}.guard`;
  let guard;
  try { guard = await open(guardPath, 'wx', 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new AppError('LEASE_BUSY', `Lease guard is busy: ${guardPath}. 请等待其他命令结束后重试；若进程曾崩溃，须先关闭并核实所有 SapLink 进程，再人工删除此门锁文件 (manually remove)。门锁不会自动回收。`);
    }
    throw error;
  }
  try { return await action(); }
  finally {
    try { await guard.close(); } finally { await unlink(guardPath); }
  }
}
export type LeaseOwner = { started_at: string; command_line: string };
type Inspector = (pid: number) => Promise<LeaseOwner | null>;

export type LeaseStatus = {
  state: 'missing' | 'running' | 'stale' | 'unknown';
  guard_present: boolean;
  pid?: number;
  nonce?: string;
};

// Read-only inspection: diagnostics must never reclaim locks or orphan guards.
export async function inspectLease(directory: string, filename = 'runtime.lock', inspect: Inspector = inspectOwner): Promise<LeaseStatus> {
  const path = join(directory, filename);
  const guardPresent = await access(`${path}.guard`).then(() => true, () => false);
  try {
    const record = JSON.parse(await readFile(path, 'utf8')) as number | { pid: number; started_at: string; nonce?: string };
    const pid = typeof record === 'number' ? record : record.pid;
    if (!Number.isInteger(pid) || pid <= 0) return { state: 'unknown', guard_present: guardPresent };
    const owner = await inspect(pid);
    const sameProcess = owner && (typeof record === 'number'
      ? process.platform !== 'win32' || /(?:saplink[\\/]dist[\\/]cli\.js|\bdist[\\/]cli\.js)(?:["\s]|$)/i.test(owner.command_line)
      : record.started_at === owner.started_at);
    return { state: sameProcess ? 'running' : 'stale', guard_present: guardPresent, pid,
      ...(typeof record !== 'number' && record.nonce ? { nonce: record.nonce } : {}) };
  } catch (error) {
    return { state: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unknown', guard_present: guardPresent };
  }
}

async function inspectOwner(pid: number): Promise<LeaseOwner | null> {
  if (process.platform !== 'win32') {
    try { process.kill(pid, 0); return { started_at: 'unknown', command_line: 'unknown' }; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return null; throw error; }
  }
  const { stdout } = await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `$ErrorActionPreference='Stop'; $p=Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}'; if($p){ @{started_at=$p.CreationDate.ToUniversalTime().ToString('o'); command_line=$p.CommandLine} | ConvertTo-Json -Compress }`],
    { windowsHide: true, timeout: 10000, cwd: process.env.SystemRoot ?? 'C:\\Windows' });
  return stdout.trim() ? JSON.parse(stdout) as LeaseOwner : null;
}

export async function acquireLease(directory: string, filename: string, inspect: Inspector = inspectOwner) {
  await mkdir(directory, { recursive: true });
  const path = join(directory, filename);
  return guarded(path, () => acquireRecord(path, inspect));
}

async function acquireRecord(path: string, inspect: Inspector) {
  try {
    const raw = await readFile(path, 'utf8');
    const record = JSON.parse(raw) as number | { pid: number; started_at: string };
    const pid = typeof record === 'number' ? record : record.pid;
    if (!Number.isInteger(pid) || pid <= 0) throw new Error('Invalid lock file');
    const owner = await inspect(pid);
    const sameProcess = owner && (typeof record === 'number'
      ? process.platform !== 'win32' || /(?:saplink[\\/]dist[\\/]cli\.js|\bdist[\\/]cli\.js)(?:["\s]|$)/i.test(owner.command_line)
      : record.started_at === owner.started_at);
    if (sameProcess) throw new AppError('SERVICE_RUNNING', `SapLink service or configuration command is running (PID ${pid}). Close it before starting another instance.`);
    await unlink(path);
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const owner = await inspect(process.pid);
  if (!owner) throw new Error('Cannot identify the current process for the runtime lock');
  const record = JSON.stringify({ pid: process.pid, started_at: owner.started_at, nonce: randomUUID() });
  const file = await open(path, 'wx');
  try { await file.writeFile(record); } finally { await file.close(); }
  return async () => {
    await guarded(path, async () => {
      try { if (await readFile(path, 'utf8') === record) await unlink(path); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    });
  };
}
