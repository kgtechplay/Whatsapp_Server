import type { Request, Response } from 'express';
import type { ConnectionManager } from '../../core/whatsapp/connection-manager.js';

export function createSessionController(connection: ConnectionManager) {
  return {
    async status(_req: Request, res: Response): Promise<void> {
      res.status(200).json(connection.getStatus());
    },

    async qr(_req: Request, res: Response): Promise<void> {
      const result = connection.getQr();
      if (result.kind === 'not-applicable') {
        res.status(409).json({
          error: 'conflict',
          message: 'Pairing is not applicable in the current connection state.',
          status: result.status,
        });
        return;
      }
      if (result.kind === 'pending') {
        res.status(404).json({
          error: 'not_found',
          message: 'No pairing QR is available.',
          status: result.status,
        });
        return;
      }

      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Pragma', 'no-cache');
      res.status(200).json({
        status: result.status,
        qr: result.qr,
        expiresAt: result.expiresAt,
      });
    },

    async connect(_req: Request, res: Response): Promise<void> {
      const result = await connection.requestConnect();
      if (result.failed) {
        res.status(500).json({
          success: false,
          status: result.status,
          message: result.message,
        });
        return;
      }

      res.status(result.initiated ? 202 : 200).json({
        success: true,
        status: result.status,
        message: result.message,
      });
    },

    async logout(_req: Request, res: Response): Promise<void> {
      const result = await connection.requestLogout();
      if (!result.success) {
        res.status(502).json({
          success: false,
          partial: result.partial,
          remoteConfirmed: result.remoteConfirmed,
          status: result.status,
          message: result.message,
        });
        return;
      }

      res.status(200).json({
        success: true,
        status: result.status,
      });
    },
  };
}
