import { chmod, mkdir, readdir, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import type { AppLogger } from '../../config/logger.js';
import { AuthStoreError } from '../../shared/errors/app-error.js';

export interface StoredAuthState {
  creds?: {
    registered?: boolean;
    me?: {
      id?: string;
      name?: string;
      notify?: string;
      verifiedName?: string;
    };
  };
  keys: {
    get: (type: string, ids: string[]) => Promise<Record<string, unknown>>;
    set: (data: Record<string, Record<string, unknown>>) => Promise<void>;
  };
}

export interface AuthStateHandle {
  state: StoredAuthState;
  saveCreds: () => Promise<void>;
  registered: boolean;
}

export interface SessionStore {
  load(): Promise<AuthStateHandle>;
  invalidate(): Promise<void>;
}

/**
 * Baileys sets `creds.registered` only for pairing-code logins. A QR-linked
 * session keeps `registered: false` and is identified by `creds.me.id`.
 */
export function hasLinkedAccount(creds: StoredAuthState['creds']): boolean {
  return creds?.registered === true || Boolean(creds?.me?.id);
}

export interface AuthStorageReport {
  authPath: string;
  onRailway: boolean;
  volumeMountPath: string | null;
  onVolume: boolean | null;
  instance: {
    hostname: string;
    pid: number;
    deploymentId: string | null;
    replicaId: string | null;
  };
}

/**
 * Railway sets RAILWAY_VOLUME_MOUNT_PATH only when a volume is attached.
 * Auth files outside that path are lost on every redeploy.
 */
export function describeAuthStorage(
  env: NodeJS.ProcessEnv,
  authPath: string,
  host: { hostname: string; pid: number },
): AuthStorageReport {
  const resolved = path.resolve(authPath);
  const onRailway = Boolean(env.RAILWAY_ENVIRONMENT_NAME || env.RAILWAY_ENVIRONMENT || env.RAILWAY_PROJECT_ID);
  const mount = env.RAILWAY_VOLUME_MOUNT_PATH ? path.resolve(env.RAILWAY_VOLUME_MOUNT_PATH) : null;
  let onVolume: boolean | null = null;
  if (mount) {
    const relative = path.relative(mount, resolved);
    onVolume = relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
  } else if (onRailway) {
    onVolume = false;
  }
  return {
    authPath: resolved,
    onRailway,
    volumeMountPath: mount,
    onVolume,
    instance: {
      hostname: host.hostname,
      pid: host.pid,
      deploymentId: env.RAILWAY_DEPLOYMENT_ID ?? null,
      replicaId: env.RAILWAY_REPLICA_ID ?? null,
    },
  };
}

export const BACKUP_DIRECTORY = '.backups';
export const MAX_AUTH_BACKUPS = 3;

export type AuthStateFactory = (directory: string) => Promise<{
  state: StoredAuthState;
  saveCreds: () => Promise<void>;
}>;

/**
 * File-backed store used for the single-account Phase 1 gateway.
 * Baileys documents useMultiFileAuthState as a helper, not a production-grade
 * database. Keeping it behind SessionStore lets a later version replace the
 * files with another store without rewriting connection or HTTP code.
 */
export class FileSessionStore implements SessionStore {
  private readonly directory: string;

  constructor(
    authPath: string,
    private readonly logger: AppLogger,
    private readonly authStateFactory: AuthStateFactory = defaultAuthStateFactory,
  ) {
    this.directory = path.resolve(authPath);
  }

  async load(): Promise<AuthStateHandle> {
    await this.ensureDirectory();
    await this.assertJsonFilesReadable();

    let loaded: { state: StoredAuthState; saveCreds: () => Promise<void> };
    try {
      loaded = await this.authStateFactory(this.directory);
    } catch (error) {
      const detail = error instanceof AuthStoreError ? error.message : error instanceof Error ? error.message : 'unknown error';
      throw new AuthStoreError(`Authentication storage could not be loaded from ${this.directory}: ${detail}`, 'unreadable');
    }

    const registered = hasLinkedAccount(loaded.state.creds);
    return {
      state: loaded.state,
      saveCreds: async () => {
        try {
          await loaded.saveCreds();
        } catch (error) {
          const detail = error instanceof Error ? error.message : 'unknown write failure';
          throw new AuthStoreError(`Authentication credentials could not be saved: ${detail}`, 'write');
        }
      },
      registered,
    };
  }

  /**
   * Moves the current auth files into `.backups/<timestamp>` inside the same
   * directory, so the move stays on the same volume. Nothing is deleted except
   * backups older than the newest MAX_AUTH_BACKUPS.
   */
  async invalidate(): Promise<void> {
    await this.ensureDirectory();
    const entries = (await this.listEntries()).filter((entry) => entry !== BACKUP_DIRECTORY);
    if (entries.length === 0) {
      this.logger.info(
        {
          event: 'auth.invalidated',
          connectionState: 'LOGGED_OUT',
          backedUpFiles: 0,
        },
        'Authentication state invalidated',
      );
      return;
    }

    const backupName = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = path.join(this.directory, BACKUP_DIRECTORY, backupName);
    try {
      await mkdir(backupPath, { recursive: true, mode: 0o700 });
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'unknown error';
      throw new AuthStoreError(`Authentication backup directory could not be created: ${detail}`, 'write');
    }

    for (const entry of entries) {
      try {
        await rename(path.join(this.directory, entry), path.join(backupPath, entry));
      } catch (error) {
        const detail = error instanceof Error ? error.message : 'unknown error';
        throw new AuthStoreError(`Authentication file ${entry} could not be moved to the backup: ${detail}`, 'write');
      }
    }

    await this.pruneBackups();
    this.logger.info(
      {
        event: 'auth.invalidated',
        connectionState: 'LOGGED_OUT',
        backedUpFiles: entries.length,
        backup: `${BACKUP_DIRECTORY}/${backupName}`,
      },
      'Authentication state moved to a backup',
    );
  }

  private async listEntries(): Promise<string[]> {
    try {
      return await readdir(this.directory);
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'unknown error';
      throw new AuthStoreError(`Authentication directory could not be read: ${detail}`, 'unreadable');
    }
  }

  private async pruneBackups(): Promise<void> {
    const root = path.join(this.directory, BACKUP_DIRECTORY);
    let backups: string[];
    try {
      backups = (await readdir(root)).sort();
    } catch {
      return;
    }
    const stale = backups.slice(0, Math.max(0, backups.length - MAX_AUTH_BACKUPS));
    for (const name of stale) {
      try {
        await rm(path.join(root, name), { recursive: true, force: true });
      } catch (error) {
        this.logger.warn(
          {
            event: 'auth.backup.prune_failed',
            connectionState: 'LOGGED_OUT',
            errorCategory: 'auth_store',
            err: error,
          },
          'An old authentication backup could not be removed',
        );
      }
    }
  }

  private async ensureDirectory(): Promise<void> {
    try {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'unknown error';
      throw new AuthStoreError(`Cannot create authentication directory at ${this.directory}: ${detail}`, 'unreadable');
    }

    if (process.platform === 'win32') {
      this.logger.debug(
        {
          event: 'auth.permissions',
          connectionState: 'INITIALIZING',
        },
        'Authentication directory permissions are not restricted on Windows',
      );
      return;
    }

    try {
      await chmod(this.directory, 0o700);
    } catch (error) {
      this.logger.warn(
        {
          event: 'auth.permissions',
          connectionState: 'INITIALIZING',
          errorCategory: 'auth_store',
          err: error,
        },
        'Could not set authentication directory permissions to 0700',
      );
    }
  }

  private async assertJsonFilesReadable(): Promise<void> {
    let entries: string[];
    try {
      entries = await readdir(this.directory);
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'unknown error';
      throw new AuthStoreError(`Authentication directory could not be read: ${detail}`, 'unreadable');
    }

    for (const entry of entries) {
      if (!entry.endsWith('.json')) {
        continue;
      }
      const fullPath = path.join(this.directory, entry);
      let raw: string;
      try {
        raw = await readFile(fullPath, 'utf8');
      } catch {
        throw new AuthStoreError(`Authentication file ${entry} is unreadable.`, 'unreadable');
      }

      try {
        JSON.parse(raw);
      } catch {
        throw new AuthStoreError(`Authentication file ${entry} is corrupted and was not loaded.`, 'corrupt');
      }
    }
  }
}

async function defaultAuthStateFactory(directory: string): Promise<{
  state: StoredAuthState;
  saveCreds: () => Promise<void>;
}> {
  const baileys = await import('@whiskeysockets/baileys');
  const loaded = await baileys.useMultiFileAuthState(directory);
  return {
    state: loaded.state as unknown as StoredAuthState,
    saveCreds: loaded.saveCreds,
  };
}
