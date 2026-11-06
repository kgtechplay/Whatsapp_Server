import { createHash, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

export function createApiKeyAuth(apiKey: string) {
  return function apiKeyAuth(req: Request, res: Response, next: NextFunction): void {
    const header = req.header('authorization');
    const match = /^Bearer\s+(\S+)\s*$/i.exec(header ?? '');
    const presented = match?.[1] ?? '';
    if (!presented || !safeEqual(presented, apiKey)) {
      res.status(401).json({
        error: 'unauthorized',
        message: 'Missing or invalid API key',
      });
      return;
    }
    next();
  };
}

function safeEqual(left: string, right: string): boolean {
  const leftDigest = createHash('sha256').update(left).digest();
  const rightDigest = createHash('sha256').update(right).digest();
  return timingSafeEqual(leftDigest, rightDigest);
}
