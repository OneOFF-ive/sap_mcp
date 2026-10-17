import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AppError } from './errors.js';
import { createRequire } from 'node:module';

const repository = 'OneOFF-ive/saplink';
const releasesUrl = `https://github.com/${repository}/releases`;
const cacheLifetime = 24 * 60 * 60 * 1000;
const versionPattern = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const releaseSchema = z.object({
  tag_name: z.string().max(256).regex(versionPattern),
  draft: z.literal(false), prerelease: z.literal(false),
  published_at: z.string().nullable(),
  html_url: z.string().refine(value => {
    try { const url = new URL(value); return url.origin === 'https://github.com' && !url.username && !url.password &&
      url.pathname.startsWith(`/${repository}/releases/tag/`) && !url.search && !url.hash; }
    catch { return false; }
  })
}).refine(value => !versionPattern.exec(value.tag_name)?.[4], 'Expected a stable release');
const cacheSchema = z.object({ checked_at: z.number(), release: releaseSchema.nullable() });

export function isNewerVersion(latest: string, current: string): boolean {
  const a = versionPattern.exec(latest); const b = versionPattern.exec(current);
  if (!a || !b || a[4]) throw new AppError('UPDATE_VERSION_INVALID', 'Expected a valid current version and a stable release tag such as v0.2.0.');
  for (let i = 1; i <= 3; i++) {
    if (BigInt(a[i]) !== BigInt(b[i])) return BigInt(a[i]) > BigInt(b[i]);
  }
  return Boolean(b[4]);
}

export async function checkForUpdate(currentVersion: string, directory: string,
  options: { force?: boolean; fetcher?: typeof fetch; now?: number; signal?: AbortSignal } = {}) {
  const now = options.now ?? Date.now();
  const cachePath = join(directory, 'update-check.json');
  let cached: z.infer<typeof cacheSchema> | undefined;
  if (!options.force) {
    try {
      const value = cacheSchema.parse(JSON.parse(await readFile(cachePath, 'utf8')));
      if (now >= value.checked_at && now - value.checked_at < cacheLifetime) cached = value;
    } catch { /* Missing or invalid caches are refreshed from GitHub. */ }
  }
  let release = cached?.release;
  if (!cached) {
    let response: Response;
    try {
      response = await (options.fetcher ?? fetch)(`https://api.github.com/repos/${repository}/releases/latest`, {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'SapLink-update-check', 'X-GitHub-Api-Version': '2022-11-28' },
        signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(8000)]) : AbortSignal.timeout(8000), redirect: 'error'
      });
    } catch { throw new AppError('UPDATE_CHECK_FAILED', `Could not reach GitHub within the update check timeout. Try again later or visit ${releasesUrl}`); }
    if (response.status === 404) release = null;
    else {
      if (!response.ok) throw new AppError('UPDATE_CHECK_FAILED', `GitHub returned HTTP ${response.status}. Try again later or visit ${releasesUrl}`);
      try { release = releaseSchema.parse(await response.json()); }
      catch { throw new AppError('UPDATE_RESPONSE_INVALID', `GitHub returned invalid release metadata. Visit ${releasesUrl}`); }
    }
    // Update metadata is separate from connection configuration and needs no service lock.
    try {
      await mkdir(directory, { recursive: true });
      const temporary = join(directory, `update-${randomUUID()}.tmp`);
      await writeFile(temporary, JSON.stringify({ checked_at: now, release }), { mode: 0o600 });
      await rename(temporary, cachePath);
    } catch { /* A cache write failure must not hide a successful check. */ }
  }
  return {
    current_version: currentVersion,
    latest_version: release?.tag_name.replace(/^v/, '') ?? null,
    update_available: release ? isNewerVersion(release.tag_name, currentVersion) : false,
    release_url: release?.html_url ?? releasesUrl,
    published_at: release?.published_at ?? null,
    checked_at: new Date(cached?.checked_at ?? now).toISOString(), cached: Boolean(cached),
    message: !release ? 'No public stable release found; the repository may be private or have no published releases.' :
      isNewerVersion(release.tag_name, currentVersion) ? 'A new version is available. Open the release page to choose and download the appropriate installer.' :
        'No newer stable version is available.'
  };
}

export type UpdateResult = Awaited<ReturnType<typeof checkForUpdate>>;
let automaticResult: UpdateResult | undefined;
export const getAutomaticUpdate = () => automaticResult;

export function startAutomaticUpdates(currentVersion: string, directory: string,
  options: { disabled?: boolean; intervalMs?: number; fetcher?: typeof fetch;
    notify?: (result: UpdateResult) => void | Promise<void> } = {}) {
  const controller = new AbortController();
  let checking = false;
  let notified: string | null = null;
  const check = async () => {
    if (checking || controller.signal.aborted || options.disabled) return;
    checking = true;
    try {
      const result = await checkForUpdate(currentVersion, directory, { fetcher: options.fetcher, signal: controller.signal });
      if (controller.signal.aborted) return;
      automaticResult = result;
      if (result.update_available && result.latest_version !== notified) {
        notified = result.latest_version;
        await options.notify?.(result);
      }
    } catch { /* Background failures do not interrupt SAP or produce repeated alerts. */ }
    finally { checking = false; }
  };
  const initialCheck = check();
  const timer = options.disabled ? undefined : setInterval(() => { void check(); }, options.intervalMs ?? cacheLifetime);
  timer?.unref();
  return { initialCheck, check, stop: () => { controller.abort(); if (timer) clearInterval(timer); } };
}

export function startRuntimeUpdateChecks(directory: string) {
  const version: string = createRequire(import.meta.url)('../package.json').version;
  return startAutomaticUpdates(version, directory, {
    disabled: process.env.SAPLINK_AUTO_UPDATE_CHECK === '0',
    notify: async result => {
      console.error(`SapLink ${result.latest_version} is available (current ${version}). Download: ${result.release_url}`);
      try {
        await mkdir(directory, { recursive: true });
        await writeFile(join(directory, 'update-notice.json'), JSON.stringify(result, null, 2), { mode: 0o600 });
      } catch { /* A notification file failure must not interrupt the service. */ }
    }
  });
}
