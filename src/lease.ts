import { mkdir, open, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';

export async function acquireLease(directory: string, filename: string) {
  await mkdir(directory, { recursive: true });
  const path = join(directory, filename);
  try {
    const pid = Number(await readFile(path, 'utf8'));
    if (!Number.isInteger(pid) || pid <= 0) throw new Error('Invalid lock file');
    try { process.kill(pid, 0); throw new Error('Service or configuration command is running'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
    await unlink(path);
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const file = await open(path, 'wx');
  try { await file.writeFile(String(process.pid)); } finally { await file.close(); }
  return () => unlink(path);
}
