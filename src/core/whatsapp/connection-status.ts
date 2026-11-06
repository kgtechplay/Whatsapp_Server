import type { AccountIdentity } from '../../shared/utils/account.js';
import type { ConnectionErrorInfo, ConnectionStateName, ConnectionStatus } from './whatsapp.types.js';

export class ConnectionStatusService {
  private state: ConnectionStateName = 'INITIALIZING';
  private account: AccountIdentity | null = null;
  private lastConnectedAt: string | null = null;
  private lastDisconnectedAt: string | null = null;
  private reconnectAttempts = 0;
  private lastError: ConnectionErrorInfo | null = null;
  private functional = true;

  snapshot(): ConnectionStatus {
    if (!this.functional) {
      throw new Error('Status manager is unavailable.');
    }

    return {
      status: this.state,
      connected: this.state === 'CONNECTED',
      account: this.account ? { ...this.account } : null,
      lastConnectedAt: this.lastConnectedAt,
      lastDisconnectedAt: this.lastDisconnectedAt,
      reconnectAttempts: this.reconnectAttempts,
      lastError: this.lastError ? { ...this.lastError } : null,
    };
  }

  mark(state: Exclude<ConnectionStateName, 'CONNECTED'>): void {
    this.state = state;
  }

  /**
   * CONNECTED is only entered from a live socket open event.
   * Saved credentials alone must never flip this flag.
   */
  markConnected(account: AccountIdentity | null, at: Date = new Date()): void {
    this.state = 'CONNECTED';
    this.account = account;
    this.lastConnectedAt = at.toISOString();
    this.reconnectAttempts = 0;
    this.lastError = null;
  }

  markDisconnected(error: ConnectionErrorInfo, state: 'DISCONNECTED' | 'RECONNECTING' | 'LOGGED_OUT' | 'ERROR', at: Date = new Date()): void {
    this.state = state;
    this.lastDisconnectedAt = at.toISOString();
    this.lastError = { ...error };
    if (state === 'LOGGED_OUT' || state === 'ERROR') {
      this.account = null;
    }
    if (state === 'LOGGED_OUT') {
      this.reconnectAttempts = 0;
    }
  }

  incrementReconnectAttempts(): number {
    this.reconnectAttempts += 1;
    return this.reconnectAttempts;
  }

  resetReconnectAttempts(): void {
    this.reconnectAttempts = 0;
  }

  clearAccount(): void {
    this.account = null;
  }

  markUnavailable(): void {
    this.functional = false;
  }
}
