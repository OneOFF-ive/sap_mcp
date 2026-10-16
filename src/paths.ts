import { homedir } from 'node:os';
import { join } from 'node:path';

export const defaultConfigDirectory = () => process.env.SAPLINK_CONFIG_DIR
  ?? join(process.env.APPDATA ?? homedir(), 'saplink');

export const defaultLogDirectory = () => process.env.SAPLINK_LOG_DIR
  ?? join(process.env.LOCALAPPDATA ?? homedir(), 'saplink', 'logs');
