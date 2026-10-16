import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, utimes, readFile, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { cleanupLogs, retentionDays } from '../src/log-cleanup.js';
import { AppError } from '../src/errors.js';

const now = new Date('2026-10-16T12:00:00Z');
test('log cleanup previews first and deletes only expired owned logs, preserving today and recent changes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'saplink-log-cleanup-'));
  try {
    const files = ['operations-2026-09-15-0.jsonl', 'operations-2026-09-16-0.jsonl',
      'operations-2026-10-16-0.jsonl', 'operations-2026-02-30-0.jsonl', 'config.json', 'operations-2026-01-01-0.jsonl'];
    for (const name of files) {
      await writeFile(join(root, name), 'test data');
      await utimes(join(root, name), new Date('2020-01-01'), new Date('2020-01-01'));
    }
    await utimes(join(root, files[5]), now, now);
    const preview = await cleanupLogs(30, false, root, now);
    assert.equal(preview.eligible_files, 1); assert.equal(preview.deleted_files, 0);
    assert.equal(preview.eligible_bytes, 9); assert.equal(preview.dry_run, true);
    assert.equal(await readFile(join(root, files[0]), 'utf8'), 'test data');
    const deleted = await cleanupLogs(30, true, root, now);
    assert.equal(deleted.deleted_files, 1); assert.equal(deleted.deleted_bytes, 9);
    await assert.rejects(readFile(join(root, files[0])), { code: 'ENOENT' });
    for (const name of files.slice(1)) assert.equal(await readFile(join(root, name), 'utf8'), 'test data');
    const allHistorical = await cleanupLogs(0, true, root, now);
    assert.equal(allHistorical.deleted_files, 1);
    assert.equal(await readFile(join(root, files[2]), 'utf8'), 'test data');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('log cleanup never traverses directories or directory junctions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'saplink-log-links-'));
  try {
    const logs = join(root, 'logs'); const external = join(root, 'external');
    await mkdir(logs); await mkdir(external);
    await writeFile(join(external, 'keep.txt'), 'keep');
    await symlink(external, join(logs, 'operations-2020-01-01-0.jsonl'), 'junction');
    await mkdir(join(logs, 'operations-2020-01-01-1.jsonl'));
    assert.equal((await cleanupLogs(0, true, logs, now)).deleted_files, 0);
    assert.equal(await readFile(join(external, 'keep.txt'), 'utf8'), 'keep');
    const linkedRoot = join(root, 'linked-logs'); await symlink(external, linkedRoot, 'junction');
    await assert.rejects(cleanupLogs(0, true, linkedRoot, now), (e: AppError) => e.code === 'LOG_DIRECTORY_UNSAFE');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('log cleanup handles a missing directory and validates retention', async () => {
  const root = await mkdtemp(join(tmpdir(), 'saplink-log-input-'));
  try {
    assert.equal((await cleanupLogs(30, true, join(root, 'absent'), now)).deleted_files, 0);
    for (const input of [-1, 1.5, 36501, '', ' ', null, undefined, true, NaN]) assert.throws(() => retentionDays(input), AppError);
    assert.equal(retentionDays('0'), 0); assert.equal(retentionDays('30'), 30);
  } finally { await rm(root, { recursive: true, force: true }); }
});
