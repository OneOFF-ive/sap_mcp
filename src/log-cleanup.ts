import { lstat, readdir, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { defaultLogDirectory } from './audit.js';
import { AppError } from './errors.js';

export function retentionDays(value: unknown): number {
  const days = Number(value);
  if (!['number', 'string'].includes(typeof value) || !Number.isInteger(days) || days < 0 || days > 36500 || (typeof value === 'string' && value.trim() === ''))
    throw new AppError('INVALID_INPUT', '日志保留天数必须是 0～36500 的整数；0 表示清理今天以前的日志，当天日志始终保留。');
  return days;
}

// Match only this application's daily audit files. Never traverse directories,
// follow symbolic links, or truncate the current UTC day's append-only log.
export async function cleanupLogs(days = 30, confirm = false, directory = defaultLogDirectory(), now = new Date()) {
  days = retentionDays(days);
  const root = resolve(directory);
  const today = now.toISOString().slice(0, 10);
  const cutoff = Date.parse(`${today}T00:00:00.000Z`) - days * 86400000;
  const result = { directory: root, older_than_days: days, dry_run: !confirm,
    eligible_files: 0, eligible_bytes: 0, deleted_files: 0, deleted_bytes: 0, failed_files: 0 };
  try {
    const info = await lstat(root);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new AppError('LOG_DIRECTORY_UNSAFE', '日志目录必须是普通目录，不能通过符号链接或目录联接清理。');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return result;
    throw error;
  }
  for (const name of await readdir(root)) {
    const match = /^operations-(\d{4}-\d{2}-\d{2})-(0|[1-9]\d*)\.jsonl$/.exec(name);
    if (!match || match[1] >= today) continue;
    const date = Date.parse(`${match[1]}T00:00:00.000Z`);
    if (!Number.isFinite(date) || new Date(date).toISOString().slice(0, 10) !== match[1] || date >= cutoff) continue;
    const file = join(root, name);
    try {
      const info = await lstat(file);
      // Recently modified, backdated files may still be in use; preserve them.
      if (!info.isFile() || info.isSymbolicLink() || info.mtimeMs >= cutoff) continue;
      result.eligible_files++; result.eligible_bytes += info.size;
      if (confirm) { await unlink(file); result.deleted_files++; result.deleted_bytes += info.size; }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') result.failed_files++;
    }
  }
  return result;
}
