export const RECIPIENT_RESULT_STATES = ['sent', 'failed', 'not_sent', 'unknown'] as const;

export type RecipientResultState = (typeof RECIPIENT_RESULT_STATES)[number];

export interface SentRecipientResult {
  number: string;
  status: 'sent';
  messageId: string;
}

export interface UnsuccessfulRecipientResult {
  number: string;
  status: 'failed' | 'not_sent' | 'unknown';
  errorCode: string;
  error: string;
}

export type RecipientResult = SentRecipientResult | UnsuccessfulRecipientResult;

export interface SendSummary {
  total: number;
  sent: number;
  failed: number;
  notSent: number;
  unknown: number;
}

export interface SendCompletedBody {
  requestId: string;
  status: 'completed';
  summary: SendSummary;
  results: RecipientResult[];
}

export interface SendErrorBody {
  success: false;
  error: {
    code: string;
    message: string;
  };
}

export interface MessagingConfig {
  maxRecipientsPerRequest: number;
  maxMessageLength: number;
  sendDelayMs: number;
  maxSendRequestsPerMinute: number;
  maxOutboundMessagesPerHour: number;
  sendTimeoutMs: number;
  allowAllRecipients: boolean;
  allowedRecipients: readonly string[];
  idempotencyTtlMs: number;
}

export const IDEMPOTENCY_TTL_MS = 10 * 60 * 1000;

export interface OutboundConnection {
  isConnected(): boolean;
  getStatus(): { status: string };
  sendText(recipientJid: string, text: string): Promise<{ messageId: string | null }>;
}

export interface WhatsAppSender {
  sendText(recipientJid: string, text: string): Promise<{ messageId: string | null }>;
}
