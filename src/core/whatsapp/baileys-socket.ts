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
  end(error: Error | undefined): void | Promise<void>;
  sendMessage?(
    jid: string,
    content: { text: string },
  ): Promise<{ key?: { id?: string | null } } | undefined>;
}

export interface ConnectionUpdateLike {
  connection?: 'open' | 'connecting' | 'close';
  qr?: string;
  isNewLogin?: boolean;
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

export interface DisconnectDetails {
  statusCode: number | null;
  reasonName: string | null;
  errorMessage: string | null;
  streamErrorCode: string | null;
  streamErrorTag: string | null;
  conflictType: string | null;
  failureReason: string | null;
  failureLocation: string | null;
}

const REASON_NAMES: Record<number, string> = {
  401: 'loggedOut',
  403: 'forbidden',
  408: 'connectionLost/timedOut',
  411: 'multideviceMismatch',
  428: 'connectionClosed',
  440: 'connectionReplaced',
  500: 'badSession',
  503: 'unavailableService',
  515: 'restartRequired',
};

const SAFE_TOKEN = /^[A-Za-z0-9 _.:()/-]{1,80}$/;

/**
 * Extracts the disconnect reason from a Baileys Boom error without copying
 * message content, keys, or other binary node payloads into logs.
 * Baileys 6 puts the whole `stream:error` node in `data`
 * (`stream:error code=401 > conflict type=device_removed`); Baileys 7 puts only
 * the reason child (`conflict type=device_removed`). Connection failures carry
 * the failure attributes (`reason`, `location`).
 */
export function describeDisconnect(error: unknown): DisconnectDetails {
  const statusCode = readDisconnectStatusCode(error) ?? null;
  const details: DisconnectDetails = {
    statusCode,
    reasonName: statusCode === null ? null : REASON_NAMES[statusCode] ?? null,
    errorMessage: null,
    streamErrorCode: null,
    streamErrorTag: null,
    conflictType: null,
    failureReason: null,
    failureLocation: null,
  };
  if (!error || typeof error !== 'object') {
    return details;
  }

  details.errorMessage = safeToken((error as { message?: unknown }).message);
  const data = (error as { data?: unknown }).data;
  if (!data || typeof data !== 'object') {
    return details;
  }

  const node = data as { tag?: unknown; attrs?: unknown; content?: unknown; reason?: unknown; location?: unknown };
  if (node.tag === 'stream:error') {
    const attrs = asRecord(node.attrs);
    details.streamErrorCode = safeToken(attrs?.code);
    const first = Array.isArray(node.content) ? asRecord(node.content[0]) : undefined;
    details.streamErrorTag = safeToken(first?.tag);
    details.conflictType = safeToken(asRecord(first?.attrs)?.type);
    return details;
  }

  if (typeof node.tag === 'string') {
    details.streamErrorTag = safeToken(node.tag);
    details.conflictType = safeToken(asRecord(node.attrs)?.type);
    return details;
  }

  details.failureReason = safeToken(node.reason);
  details.failureLocation = safeToken(node.location);
  return details;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function safeToken(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }
  if (typeof value !== 'string') {
    return null;
  }
  return SAFE_TOKEN.test(value) ? value : null;
}

export function readSocketAccount(socket: WaSocketLike): ReturnType<typeof toAccount> {
  return toAccount(socket.user ?? socket.authState?.creds?.me);
}
