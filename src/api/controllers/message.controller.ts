import type { Request, Response } from 'express';
import type { AppLogger } from '../../config/logger.js';
import type { MessagingConfig } from '../../core/messaging/messaging.types.js';
import { MessageSender, MessagingHttpError } from '../../core/messaging/message-sender.js';
import { parseSendRequest } from '../validators/send-message.schema.js';

const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{1,200}$/;

export function createMessageController(sender: MessageSender, config: MessagingConfig, logger: AppLogger) {
  return {
    async send(req: Request, res: Response): Promise<void> {
      const rawKey = req.get('Idempotency-Key');
      if (rawKey !== undefined && !IDEMPOTENCY_KEY.test(rawKey.trim())) {
        res.status(400).json({
          success: false,
          error: {
            code: 'INVALID_REQUEST',
            message: 'Idempotency-Key must be 1-200 characters and use letters, numbers, dot, underscore, colon, or hyphen.',
          },
        });
        return;
      }

      const parsed = parseSendRequest(req.body, config);
      if (!parsed.ok) {
        res.status(400).json({
          success: false,
          error: {
            code: parsed.error.code,
            message: parsed.error.message,
          },
        });
        return;
      }

      try {
        const result = await sender.send({
          recipients: parsed.value.recipients,
          message: parsed.value.message,
          idempotencyKey: rawKey?.trim(),
        });
        res.status(result.httpStatus).json(result.body);
      } catch (error) {
        if (error instanceof MessagingHttpError) {
          res.status(error.statusCode).json({
            success: false,
            error: {
              code: error.errorCode,
              message: error.message,
            },
          });
          return;
        }
        logger.error(
          {
            event: 'message.send.failed',
            operation: 'message.send',
            errorCategory: 'INTERNAL_ERROR',
            err: error,
          },
          'Outbound message send failed',
        );
        res.status(500).json({
          success: false,
          error: {
            code: 'INTERNAL_ERROR',
            message: 'The message could not be processed.',
          },
        });
      }
    },
  };
}
