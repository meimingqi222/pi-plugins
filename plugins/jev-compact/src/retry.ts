/**
 * Retry wrapper for Jev asks.
 *
 * Observed failure this exists for: a Jev request intermittently failed with
 * `unknown certificate verification error` (a transport/TLS fault), while
 * eight immediate retries of the same request all returned HTTP 200. Without a
 * retry, one such blip makes `compact()` throw, and the plugin falls back to
 * pi's built-in summary — i.e. a transient network hiccup silently downgrades
 * the *quality* of the next context window rather than merely delaying it.
 *
 * The classification is deliberately narrow: only transport faults and the
 * statuses that mean "try again" are retried. A schema violation (`missing
 * answers`, `Invalid Jev answer`) is a contract problem that a retry does not
 * fix, so it fails fast instead of burning backoff.
 *
 * This file is not vendored from `fast-jev-compaction`; it is ours.
 */

import type {
  AskOptions,
  JevAsker,
  JevQuestions,
  JevResponse,
  JevState,
} from './jev/types.ts';

export interface RetryOptions {
  /** Total attempts including the first. Default 4 (one try + three retries). */
  maxAttempts?: number;
  /** First backoff, in ms. Doubles per retry. Default 300. */
  baseDelayMs?: number;
  /** Backoff ceiling, in ms. Default 4000. */
  maxDelayMs?: number;
  /** Injected for tests, so they never wait on a real timer. */
  sleep?: (ms: number) => Promise<void>;
  /** Called just before each retry, for a user-visible notice. */
  onRetry?: (info: {
    /** The attempt that just failed, 1-based. */
    attempt: number;
    /** Total attempts allowed, including the first. */
    maxAttempts: number;
    /** Backoff about to be applied, in ms. */
    delayMs: number;
    error: Error;
  }) => void;
}

/** Statuses that mean the request may succeed if repeated. */
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

/**
 * Transport-fault signatures. Node surfaces the real reason in `error.cause`,
 * so callers should classify the whole chain, not just the top message.
 */
const RETRYABLE_PATTERNS = [
  /certificate/i,
  /unable to verify/i,
  /\bECONNRESET\b/,
  /\bECONNREFUSED\b/,
  /\bETIMEDOUT\b/,
  /\bENOTFOUND\b/,
  /\bEAI_AGAIN\b/,
  /\bEPIPE\b/,
  /\bEHOSTUNREACH\b/,
  /\bENETUNREACH\b/,
  /\bUND_ERR\w*/,
  /fetch failed/i,
  /socket hang up/i,
  /other side closed/i,
  /premature close/i,
  /network error/i,
  /malformed JSON/i,
];

/** Flattens an error and its `cause` chain into one searchable string. */
export function errorText(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 8 && current !== undefined && current !== null; depth += 1) {
    if (current instanceof Error) {
      parts.push(current.message);
      current = (current as { cause?: unknown }).cause;
    } else {
      parts.push(String(current));
      break;
    }
  }
  return parts.join(' | ');
}

/**
 * True when repeating the ask could plausibly succeed.
 *
 * An HTTP status in the message wins: `Jev request failed (401)` is a
 * credential problem and must not be retried, even though the text also
 * happens to match nothing else.
 */
export function isRetryableJevError(error: unknown): boolean {
  const text = errorText(error);
  const status = /Jev request failed \((\d{3})\)/.exec(text);
  if (status) return RETRYABLE_STATUS.has(Number(status[1]));
  return RETRYABLE_PATTERNS.some((re) => re.test(text));
}

/**
 * True when the error is a deliberate cancellation rather than a fault.
 *
 * A cancelled request must not be retried — the caller asked to stop, and
 * retrying would keep issuing requests (each carrying a full window of state)
 * for a result that is about to be discarded. Matched on the name, because
 * `AbortError` is what both `fetch` and `AbortSignal` produce.
 */
export function isAbortError(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 8 && current !== null && current !== undefined; depth += 1) {
    if (current instanceof Error) {
      if (current.name === 'AbortError' || current.name === 'TimeoutError') return true;
      current = (current as { cause?: unknown }).cause;
    } else break;
  }
  return /\baborted?\b/i.test(errorText(error));
}

/**
 * Wraps an asker so transport faults and 429/5xx are retried with exponential
 * backoff. Jev asks are read-only probability questions, so repeating one is
 * safe. A cancellation is passed straight through: see `isAbortError`.
 */
export function withRetry(asker: JevAsker, options: RetryOptions = {}): JevAsker {
  const maxAttempts = Math.max(1, Math.floor(options.maxAttempts ?? 4));
  const baseDelayMs = Math.max(0, options.baseDelayMs ?? 300);
  const maxDelayMs = Math.max(0, options.maxDelayMs ?? 4000);
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  return {
    async ask(
      state: JevState,
      questions: JevQuestions,
      askOptions: AskOptions = {},
    ): Promise<JevResponse> {
      let lastError: Error = new Error('Jev ask failed without an error');
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
          return await asker.ask(state, questions, askOptions);
        } catch (err) {
          lastError = err instanceof Error ? err : new Error(String(err));
          if (isAbortError(err)) throw lastError;
          if (askOptions.signal?.aborted) throw lastError;
          if (attempt === maxAttempts || !isRetryableJevError(err)) throw lastError;
          const delayMs = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
          try {
            options.onRetry?.({ attempt, maxAttempts, delayMs, error: lastError });
          } catch {
            // A failing notifier must not break the retry.
          }
          await sleep(delayMs);
        }
      }
      throw lastError;
    },
  };
}
