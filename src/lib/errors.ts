/** Typed error hierarchy. Every thrown error in this system is one of these. */

export class AppError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly retryable: boolean = false,
    readonly detail: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/** Raised before a metered operation when the budget is already spent. */
export class BudgetExceededError extends AppError {
  constructor(
    readonly budgetKind: 'LLM' | 'SEARCH' | 'EMAIL_DAILY' | 'CAMPAIGNS_WEEKLY',
    readonly spent: number,
    readonly limit: number,
  ) {
    super(
      `${budgetKind} budget exceeded: ${spent} of ${limit}`,
      'BUDGET_EXCEEDED',
      false,
      { budgetKind, spent, limit },
    );
  }
}

/** Raised when code attempts an edge that is not in the state machine table. */
export class IllegalTransitionError extends AppError {
  constructor(from: string, to: string, reason?: string) {
    super(
      `Illegal state transition ${from} -> ${to}${reason ? ` (${reason})` : ''}`,
      'ILLEGAL_TRANSITION',
      false,
      { from, to, reason },
    );
  }
}

/** Raised when a safety switch forbids the attempted action. */
export class SafetyError extends AppError {
  constructor(message: string, detail: Record<string, unknown> = {}) {
    super(message, 'SAFETY_BLOCKED', false, detail);
  }
}

export class ConfigError extends AppError {
  constructor(message: string) {
    super(message, 'CONFIG_INVALID', false);
  }
}

export class FetchError extends AppError {
  constructor(message: string, readonly status?: number, retryable = true) {
    super(message, 'FETCH_FAILED', retryable, { status });
  }
}

export class ProviderError extends AppError {
  constructor(provider: string, message: string, retryable = true) {
    super(`[${provider}] ${message}`, 'PROVIDER_FAILED', retryable, { provider });
  }
}

export function isRetryable(err: unknown): boolean {
  return err instanceof AppError ? err.retryable : false;
}
