// While the server runs it marks its data directory, so that another process — the command line in its own process —
// does not build a second server on the same folder. That would be destructive: ImageStore and VolumeStore empty
// `uploads/` and `volumes/` when they start, which would pull the ground from under uploads and imports in flight.

import fs from 'node:fs/promises';
import path from 'node:path';

export interface ServerLock {
  pid: number;
  host: string;
  port: number;
  startedAt: string;
}

export function lockPath(dataDir: string): string {
  return path.join(dataDir, 'server.lock');
}

export async function writeServerLock(dataDir: string, lock: ServerLock): Promise<void> {
  await fs.writeFile(lockPath(dataDir), `${JSON.stringify(lock, null, 2)}\n`);
}

export async function removeServerLock(dataDir: string): Promise<void> {
  await fs.rm(lockPath(dataDir), { force: true });
}

/**
 * The server using this data directory, or null when none does. A lock left behind by a process that is gone is
 * ignored: it says nothing about the folder.
 */
export async function readServerLock(dataDir: string): Promise<ServerLock | null> {
  let lock: ServerLock;
  try {
    lock = JSON.parse(await fs.readFile(lockPath(dataDir), 'utf8')) as ServerLock;
  } catch {
    return null;
  }
  try {
    // Signal 0 asks whether the process exists, without touching it
    process.kill(lock.pid, 0);
  } catch (error) {
    // EPERM: the process exists but belongs to someone else, so it is still running
    return (error as NodeJS.ErrnoException).code === 'EPERM' ? lock : null;
  }
  return lock;
}
