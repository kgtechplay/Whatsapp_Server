export class AppError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(message: string, statusCode: number, code: string) {
    super(message);
    this.name = new.target.name;
    this.statusCode = statusCode;
    this.code = code;
  }
}

export class ConfigError extends AppError {
  constructor(message: string) {
    super(message, 500, 'config');
  }
}

export class OperationConflictError extends AppError {
  constructor(message: string) {
    super(message, 409, 'conflict');
  }
}

export type AuthStoreFailureReason = 'corrupt' | 'unreadable' | 'write';

export class AuthStoreError extends AppError {
  readonly reason: AuthStoreFailureReason;

  constructor(message: string, reason: AuthStoreFailureReason) {
    super(message, 500, 'auth_store');
    this.reason = reason;
  }
}
