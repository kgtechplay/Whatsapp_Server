import type { AccountIdentity } from '../../shared/utils/account.js';

export const CONNECTION_STATES = [
  'INITIALIZING',
  'QR_REQUIRED',
  'CONNECTING',
  'CONNECTED',
  'DISCONNECTED',
  'RECONNECTING',
  'LOGGED_OUT',
  'ERROR',
] as const;

export type ConnectionStateName = (typeof CONNECTION_STATES)[number];

export interface ConnectionErrorInfo {
  category: string;
  message: string;
}

export interface ConnectionStatus {
  status: ConnectionStateName;
  connected: boolean;
  account: AccountIdentity | null;
  lastConnectedAt: string | null;
  lastDisconnectedAt: string | null;
  reconnectAttempts: number;
  lastError: ConnectionErrorInfo | null;
}

export interface QrAvailable {
  kind: 'available';
  status: 'QR_REQUIRED';
  qr: string;
  expiresAt: string | null;
}

export interface QrPending {
  kind: 'pending';
  status: ConnectionStateName;
}

export interface QrNotApplicable {
  kind: 'not-applicable';
  status: ConnectionStateName;
}

export type QrQueryResult = QrAvailable | QrPending | QrNotApplicable;

export interface ConnectResult {
  initiated: boolean;
  status: ConnectionStateName;
  failed: boolean;
  message: string;
}

export interface LogoutResult {
  success: boolean;
  partial: boolean;
  remoteConfirmed: boolean;
  status: ConnectionStateName;
  message: string;
}
