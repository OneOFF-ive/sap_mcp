import { appendFile, mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { defaultLogDirectory } from './paths.js';
export { defaultLogDirectory } from './paths.js';

export class AuditLog {
  private queue: Promise<void> = Promise.resolve();
  private day = '';
  private part = 0;
  constructor(private directory = defaultLogDirectory()) {}
  append(event: Record<string, unknown>): Promise<void> {
    const next = this.queue.then(async () => {
      await mkdir(this.directory, { recursive: true });
      const day = new Date().toISOString().slice(0, 10);
      if (this.day !== day) { this.day = day; this.part = 0; }
      let path: string;
      for (;;) {
        path = join(this.directory, `operations-${day}-${this.part}.jsonl`);
        try { if ((await stat(path)).size >= 5 * 1024 * 1024) { this.part++; continue; } }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        break;
      }
      await appendFile(path, JSON.stringify({ schema_version: 1, time: new Date().toISOString(), ...event }) + '\n', { mode: 0o600 });
    });
    this.queue = next.catch(() => {});
    return next;
  }
}
