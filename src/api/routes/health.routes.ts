import { Router } from 'express';
import type { ConnectionStatusService } from '../../core/whatsapp/connection-status.js';

export function createHealthRouter(status: ConnectionStatusService): Router {
  const router = Router();

  router.get('/health', (_req, res) => {
    const uptimeSeconds = Math.floor(process.uptime());
    try {
      status.snapshot();
    } catch {
      res.status(503).json({
        status: 'unavailable',
        service: 'whatsapp-gateway',
        uptimeSeconds,
      });
      return;
    }

    res.status(200).json({
      status: 'ok',
      service: 'whatsapp-gateway',
      uptimeSeconds,
    });
  });

  return router;
}
