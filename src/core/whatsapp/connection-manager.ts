import type { AppConfig } from '../../config/env.js';
import type { AppLogger } from '../../config/logger.js';
import { AuthStoreError, OperationConflictError } from '../../shared/errors/app-error.js';
import type { WhatsAppConnectionProvider } from '../interfaces/connection-provider.js';
import { readDisconnectStatusCode, readSocketAccount } from './baileys-socket.js';
import type { ConnectionUpdateLike, SocketFactory, WaSocketLike } from './baileys-socket.js';
import { ConnectionStatusService } from './connection-status.js';
import { classifyDisconnect, computeReconnectDelay } from './reconnect-policy.js';
import type { ReconnectPolicy } from './reconnect-policy.js';
import type { AuthStateHandle, SessionStore } from './session-store.js';
import type { ConnectResult, ConnectionStateName, ConnectionStatus, LogoutResult, QrQueryResult } from './whatsapp.types.js';

const ACTIVE_STATUSES = new Set<ConnectionStateName>(['CONNECTED', 'CONNECTING', 'QR_REQUIRED', 'RECONNECTING']);

export class WhatsAppSendError extends Error {
  readonly reason: 'disconnected';

  constructor(reason: 'disconnected') {
    super('WhatsApp is not currently connected');
    this.name = 'WhatsAppSendError';
    this.reason = reason;
  }
}

export interface ConnectionManagerOptions {
  config: AppConfig;
  logger: AppLogger;
  status: ConnectionStatusService;
  sessionStore: SessionStore;
  socketFactory: SocketFactory;
  policy: ReconnectPolicy;
  random?: () => number;
}

/**
 * Owns the single Baileys socket for this process.
 * HTTP controllers call this class and never create sockets themselves.
 * Message events are intentionally ignored in Phase 1.
 */
export class ConnectionManager implements WhatsAppConnectionProvider {
  private readonly random: () => number;
  private socket: WaSocketLike | null = null;
  private generation = 0;
  private registered = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private qr: { payload: string; expiresAt: null } | null = null;
  private reconnectAllowed: boolean;
  private shuttingDown = false;
  private logoutInProgress = false;
  private credentialsNeedReset = false;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly saves = new Set<Promise<void>>();

  constructor(private readonly options: ConnectionManagerOptions) {
    this.random = options.random ?? Math.random;
    this.reconnectAllowed = options.config.autoReconnect;
  }

  isConnected(): boolean {
    return this.getStatus().connected;
  }

  /**
   * Sends on the socket this manager already owns.
   * It does not open, reload, or replace that socket.
   */
  async sendText(jid: string, text: string): Promise<{ messageId: string | null }> {
    const socket = this.socket;
    if (this.shuttingDown || !this.isConnected() || !socket?.sendMessage) {
      throw new WhatsAppSendError('disconnected');
    }
    const response = await socket.sendMessage(jid, { text });
    const messageId = response?.key?.id;
    if (typeof messageId !== 'string' || messageId.length === 0) {
      return { messageId: null };
    }
    return { messageId };
  }

  getStatus(): ConnectionStatus {
    return this.options.status.snapshot();
  }

  hasPendingRetry(): boolean {
    return this.retryTimer !== null;
  }

  async connect(): Promise<void> {
    const result = await this.requestConnect();
    if (result.failed) {
      throw new OperationConflictError(result.message);
    }
  }

  async logout(): Promise<void> {
    const result = await this.requestLogout();
    if (!result.success) {
      throw new OperationConflictError(result.message);
    }
  }

  async start(): Promise<void> {
    await this.enqueue(async () => {
      if (this.shuttingDown) {
        return;
      }
      this.options.status.mark('INITIALIZING');
      this.reconnectAllowed = this.options.config.autoReconnect;
      await this.openSocket();
    });
  }

  async requestConnect(): Promise<ConnectResult> {
    if (this.shuttingDown || this.logoutInProgress) {
      throw new OperationConflictError('A logout or shutdown is already in progress.');
    }

    return this.enqueue(async () => {
      if (this.shuttingDown || this.logoutInProgress) {
        throw new OperationConflictError('A logout or shutdown is already in progress.');
      }

      const current = this.options.status.snapshot().status;
      if (this.hasActiveAttempt(current)) {
        return {
          initiated: false,
          status: current,
          failed: false,
          message: 'Connection already active',
        };
      }

      if (current === 'LOGGED_OUT' || this.credentialsNeedReset) {
        await this.options.sessionStore.invalidate();
        this.credentialsNeedReset = false;
        this.qr = null;
        this.registered = false;
      }

      this.reconnectAllowed = this.options.config.autoReconnect;
      this.options.status.resetReconnectAttempts();
      await this.openSocket();
      const snapshot = this.options.status.snapshot();
      return {
        initiated: true,
        status: snapshot.status,
        failed: snapshot.status === 'ERROR',
        message: snapshot.status === 'ERROR' ? snapshot.lastError?.message ?? 'Connection attempt failed.' : 'Connection initiated',
      };
    });
  }

  async requestLogout(): Promise<LogoutResult> {
    if (this.shuttingDown) {
      throw new OperationConflictError('Service is shutting down.');
    }
    if (this.logoutInProgress) {
      throw new OperationConflictError('Logout is already in progress.');
    }

    this.logoutInProgress = true;
    try {
      return await this.enqueue(() => this.performLogout());
    } finally {
      this.logoutInProgress = false;
    }
  }

  /**
   * Closes the socket without sending a WhatsApp logout.
   * Saved credentials stay valid for the next process start.
   */
  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    this.reconnectAllowed = false;
    this.clearRetry();

    await this.enqueue(async () => {
      this.generation += 1;
      const socket = this.socket;
      this.socket = null;
      this.qr = null;
      if (socket) {
        this.safeEnd(socket);
      }
      await this.flushSaves();
    });
  }

  getQr(): QrQueryResult {
    const status = this.options.status.snapshot().status;
    if (this.qr && status === 'QR_REQUIRED') {
      return {
        kind: 'available',
        status: 'QR_REQUIRED',
        qr: this.qr.payload,
        expiresAt: this.qr.expiresAt,
      };
    }

    if ((status === 'QR_REQUIRED' || status === 'CONNECTING') && !this.registered) {
      return { kind: 'pending', status };
    }

    return { kind: 'not-applicable', status };
  }

  private hasActiveAttempt(status: ConnectionStateName): boolean {
    if (status === 'RECONNECTING' && (this.retryTimer || this.socket)) {
      return true;
    }
    if (this.socket && ACTIVE_STATUSES.has(status)) {
      return true;
    }
    return false;
  }

  private async performLogout(): Promise<LogoutResult> {
    this.reconnectAllowed = false;
    this.clearRetry();
    this.qr = null;
    this.generation += 1;

    const current = this.options.status.snapshot();
    this.options.logger.info(
      {
        event: 'whatsapp.logout.initiated',
        connectionState: current.status,
      },
      'Logout initiated',
    );

    const socket = this.socket;
    this.socket = null;

    if (!socket && current.status === 'LOGGED_OUT') {
      return {
        success: true,
        partial: false,
        remoteConfirmed: false,
        status: 'LOGGED_OUT',
        message: 'Session is already logged out.',
      };
    }

    if (!socket && this.registered) {
      this.options.status.markDisconnected(
        {
          category: 'logout',
          message: 'Remote logout was not confirmed because no socket is active.',
        },
        'DISCONNECTED',
      );
      this.options.logger.warn(
        {
          event: 'whatsapp.logout.failed',
          connectionState: 'DISCONNECTED',
          errorCategory: 'logout',
        },
        'Remote logout was not confirmed',
      );
      return {
        success: false,
        partial: true,
        remoteConfirmed: false,
        status: 'DISCONNECTED',
        message:
          'No active socket is available, so remote logout was not confirmed. Automatic reconnection is stopped. Saved credentials were kept.',
      };
    }

    const hadRegisteredSession = this.registered;
    try {
      if (socket && hadRegisteredSession) {
        await socket.logout();
      } else if (socket) {
        this.safeEnd(socket);
      }

      await this.options.sessionStore.invalidate();
      this.registered = false;
      this.credentialsNeedReset = false;
      this.options.status.markDisconnected(
        {
          category: 'logged_out',
          message: hadRegisteredSession
            ? 'WhatsApp session was logged out.'
            : 'Local pairing state was cleared.',
        },
        'LOGGED_OUT',
      );
      this.options.logger.info(
        {
          event: 'whatsapp.logout.completed',
          connectionState: 'LOGGED_OUT',
          remoteConfirmed: Boolean(socket && hadRegisteredSession),
        },
        'Logout completed',
      );
      return {
        success: true,
        partial: false,
        remoteConfirmed: Boolean(socket && hadRegisteredSession),
        status: 'LOGGED_OUT',
        message: hadRegisteredSession ? 'WhatsApp session was logged out.' : 'Pairing session cleared.',
      };
    } catch (error) {
      if (socket) {
        this.safeEnd(socket);
      }
      this.options.status.markDisconnected(
        {
          category: 'logout',
          message: 'Remote logout was not confirmed.',
        },
        'DISCONNECTED',
      );
      this.options.logger.error(
        {
          event: 'whatsapp.logout.failed',
          connectionState: 'DISCONNECTED',
          errorCategory: 'logout',
          err: error,
        },
        'Remote logout was not confirmed',
      );
      return {
        success: false,
        partial: true,
        remoteConfirmed: false,
        status: 'DISCONNECTED',
        message:
          'Remote logout was not confirmed. Automatic reconnection is stopped. Saved credentials were kept.',
      };
    }
  }

  private async openSocket(): Promise<void> {
    if (this.shuttingDown || this.logoutInProgress || this.socket) {
      return;
    }

    await this.flushSaves();
    if (this.shuttingDown || this.logoutInProgress) {
      return;
    }

    let handle: AuthStateHandle;
    try {
      handle = await this.options.sessionStore.load();
    } catch (error) {
      const resetCredentials = error instanceof AuthStoreError && error.reason === 'corrupt';
      const message =
        error instanceof AuthStoreError
          ? error.message
          : 'Authentication storage could not be loaded.';
      this.fail('auth_store', message, error, { resetCredentials });
      return;
    }

    if (this.shuttingDown || this.logoutInProgress) {
      return;
    }

    this.registered = handle.registered;
    this.options.logger.info(
      {
        event: 'auth.loaded',
        connectionState: this.options.status.snapshot().status,
        registered: this.registered,
      },
      'Authentication state loaded',
    );
    const status = this.options.status.snapshot().status;
    if (status !== 'RECONNECTING') {
      this.options.status.mark('CONNECTING');
    }

    const generation = ++this.generation;
    let socket: WaSocketLike;
    try {
      socket = await this.options.socketFactory.create(handle.state);
    } catch (error) {
      this.fail('socket', 'WhatsApp socket could not be created.', error);
      return;
    }

    if (this.shuttingDown || this.logoutInProgress || this.generation !== generation) {
      this.safeEnd(socket);
      return;
    }

    this.socket = socket;
    socket.ev.on('creds.update', () => {
      this.registered = handle.state.creds?.registered === true || this.registered;
      this.trackSave(handle.saveCreds);
    });
    socket.ev.on('connection.update', (update) => {
      this.onConnectionUpdate(generation, socket, update);
    });

    this.options.logger.info(
      {
        event: 'whatsapp.connect.initiated',
        connectionState: this.options.status.snapshot().status,
        reconnectAttempt: this.options.status.snapshot().reconnectAttempts,
        registered: this.registered,
      },
      'WhatsApp connection initiated',
    );
  }

  private onConnectionUpdate(generation: number, socket: WaSocketLike, update: ConnectionUpdateLike): void {
    if (generation !== this.generation) {
      return;
    }

    if (update.qr) {
      this.qr = { payload: update.qr, expiresAt: null };
      this.options.status.mark('QR_REQUIRED');
      this.options.logger.info(
        {
          event: 'whatsapp.qr.generated',
          connectionState: 'QR_REQUIRED',
        },
        'Pairing QR generated',
      );
    }

    if (update.connection === 'connecting' && this.options.status.snapshot().status !== 'RECONNECTING') {
      this.options.status.mark('CONNECTING');
    }

    if (update.connection === 'open') {
      const attempts = this.options.status.snapshot().reconnectAttempts;
      this.qr = null;
      this.registered = true;
      const account = readSocketAccount(socket);
      this.options.status.markConnected(account);
      this.options.logger.info(
        {
          event: attempts > 0 ? 'whatsapp.reconnect.succeeded' : 'whatsapp.connected',
          connectionState: 'CONNECTED',
          reconnectAttempt: attempts,
          accountId: account?.id ?? null,
        },
        attempts > 0 ? 'WhatsApp reconnection succeeded' : 'WhatsApp connected',
      );
      return;
    }

    if (update.connection === 'close') {
      this.handleClose(generation, socket, update.lastDisconnect?.error);
    }
  }

  private handleClose(generation: number, socket: WaSocketLike, error: unknown): void {
    if (generation !== this.generation || this.shuttingDown || this.logoutInProgress) {
      return;
    }

    if (this.socket === socket) {
      this.socket = null;
    }
    this.generation += 1;
    this.qr = null;

    const decision = classifyDisconnect(readDisconnectStatusCode(error));
    if (!decision.recoverable || !this.reconnectAllowed) {
      this.clearRetry();
      if (decision.resetCredentials) {
        this.credentialsNeedReset = true;
      }
      const state = decision.recoverable ? 'DISCONNECTED' : decision.state;
      this.options.status.markDisconnected(
        { category: decision.category, message: decision.message },
        state === 'RECONNECTING' ? 'DISCONNECTED' : state,
      );
      const fields = {
        event: decision.recoverable ? 'whatsapp.disconnected' : 'app.unrecoverable',
        connectionState: this.options.status.snapshot().status,
        errorCategory: decision.category,
        reconnectAttempt: this.options.status.snapshot().reconnectAttempts,
        err: error,
      };
      if (decision.recoverable) {
        this.options.logger.warn(fields, 'WhatsApp disconnected');
      } else if (decision.state === 'LOGGED_OUT') {
        this.options.logger.warn(
          {
            event: 'whatsapp.disconnected',
            connectionState: 'LOGGED_OUT',
            errorCategory: decision.category,
            reconnectAttempt: 0,
          },
          'WhatsApp session logged out',
        );
      } else {
        this.options.logger.error(fields, decision.message);
      }
      return;
    }

    this.scheduleReconnect(decision.category, decision.message, error);
  }

  private scheduleReconnect(category: string, message: string, error: unknown): void {
    this.clearRetry();
    const attempt = this.options.status.incrementReconnectAttempts();
    const delayMs = computeReconnectDelay(attempt, this.options.policy, this.random);
    this.options.status.markDisconnected({ category, message }, 'RECONNECTING');
    this.options.logger.warn(
      {
        event: 'whatsapp.reconnect.scheduled',
        connectionState: 'RECONNECTING',
        errorCategory: category,
        reconnectAttempt: attempt,
        delayMs,
        err: error,
      },
      'Reconnection scheduled',
    );

    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.enqueue(async () => {
        if (!this.reconnectAllowed || this.shuttingDown || this.logoutInProgress) {
          return;
        }
        await this.openSocket();
      });
    }, delayMs);
  }

  private fail(
    category: string,
    message: string,
    error: unknown,
    options?: { resetCredentials?: boolean },
  ): void {
    this.reconnectAllowed = false;
    this.clearRetry();
    this.qr = null;
    if (options?.resetCredentials) {
      this.credentialsNeedReset = true;
    }
    const socket = this.socket;
    this.socket = null;
    this.generation += 1;
    if (socket) {
      this.safeEnd(socket);
    }
    this.options.status.markDisconnected({ category, message }, 'ERROR');
    this.options.logger.error(
      {
        event: 'app.unrecoverable',
        connectionState: 'ERROR',
        errorCategory: category,
        reconnectAttempt: this.options.status.snapshot().reconnectAttempts,
        err: error,
      },
      message,
    );
  }

  private trackSave(save: () => Promise<void>): void {
    const task = (async () => {
      try {
        await save();
      } catch (error) {
        if (this.shuttingDown) {
          this.options.logger.error(
            {
              event: 'app.unrecoverable',
              connectionState: this.options.status.snapshot().status,
              errorCategory: 'auth_store',
              err: error,
            },
            'Authentication state could not be saved during shutdown',
          );
          return;
        }
        const message = error instanceof Error ? error.message : 'Authentication state could not be saved.';
        this.fail('auth_store', message, error);
      }
    })();
    this.saves.add(task);
    void task.finally(() => {
      this.saves.delete(task);
    });
  }

  private async flushSaves(): Promise<void> {
    const pending = [...this.saves];
    if (pending.length === 0) {
      return;
    }
    await Promise.allSettled(pending);
  }

  private clearRetry(): void {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }

  private safeEnd(socket: WaSocketLike): void {
    try {
      socket.end(undefined);
    } catch (error) {
      this.options.logger.warn(
        {
          event: 'whatsapp.disconnected',
          connectionState: this.options.status.snapshot().status,
          errorCategory: 'socket',
          err: error,
        },
        'Socket close failed',
      );
    }
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}
