/**
 * Numeric values match Baileys DisconnectReason in 6.7.x.
 * They are duplicated here so retry policy tests do not need a live socket.
 */
export const DisconnectCode = {
  connectionClosed: 428,
  connectionLost: 408,
  connectionReplaced: 440,
  timedOut: 408,
  loggedOut: 401,
  badSession: 500,
  restartRequired: 515,
  multideviceMismatch: 411,
  forbidden: 403,
  unavailableService: 503,
} as const;

export interface ReconnectPolicy {
  initialDelayMs: number;
  maxDelayMs: number;
  multiplier: number;
  jitterRatio: number;
}

export const DEFAULT_RECONNECT_MULTIPLIER = 2;
export const DEFAULT_JITTER_RATIO = 0.2;

export interface DisconnectDecision {
  recoverable: boolean;
  resetCredentials: boolean;
  state: 'RECONNECTING' | 'DISCONNECTED' | 'LOGGED_OUT' | 'ERROR';
  category: string;
  message: string;
}

export function computeReconnectDelay(
  attempt: number,
  policy: ReconnectPolicy,
  random: () => number = Math.random,
): number {
  const safeAttempt = Number.isFinite(attempt) && attempt > 0 ? Math.floor(attempt) : 1;
  const exponent = safeAttempt - 1;
  const exponential = Math.min(policy.maxDelayMs, policy.initialDelayMs * policy.multiplier ** exponent);
  const sample = clamp01(random());
  const jittered = exponential + (sample * 2 - 1) * exponential * policy.jitterRatio;
  const clamped = Math.min(policy.maxDelayMs, Math.max(0, jittered));
  return Math.round(clamped);
}

export function classifyDisconnect(statusCode: number | undefined): DisconnectDecision {
  if (statusCode === DisconnectCode.loggedOut) {
    return {
      recoverable: false,
      resetCredentials: false,
      state: 'LOGGED_OUT',
      category: 'logged_out',
      message: 'WhatsApp session was logged out.',
    };
  }

  if (statusCode === DisconnectCode.badSession || statusCode === DisconnectCode.multideviceMismatch) {
    return {
      recoverable: false,
      resetCredentials: true,
      state: 'ERROR',
      category: 'credentials_invalid',
      message: 'WhatsApp rejected the saved session. Pair again with POST /api/session/connect.',
    };
  }

  if (statusCode === DisconnectCode.restartRequired) {
    return {
      recoverable: true,
      resetCredentials: false,
      state: 'RECONNECTING',
      category: 'restart_required',
      message: 'WhatsApp requested a connection restart.',
    };
  }

  if (statusCode === DisconnectCode.connectionReplaced) {
    return {
      recoverable: true,
      resetCredentials: false,
      state: 'RECONNECTING',
      category: 'connection_replaced',
      message: 'The WhatsApp connection was replaced.',
    };
  }

  if (statusCode === DisconnectCode.unavailableService) {
    return {
      recoverable: true,
      resetCredentials: false,
      state: 'RECONNECTING',
      category: 'service_unavailable',
      message: 'WhatsApp service was unavailable.',
    };
  }

  if (statusCode === DisconnectCode.forbidden) {
    return {
      recoverable: true,
      resetCredentials: false,
      state: 'RECONNECTING',
      category: 'forbidden',
      message: 'WhatsApp refused the connection.',
    };
  }

  if (
    statusCode === undefined ||
    statusCode === DisconnectCode.connectionClosed ||
    statusCode === DisconnectCode.connectionLost ||
    statusCode === DisconnectCode.timedOut
  ) {
    return {
      recoverable: true,
      resetCredentials: false,
      state: 'RECONNECTING',
      category: 'network',
      message: 'WhatsApp connection closed.',
    };
  }

  return {
    recoverable: true,
    resetCredentials: false,
    state: 'RECONNECTING',
    category: 'unknown_disconnect',
    message: 'WhatsApp connection closed.',
  };
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) {
    return 0.5;
  }
  if (value < 0) {
    return 0;
  }
  if (value > 1) {
    return 1;
  }
  return value;
}
