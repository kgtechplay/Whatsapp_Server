import type { NextFunction, Request, Response } from 'express';

export interface RateLimitOptions {
  windowMs: number;
  max: number;
  now?: () => number;
}

export function createRateLimiter(options: RateLimitOptions) {
  const buckets = new Map<string, number[]>();

  return function rateLimit(req: Request, res: Response, next: NextFunction): void {
    const now = options.now ? options.now() : Date.now();
    const key = req.ip || req.socket.remoteAddress || 'unknown';
    const current = buckets.get(key) ?? [];
    const recent = current.filter((timestamp) => now - timestamp < options.windowMs);

    if (recent.length >= options.max) {
      const oldest = recent[0] ?? now;
      const retryAfterSeconds = Math.max(1, Math.ceil((oldest + options.windowMs - now) / 1000));
      res.setHeader('Retry-After', String(retryAfterSeconds));
      res.status(429).json({
        error: 'rate_limited',
        message: 'Too many requests',
      });
      buckets.set(key, recent);
      return;
    }

    recent.push(now);
    buckets.set(key, recent);
    next();
  };
}
