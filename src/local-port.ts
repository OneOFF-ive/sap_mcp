import { createConnection } from 'node:net';
import { AppError } from './errors.js';

// Check for an existing listener rather than assuming a successful test bind proves
// exclusivity on every Windows networking configuration. This is still a preflight,
// not an atomic reservation; the real server must also handle listen failures.
export function localPortInUse(port: number): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', (error: NodeJS.ErrnoException) => {
      socket.destroy();
      if (error.code === 'ECONNREFUSED') resolve(false);
      else reject(new AppError('PORT_CHECK_UNAVAILABLE', 'Could not establish whether the local port is free. No takeover was attempted.'));
    });
    socket.setTimeout(1000, () => {
      socket.destroy();
      reject(new AppError('PORT_CHECK_UNAVAILABLE', 'Local port probe timed out. No takeover was attempted.'));
    });
  });
}
