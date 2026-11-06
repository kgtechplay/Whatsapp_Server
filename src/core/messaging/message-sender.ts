import { createHash, randomBytes } from 'node:crypto';
import type { AppLogger } from '../../config/logger.js';
import { WhatsAppSendError } from '../whatsapp/connection-manager.js';
import { IdempotencyStore } from './idempotency-store.js';
import type { MessagingConfig, OutboundConnection, SendCompletedBody, RecipientResult } from './messaging.types.js';
import { maskPhoneNumber, toWhatsAppJid } from './recipient-validator.js';
import { SendCoordinator } from './send-coordinator.js';
export class MessagingHttpError extends Error {
  readonly statusCode: number;
  readonly errorCode: string;

  constructor(statusCode: number, errorCode: string, message: string) {
    super(message);
    this.name = 'MessagingHttpError';
    this.statusCode = statusCode;
    this.errorCode = errorCode;
  }
}

export interface MessageSenderDependencies {
  connection: OutboundConnection;
  config: MessagingConfig;
  logger: AppLogger;
  coordinator: SendCoordinator;
  idempotency: IdempotencyStore;
  now?: () => number;
}

export interface SendCommand {
  recipients: string[];
  message: string;
  idempotencyKey?: string | undefined;
}

export interface SendCommandResult {
  httpStatus: number;
  body: SendCompletedBody;
}

export class MessageSender {
  private readonly now: () => number;

  constructor(private readonly dependencies: MessageSenderDependencies) {
    this.now = dependencies.now ?? Date.now;
  }

  async send(command: SendCommand): Promise<SendCommandResult> {
    const idempotencyKey = command.idempotencyKey?.trim() || undefined;
    const fingerprint = fingerprintPayload(command.recipients, command.message);
    if (idempotencyKey) {
      const decision = this.dependencies.idempotency.begin(idempotencyKey, fingerprint);
      if (decision.action === 'replay') {
        return { httpStatus: 200, body: decision.response };
      }
      if (decision.action === 'in_progress') {
        throw new MessagingHttpError(409, 'REQUEST_IN_PROGRESS', 'A request with this Idempotency-Key is still running.');
      }
      if (decision.action === 'conflict') {
        throw new MessagingHttpError(
          409,
          'IDEMPOTENCY_CONFLICT',
          'This Idempotency-Key was already used with a different request.',
        );
      }
    }

    if (!this.dependencies.connection.isConnected()) {
      if (idempotencyKey) {
        this.dependencies.idempotency.abandon(idempotencyKey);
      }
      throw new MessagingHttpError(503, 'WHATSAPP_DISCONNECTED', 'WhatsApp is not currently connected');
    }

    const requestId = createRequestId();
    const startedAt = this.now();
    let attempted = 0;
    try {
      const admission = await this.dependencies.coordinator.run(command.recipients.length, async (slot) => {
        const results: RecipientResult[] = [];
        for (let index = 0; index < command.recipients.length; index += 1) {
          const number = command.recipients[index];
          if (!number) {
            throw new Error('Recipient list was missing an entry.');
          }
          if (!this.dependencies.connection.isConnected()) {
            results.push(...unattempted(command.recipients.slice(index), 'WHATSAPP_DISCONNECTED', 'WhatsApp is not currently connected'));
            break;
          }

          await slot.pace();
          if (!this.dependencies.connection.isConnected()) {
            results.push(...unattempted(command.recipients.slice(index), 'WHATSAPP_DISCONNECTED', 'WhatsApp is not currently connected'));
            break;
          }

          slot.markAttempted();
          attempted += 1;
          const outcome = await raceSend(
            this.dependencies.connection.sendText(toWhatsAppJid(number), command.message),
            this.dependencies.config.sendTimeoutMs,
          );

          if (outcome.kind === 'timeout') {
            slot.holdUntilSettled(outcome.pending);
            results.push(unknownResult(number, 'SEND_TIMEOUT', 'Send outcome could not be determined before the timeout.'));
            results.push(
              ...unattempted(
                command.recipients.slice(index + 1),
                'SEND_TIMEOUT',
                'Not sent because an earlier send outcome is still unresolved.',
              ),
            );
            break;
          }

          if (outcome.kind === 'error') {
            const disconnected = outcome.error instanceof WhatsAppSendError || !this.dependencies.connection.isConnected();
            if (disconnected) {
              results.push(unknownResult(number, 'WHATSAPP_DISCONNECTED', 'The connection closed while the send was in progress.'));
              results.push(
                ...unattempted(
                  command.recipients.slice(index + 1),
                  'WHATSAPP_DISCONNECTED',
                  'WhatsApp is not currently connected',
                ),
              );
              break;
            }
            results.push({
              number,
              status: 'failed',
              errorCode: 'SEND_FAILED',
              error: 'Unable to submit message',
            });
            continue;
          }

          if (!outcome.value.messageId) {
            results.push(unknownResult(number, 'SEND_FAILED', 'The send completed without a message id.'));
            continue;
          }

          results.push({
            number,
            status: 'sent',
            messageId: outcome.value.messageId,
          });
        }
        return results;
      });

      if (!admission.accepted) {
        if (idempotencyKey) {
          this.dependencies.idempotency.abandon(idempotencyKey);
        }
        if (admission.reason === 'rate_limited') {
          throw new MessagingHttpError(429, 'RATE_LIMIT_EXCEEDED', 'Sending rate limit exceeded.');
        }
        throw new MessagingHttpError(
          503,
          'SEND_TIMEOUT',
          'A previous send is still unresolved. New sends are paused until it finishes.',
        );
      }

      const body = toCompletedBody(requestId, admission.value);
      if (attempted === 0 && body.results.every((result) => result.status === 'not_sent')) {
        if (idempotencyKey) {
          this.dependencies.idempotency.abandon(idempotencyKey);
        }
        throw new MessagingHttpError(503, 'WHATSAPP_DISCONNECTED', 'WhatsApp is not currently connected');
      }
      if (idempotencyKey) {
        this.dependencies.idempotency.complete(idempotencyKey, body);
      }
      this.logCompleted(body, attempted, startedAt);
      return { httpStatus: 200, body };
    } catch (error) {
      if (idempotencyKey) {
        this.dependencies.idempotency.abandon(idempotencyKey);
      }
      throw error;
    }
  }

  private logCompleted(body: SendCompletedBody, attempted: number, startedAt: number): void {
    this.dependencies.logger.info(
      {
        event: 'message.send.completed',
        requestId: body.requestId,
        operation: 'message.send',
        connectionState: this.dependencies.connection.getStatus().status,
        recipientCount: body.summary.total,
        recipientsMasked: body.results.map((result) => maskPhoneNumber(result.number)),
        attemptedRecipientCount: attempted,
        sent: body.summary.sent,
        failed: body.summary.failed,
        notSent: body.summary.notSent,
        unknown: body.summary.unknown,
        durationMs: Math.max(0, this.now() - startedAt),
        errorCategory: body.summary.sent === body.summary.total ? undefined : 'send',
      },
      'Outbound message send completed',
    );
  }
}

export function createRequestId(): string {
  return `req_${randomBytes(8).toString('hex')}`;
}

export function fingerprintPayload(recipients: readonly string[], message: string): string {
  return createHash('sha256').update(JSON.stringify({ recipients, message })).digest('hex');
}

function toCompletedBody(requestId: string, results: RecipientResult[]): SendCompletedBody {
  return {
    requestId,
    status: 'completed',
    summary: {
      total: results.length,
      sent: results.filter((result) => result.status === 'sent').length,
      failed: results.filter((result) => result.status === 'failed').length,
      notSent: results.filter((result) => result.status === 'not_sent').length,
      unknown: results.filter((result) => result.status === 'unknown').length,
    },
    results,
  };
}

function unattempted(numbers: readonly string[], errorCode: string, error: string): RecipientResult[] {
  return numbers.map((number) => ({
    number,
    status: 'not_sent' as const,
    errorCode,
    error,
  }));
}

function unknownResult(number: string, errorCode: string, error: string): RecipientResult {
  return { number, status: 'unknown', errorCode, error };
}

async function raceSend(
  work: Promise<{ messageId: string | null }>,
  timeoutMs: number,
): Promise<
  | { kind: 'done'; value: { messageId: string | null } }
  | { kind: 'error'; error: unknown }
  | { kind: 'timeout'; pending: Promise<void> }
> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<{ kind: 'timeout' }>((resolve) => {
    timer = setTimeout(() => resolve({ kind: 'timeout' }), timeoutMs);
  });
  try {
    const settled = work.then(
      (value) => ({ kind: 'done' as const, value }),
      (error: unknown) => ({ kind: 'error' as const, error }),
    );
    const winner = await Promise.race([settled, timeout]);
    if (winner.kind === 'timeout') {
      return {
        kind: 'timeout',
        pending: settled.then(
          () => undefined,
          () => undefined,
        ),
      };
    }
    return winner;
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}
