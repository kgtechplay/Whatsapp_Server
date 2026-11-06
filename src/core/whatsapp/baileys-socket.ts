import type pino from 'pino';
import type { AccountContact } from '../../shared/utils/account.js';
import { toAccount } from '../../shared/utils/account.js';
import type { StoredAuthState } from './session-store.js';

export const QR_TIMEOUT_MS = 60_000;

export interface WaSocketLike {
  ev: {
    on(event: 'connection.update', listener: (update: ConnectionUpdateLike) => void): void;
    on(event: 'creds.update', listener: () => void): void;
  };
  user?: AccountContact;
  authState?: {
    creds?: {
      me?: AccountContact;
      registered?: boolean;
    };
  };
  logout(msg?: string): Promise<void>;
  end(error: Error | undefined): void;
  sendMessage?(
    jid: string,
    content: { text: string },
  ): Promise<{ key?: { id?: string | null } } | undefined>;
}

export interface ConnectionUpdateLike {
  connection?: 'open' | 'connecting' | 'close';
  qr?: string;
  lastDisconnect?: {
    error?: unknown;
    date?: Date;
  };
}

export interface SocketFactory {
  create(authState: StoredAuthState): Promise<WaSocketLike>;
}

export function createBaileysSocketFactory(baileysLogger: pino.Logger): SocketFactory {
  return {
    async create(authState: StoredAuthState): Promise<WaSocketLike> {
      const baileys = await import('@whiskeysockets/baileys');
      const version = await resolveWaWebVersion(baileys.fetchLatestWaWebVersion, baileysLogger);
      const socket = baileys.default({
        ...(version ? { version } : {}),
        auth: authState as never,
        logger: baileysLogger,
        printQRInTerminal: false,
        markOnlineOnConnect: false,
        qrTimeout: QR_TIMEOUT_MS,
        syncFullHistory: false,
        browser: baileys.Browsers.ubuntu('Chrome'),
      });
      return socket as unknown as WaSocketLike;
    },
  };
}

const VERSION_LOOKUP_TIMEOUT_MS = 5_000;

/**
 * WhatsApp can unlink a new device that reports an outdated Web version.
 * Falls back to the version bundled with Baileys when the lookup fails.
 */
async function resolveWaWebVersion(
  fetchLatest: (options: object) => Promise<{ version: [number, number, number]; isLatest: boolean }>,
  logger: pino.Logger,
): Promise<[number, number, number] | undefined> {
  try {
    const result = await fetchLatest({ signal: AbortSignal.timeout(VERSION_LOOKUP_TIMEOUT_MS) });
    return result.isLatest ? result.version : undefined;
  } catch {
    logger.warn('WhatsApp Web version lookup failed; using the version bundled with Baileys');
    return undefined;
  }
}

export function readDisconnectStatusCode(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') {
    return undefined;
  }
  const candidate = error as { output?: { statusCode?: unknown }; statusCode?: unknown };
  if (typeof candidate.output?.statusCode === 'number') {
    return candidate.output.statusCode;
  }
  if (typeof candidate.statusCode === 'number') {
    return candidate.statusCode;
  }
  return undefined;
}

export function readSocketAccount(socket: WaSocketLike): ReturnType<typeof toAccount> {
  return toAccount(socket.user ?? socket.authState?.creds?.me);
}
