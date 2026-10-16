import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { acquireLease, type LeaseOwner } from '../src/lease.js';

async function fixture(action: (directory: string, path: string) => Promise<void>) {
  const root = join(process.cwd(), '.saplink', 'tests');
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root, 'lease-'));
  try { await action(directory, join(directory, 'runtime.lock')); }
  finally { await rm(directory, { recursive: true, force: true }); }
}
const self: LeaseOwner = { started_at: 'self-start', command_line: 'node dist/cli.js ui' };
test('lease rejects a live owner but recovers a reused PID with a different start time', async () => {
  await fixture(async (directory, path) => {
    await writeFile(path, JSON.stringify({ pid: 42, started_at: 'old-start' }));
    const inspect = async (pid: number) => pid === process.pid ? self : { started_at: 'new-start', command_line: 'other.exe' };
    const release = await acquireLease(directory, 'runtime.lock', inspect);
    assert.equal(JSON.parse(await readFile(path, 'utf8')).started_at, self.started_at);
    await assert.rejects(acquireLease(directory, 'runtime.lock', inspect), /running/);
    await release();
  });
});
test('legacy lock pointing at another application is stale on Windows', { skip: process.platform !== 'win32' }, async () => {
  await fixture(async (directory, path) => {
    await writeFile(path, '42');
    const release = await acquireLease(directory, 'runtime.lock', async pid => pid === process.pid ? self :
      { started_at: 'other-start', command_line: 'WorkBuddy sandbox-cli.exe' });
    await release();
    await writeFile(path, '42');
    await assert.rejects(acquireLease(directory, 'runtime.lock', async () => self), /running/);
  });
});
test('dead owner is recovered; releasing an old lease never deletes a replacement', async () => {
  await fixture(async (directory, path) => {
    await writeFile(path, '42');
    const release = await acquireLease(directory, 'runtime.lock', async pid => pid === process.pid ? self : null);
    const replacement = JSON.stringify({ pid: 43, started_at: 'replacement' });
    await writeFile(path, replacement);
    await release();
    assert.equal(await readFile(path, 'utf8'), replacement);
  });
});
test('failed identity inspection preserves the existing lock', async () => {
  await fixture(async (directory, path) => {
    await writeFile(path, '42');
    await assert.rejects(acquireLease(directory, 'runtime.lock', async () => { throw new Error('Access denied'); }), /Access denied/);
    assert.equal(await readFile(path, 'utf8'), '42');
  });
});

test('concurrent stale recovery cannot delete a newly acquired lease', async () => {
  await fixture(async (directory, path) => {
    await writeFile(path, JSON.stringify({ pid: 42, started_at: 'dead' }));
    let entered!: () => void; let unblock!: () => void;
    const inspected = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { unblock = resolve; });
    const acquiring = acquireLease(directory, 'runtime.lock', async pid => {
      if (pid === 42) { entered(); await gate; return null; }
      return self;
    });
    await inspected;
    try { await assert.rejects(acquireLease(directory, 'runtime.lock', async () => null), /guard is busy/); }
    finally { unblock(); }
    const release = await acquiring;
    const record = await readFile(path, 'utf8');
    await assert.rejects(acquireLease(directory, 'runtime.lock', async () => self), /running/);
    assert.equal(await readFile(path, 'utf8'), record);
    await release();
  });
});

test('orphan guards fail closed and are never automatically reclaimed', async () => {
  await fixture(async (directory, path) => {
    await writeFile(path, '42'); await writeFile(`${path}.guard`, '');
    await assert.rejects(acquireLease(directory, 'runtime.lock', async () => null), /manually remove/);
    assert.equal(await readFile(path, 'utf8'), '42');
    assert.equal(await readFile(`${path}.guard`, 'utf8'), '');
  });
});

test('an old release callback cannot remove a new lease from the same process', async () => {
  await fixture(async (directory, path) => {
    const oldRelease = await acquireLease(directory, 'runtime.lock', async () => self);
    await oldRelease();
    const newRelease = await acquireLease(directory, 'runtime.lock', async () => self);
    const current = await readFile(path, 'utf8');
    await oldRelease();
    assert.equal(await readFile(path, 'utf8'), current);
    await newRelease();
  });
});

test('inspection failures release the guard; release never removes another guard', async () => {
  await fixture(async (directory, path) => {
    const release = await acquireLease(directory, 'runtime.lock', async () => self);
    const record = await readFile(path, 'utf8');
    await writeFile(`${path}.guard`, 'another operation');
    await assert.rejects(release(), /guard is busy/);
    assert.equal(await readFile(path, 'utf8'), record);
    assert.equal(await readFile(`${path}.guard`, 'utf8'), 'another operation');
    await rm(`${path}.guard`); await release();
    await assert.rejects(acquireLease(directory, 'runtime.lock', async () => { throw new Error('inspection failure'); }), /inspection failure/);
    await assert.rejects(readFile(`${path}.guard`), { code: 'ENOENT' });
    const nextRelease = await acquireLease(directory, 'runtime.lock', async () => self);
    await nextRelease();
  });
});
