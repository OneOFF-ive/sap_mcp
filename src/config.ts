import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { defaultConfigDirectory } from './paths.js';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { AppError } from './errors.js';

export const connectionFieldHints: Record<string, string> = {
  name: '连接名称仅允许英文字母、数字、下划线（_）和连字符（-），不允许中文、空格、点号或斜杠。例如 sap_system_01。',
  base_url: 'ADT 地址必须是 http:// 或 https:// 开头的服务器地址，例如 https://sap-host:443；路径只能为空、/ 或 /sap/bc/adt，不允许内嵌用户名密码、查询参数或 # 片段。',
  client: 'Client 必须是 3 位半角数字，例如 001 或 100；请保留前导零。',
  username: 'SAP 用户名不能为空，请填写 SAP 登录用户名。',
  language: '语言必须是 2 位大写英文字母，例如 EN、ZH 或 DE。',
  password: 'SAP 密码必须为文本，最多 512 个字符。',
  write_enabled: '允许程序写入必须为开启或关闭。'
};

export const connectionSchema = z.object({
  connection_id: z.string().uuid(),
  name: z.string().regex(/^[a-zA-Z0-9_-]+$/),
  base_url: z.string().transform((value, context) => {
    try {
      return normalizeUrl(value);
    } catch {
      context.addIssue({ code: 'custom', message: connectionFieldHints.base_url });
      return z.NEVER;
    }
  }),
  client: z.string().regex(/^\d{3}$/),
  username: z.string().min(1),
  language: z.string().regex(/^[A-Z]{2}$/),
  write_enabled: z.boolean().default(false),
}).strict();

export type Connection = z.infer<typeof connectionSchema>;

const configSchema = z.object({
  schema_version: z.literal(1),
  connections: z.array(connectionSchema),
  tokens: z.array(z.object({
    id: z.string(),
    hash: z.string(),
    created_at: z.string()
  }))
});

export type Config = z.infer<typeof configSchema>;

export function normalizeUrl(value: string): string {
  const u = new URL(value);
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.search || u.hash ||
    !['/', '/sap/bc/adt', '/sap/bc/adt/'].includes(u.pathname)) {
    throw new Error('Use an HTTP or HTTPS server URL without credentials, query or custom path');
  }
  return u.origin;
}

export const digest = (value: string) => createHash('sha256').update(value).digest('hex');

export class ConfigStore {
  constructor(public directory = defaultConfigDirectory()) { }

  async load(): Promise<Config> {
    try {
      return configSchema.parse(JSON.parse(await readFile(join(this.directory, 'config.json'), 'utf8')));
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        return {
          schema_version: 1,
          connections: [],
          tokens: []
        };
      if (error instanceof z.ZodError || error instanceof SyntaxError) {
        const legacy = error instanceof z.ZodError && error.issues.some(issue => issue.code === 'unrecognized_keys' && issue.keys.includes('allowed_packages'));
        throw new AppError('CONFIG_INVALID', legacy
          ? '本地 config.json 包含已废弃的 allowed_packages 字段，请删除该字段后重试；连接不限制包。'
          : '本地 config.json 格式无效，请检查配置文件；这不是连接表单的格式错误。');
      }
      throw error;
    }
  }

  async save(config: Config) {
    const validated = configSchema.parse(config);
    await mkdir(this.directory, { recursive: true });
    const temp = join(this.directory, `${randomUUID()}.tmp`);
    await writeFile(temp, JSON.stringify(validated, null, 2) + '\n', { mode: 0o600 });
    await rename(temp, join(this.directory, 'config.json'));
  }

  async createToken() {
    const config = await this.load();
    const token = randomBytes(32).toString('base64url');
    const id = randomUUID();
    config.tokens.push({
      id,
      hash: digest(token),
      created_at: new Date().toISOString()
    });
    await this.save(config);
    return {
      id,
      token
    };
  }

  async authenticate(token: string) {
    const hash = Buffer.from(digest(token), 'hex');
    return (await this.load()).tokens.some(t => {
      const expected = Buffer.from(t.hash, 'hex');
      return expected.length === hash.length && timingSafeEqual(expected, hash);
    });
  }
}

export interface Credentials {
  get(id: string): Promise<string>;
  set(id: string, password: string): Promise<void>;
  remove(id: string): Promise<void>;
}

export class WindowsCredentials implements Credentials {
  private async entry(id: string) {
    if (process.platform !== 'win32')
      throw new Error('Windows Credential Manager is required');
    const { Entry } = await import('@napi-rs/keyring');
    return new Entry('saplink', id);
  }

  async get(id: string) {
    const password = (await this.entry(id)).getPassword();
    if (!password)
      throw new Error('SAP credential is missing');
    return password;
  }

  async set(id: string, password: string) { (await this.entry(id)).setPassword(password); }

  async remove(id: string) { (await this.entry(id)).deletePassword(); }
}
