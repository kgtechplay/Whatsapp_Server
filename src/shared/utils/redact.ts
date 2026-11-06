const SENSITIVE_KEY =
  /api[-_]?key|authorization|cookie|credential|creds|noisekey|signedidentitykey|signedprekey|advsecretkey|registrationid|pairingcode|pre-?key|session|secret|password|token|^qr$|^keys$|^priv(ate)?$/i;

const SENSITIVE_OWN_PROPERTY = new Set([
  'data',
  'output',
  'payload',
  'stack',
]);

export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY.test(key);
}

export function redactString(value: string, secrets: readonly string[]): string {
  let output = value;
  for (const secret of secrets) {
    if (secret.length < 8) {
      continue;
    }
    if (output.includes(secret)) {
      output = output.split(secret).join('[redacted]');
    }
  }
  return output;
}

export function sanitizeForLog(value: unknown, secrets: readonly string[], depth = 0): unknown {
  if (depth > 6) {
    return '[truncated]';
  }

  if (typeof value === 'string') {
    return redactString(value, secrets);
  }

  if (typeof value === 'number' || typeof value === 'boolean' || value === null || value === undefined) {
    return value;
  }

  if (typeof value === 'bigint') {
    return value.toString();
  }

  if (value instanceof Error) {
    return sanitizeError(value, secrets, depth);
  }

  if (Array.isArray(value)) {
    return value.slice(0, 20).map((entry) => sanitizeForLog(entry, secrets, depth + 1));
  }

  if (typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      output[key] = isSensitiveKey(key) ? '[redacted]' : sanitizeForLog(entry, secrets, depth + 1);
    }
    return output;
  }

  return '[unsupported]';
}

function sanitizeError(error: Error, secrets: readonly string[], depth: number): Record<string, unknown> {
  const output: Record<string, unknown> = {
    name: error.name,
    message: redactString(error.message, secrets),
  };

  const extra = error as Error & Record<string, unknown>;
  if (typeof extra.code === 'string' || typeof extra.code === 'number') {
    output.code = extra.code;
  }

  const statusCode = readStatusCode(extra);
  if (statusCode !== undefined) {
    output.statusCode = statusCode;
  }

  for (const key of Object.keys(extra)) {
    if (SENSITIVE_OWN_PROPERTY.has(key) || key === 'code') {
      continue;
    }
    output[key] = isSensitiveKey(key) ? '[redacted]' : sanitizeForLog(extra[key], secrets, depth + 1);
  }

  return output;
}

function readStatusCode(error: Record<string, unknown>): number | undefined {
  const output = error.output;
  if (!output || typeof output !== 'object') {
    return undefined;
  }
  const statusCode = (output as { statusCode?: unknown }).statusCode;
  return typeof statusCode === 'number' ? statusCode : undefined;
}
