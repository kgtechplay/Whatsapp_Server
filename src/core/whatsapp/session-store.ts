import { chmod, mkdir, readdir, readFile, rm } from 'node:fs/promises';
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

    const registered = loaded.state.creds?.registered === true;
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

  async invalidate(): Promise<void> {
    await this.ensureDirectory();
    let entries: string[];
    try {
      entries = await readdir(this.directory);
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'unknown error';
      throw new AuthStoreError(`Authentication directory could not be read: ${detail}`, 'unreadable');
    }

    await Promise.all(
      entries.map(async (entry) => {
        try {
          await rm(path.join(this.directory, entry), { recursive: true, force: true });
        } catch (error) {
          const detail = error instanceof Error ? error.message : 'unknown error';
          throw new AuthStoreError(`Authentication file ${entry} could not be removed: ${detail}`, 'write');
        }
      }),
    );

    this.logger.info(
      {
        event: 'auth.invalidated',
        connectionState: 'LOGGED_OUT',
      },
      'Authentication state invalidated',
    );
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
