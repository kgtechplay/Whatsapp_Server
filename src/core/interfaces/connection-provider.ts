import type { ConnectionStatus } from '../whatsapp/whatsapp.types.js';

/**
 * Future messaging, automation, and agent integrations should depend on this
 * provider instead of constructing Baileys sockets themselves.
 * Phase 1 does not implement message routing.
 */
export interface WhatsAppConnectionProvider {
  isConnected(): boolean;
  getStatus(): ConnectionStatus;
  connect(): Promise<void>;
  logout(): Promise<void>;
}
