import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { checkForUpdate, isNewerVersion, startAutomaticUpdates } from '../src/updates.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';

const release = { tag_name: 'v0.2.0', draft: false, prerelease: false, published_at: '2026-10-17T00:00:00Z',
  html_url: 'https://github.com/OneOFF-ive/saplink/releases/tag/v0.2.0' };
const fetcher = (body: unknown, status = 200) => (async () => new Response(JSON.stringify(body), { status })) as typeof fetch;
async function temporaryDirectory() {
  const root = join(process.cwd(), '.saplink', 'tests');
  await mkdir(root, { recursive: true });
  return mkdtemp(join(root, 'updates-'));
}

test('release comparison uses numeric versions and handles prerelease builds', () => {
  assert.equal(isNewerVersion('v0.10.0', '0.9.0'), true);
  assert.equal(isNewerVersion('v0.2.0', '0.2.0+local'), false);
  assert.equal(isNewerVersion('v0.2.0', '0.2.0-beta.1'), true);
  assert.equal(isNewerVersion('v0.2.0', '1.0.0'), false);
  assert.throws(() => isNewerVersion('v0.3.0-beta', '0.1.0'));
});

test('check caches metadata, recomputes against installed version, expires and supports force', async () => {
  const directory = await temporaryDirectory();
  let calls = 0;
  const mock = (async (url, init) => {
    calls++;
    assert.equal(url, 'https://api.github.com/repos/OneOFF-ive/saplink/releases/latest');
    assert.equal(init?.redirect, 'error');
    return new Response(JSON.stringify(release));
  }) as typeof fetch;
  try {
    const first = await checkForUpdate('0.1.0', directory, { fetcher: mock, now: 1000 });
    assert.equal(first.update_available, true); assert.equal(first.cached, false);
    const second = await checkForUpdate('0.2.0', directory, { fetcher: mock, now: 2000 });
    assert.equal(second.update_available, false); assert.equal(second.cached, true); assert.equal(calls, 1);
    await checkForUpdate('0.1.0', directory, { fetcher: mock, force: true, now: 3000 });
    assert.equal(calls, 2);
    await checkForUpdate('0.1.0', directory, { fetcher: mock, now: 3000 + 86400000 });
    assert.equal(calls, 3);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('missing releases, invalid metadata, network errors and rate limits are explicit', async () => {
  const directory = await temporaryDirectory();
  try {
    const check = (mock: typeof fetch) => checkForUpdate('0.1.0', directory, { force: true, fetcher: mock });
    const missing = await check(fetcher({}, 404));
    assert.equal(missing.latest_version, null);
    assert.equal(missing.release_url, 'https://github.com/OneOFF-ive/saplink/releases');
    await assert.rejects(check(fetcher({}, 403)), /HTTP 403/);
    await assert.rejects(check(fetcher({ ...release, html_url: 'https://evil.test/download' })), /invalid release metadata/);
    await assert.rejects(check(fetcher({ ...release, html_url: 'https://github.com/OneOFF-ive/another-repo/releases/tag/v0.2.0' })), /invalid release metadata/);
    await assert.rejects(check(fetcher({ ...release, prerelease: true })), /invalid release metadata/);
    await assert.rejects(check((async () => { throw new Error('offline'); }) as typeof fetch), /Could not reach GitHub/);
    await writeFile(join(directory, 'update-check.json'), 'broken cache');
    assert.equal((await checkForUpdate('0.1.0', directory, { fetcher: fetcher(release) })).update_available, true);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('cached metadata from a different repository is refreshed before exposing a download link', async () => {
  const directory = await temporaryDirectory();
  try {
    await writeFile(join(directory, 'update-check.json'), JSON.stringify({ checked_at: 1000,
      release: { ...release, html_url: 'https://github.com/OneOFF-ive/another-repo/releases/tag/v0.2.0' } }));
    let calls = 0;
    const result = await checkForUpdate('0.1.0', directory, { now: 2000,
      fetcher: (async () => { calls++; return new Response(JSON.stringify(release)); }) as typeof fetch });
    assert.equal(calls, 1);
    assert.equal(result.cached, false);
    assert.equal(result.release_url, release.html_url);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('CLI exposes cached update and download information in text and JSON modes', async () => {
  const directory = await temporaryDirectory();
  try {
    await checkForUpdate('0.1.0', directory, { fetcher: fetcher(release) });
    const execute = promisify(execFile);
    const env = { ...process.env, SAPLINK_CONFIG_DIR: directory };
    const json = await execute(process.execPath, [resolve('dist/cli.js'), 'update', 'check', '--json'], { env, timeout: 20000 });
    const result = JSON.parse(json.stdout);
    assert.equal(json.stderr, '');
    assert.equal(result.status, 'success');
    assert.equal(result.data.latest_version, '0.2.0');
    assert.equal(result.data.release_url, release.html_url);
    assert.equal(result.data.cached, true);
    const text = await execute(process.execPath, [resolve('dist/cli.js'), 'update', 'check'], { env, timeout: 20000 });
    assert.match(text.stdout, /Release \/ download page: https:\/\/github.com/);
    assert.match(text.stdout, /--force/);
    assert.equal(text.stderr, '');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('automatic checks reuse cache, notify once per version and stop cleanly', async () => {
  const directory = await temporaryDirectory();
  let calls = 0; let notices = 0;
  const automatic = startAutomaticUpdates('0.1.0', directory, {
    fetcher: (async () => { calls++; return new Response(JSON.stringify(release)); }) as typeof fetch,
    notify: () => { notices++; }
  });
  try {
    await automatic.initialCheck;
    await automatic.check();
    assert.equal(calls, 1); assert.equal(notices, 1);
    automatic.stop(); await automatic.check(); assert.equal(calls, 1);
  } finally { automatic.stop(); await rm(directory, { recursive: true, force: true }); }
});

test('automatic checks can be disabled and failures stay isolated', async () => {
  const directory = await temporaryDirectory();
  let calls = 0;
  const offline = (async () => { calls++; throw new Error('offline'); }) as typeof fetch;
  const disabled = startAutomaticUpdates('0.1.0', directory, { disabled: true, fetcher: offline });
  const enabled = startAutomaticUpdates('0.1.0', directory, { fetcher: offline });
  try {
    await Promise.all([disabled.initialCheck, enabled.initialCheck]);
    assert.equal(calls, 1);
  } finally { disabled.stop(); enabled.stop(); await rm(directory, { recursive: true, force: true }); }
});

test('automatic timer schedules later checks without blocking the caller', async () => {
  const directory = await temporaryDirectory();
  let calls = 0;
  const automatic = startAutomaticUpdates('0.1.0', directory, { intervalMs: 15,
    fetcher: (async () => { calls++; throw new Error('offline'); }) as typeof fetch });
  try {
    await automatic.initialCheck;
    await new Promise(resolve => setTimeout(resolve, 70));
    assert.ok(calls >= 2);
    automatic.stop(); const stopped = calls;
    await new Promise(resolve => setTimeout(resolve, 40));
    assert.equal(calls, stopped);
  } finally { automatic.stop(); await rm(directory, { recursive: true, force: true }); }
});
