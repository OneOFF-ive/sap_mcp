import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';

// Generate metadata from real installers; publishing remains an explicit action.
const repository = fileURLToPath(new URL('../', import.meta.url));
const { values } = parseArgs({ options: {
  version: { type: 'string' }, directory: { type: 'string' }, out: { type: 'string' },
  'base-url': { type: 'string', default: 'https://saplink-1302377695.cos.ap-shanghai.myqcloud.com/saplink/' },
  architectures: { type: 'string', default: 'x64,arm64' }
} });
const version = values.version ?? JSON.parse(await readFile(join(repository, 'package.json'), 'utf8')).version;
if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) throw new Error('Use a stable version such as 1.0.1.');
const base = new URL(values['base-url']);
if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash || !base.pathname.endsWith('/')) {
  throw new Error('Base URL must be HTTPS, end in /, and contain no credentials, query or fragment.');
}
const architectures = values.architectures.split(',');
if (!architectures.length || new Set(architectures).size !== architectures.length || architectures.some(arch => !['x64', 'arm64'].includes(arch))) {
  throw new Error('Architectures must be x64, arm64, or x64,arm64.');
}
const directory = resolve(values.directory ?? join(repository, 'outputs', 'installers', version));
const downloads = [];
for (const architecture of architectures) {
  const filename = `SapLink-${version}-win-${architecture}-setup.exe`;
  const installer = join(directory, filename);
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(installer)) hash.update(chunk);
  const sha256 = hash.digest('hex');
  const expected = (await readFile(`${installer}.sha256`, 'utf8')).trim();
  if (expected !== `${sha256}  ${filename}`) throw new Error(`Checksum mismatch: ${filename}`);
  downloads.push({ architecture, url: new URL(`v${version}/${filename}`, base).href, sha256 });
}
const manifest = { schema_version: 1, version, published_at: new Date().toISOString(), downloads };
const output = resolve(values.out ?? join(directory, 'latest.json'));
await mkdir(dirname(output), { recursive: true });
const temporary = `${output}.${randomUUID()}.tmp`;
await writeFile(temporary, JSON.stringify(manifest, null, 2) + '\n');
await rename(temporary, output);
console.log(`Generated ${output} (${architectures.join(', ')}). Upload installers first, then publish this file as saplink/latest.json.`);
