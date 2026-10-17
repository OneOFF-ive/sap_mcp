import { createRequire } from 'node:module';

export const appVersion: string = createRequire(import.meta.url)('../package.json').version;
