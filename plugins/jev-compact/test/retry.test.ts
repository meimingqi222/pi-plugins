/**
 * Tests for the Jev retry wrapper.
 *
 * The bug this guards: a Jev request intermittently failed with
 * `unknown certificate verification error` while eight immediate repeats all
 * returned HTTP 200. With no retry, one such blip makes `compact()` throw and
 * the extension falls back to pi's built-in summary — a transient network
 * fault silently lowers the *quality* of the next context window.
 *
 * The other half is equally important: a 401 or a schema violation must NOT be
 * retried. Retrying a bad key or a contract break just burns backoff before
 * failing anyway, and it hides a real configuration error behind "transient".
 */

import { describe, expect, test } from 'bun:test';

import { errorText, isRetryableJevError, withRetry } from '../src/retry.ts';
import type { JevAsker, JevResponse } from '../src/jev/types.ts';
import { compact } from '../src/jev/compact.ts';
import { fakeJev } from './fake-jev.ts';

/** An asker that fails the first `failures` calls, then succeeds. */
function flaky(
  failures: number,
  error: () => Error,
): { asker: JevAsker; attempts: () => number } {
  let calls = 0;
  return {
    attempts: () => calls,
    asker: {
      async ask(): Promise<JevResponse> {
        calls += 1;
        if (calls <= failures) throw error();
        return { answers: { q: { type: 'noul', noul: 0.9 } } };
      },
    },
  };
}

/** Records sleeps instead of waiting, so tests are instant. */
function collectingSleep(): { sleep: (ms: number) => Promise<void>; delays: number[] } {
  const delays: number[] = [];
  return {
    delays,
    sleep: async (ms: number) => {
      delays.push(ms);
    },
  };
}

describe('isRetryableJevError', () => {
  test('a TLS certificate fault is retryable', () => {
    const err = new Error('unknown certificate verification error');
    expect(isRetryableJevError(err)).toBe(true);
  });

  test('a certificate fault nested in cause is retryable', () => {
    // Node puts the real reason in `cause`; classifying only the top message
    // would miss exactly the failure that motivated this file.
    const cause = new Error('unable to verify the first certificate');
    const err = new Error('fetch failed');
    (err as { cause?: unknown }).cause = cause;
    expect(isRetryableJevError(err)).toBe(true);
  });

  test('common transport errno codes are retryable', () => {
    for (const code of [
      'ECONNRESET',
      'ECONNREFUSED',
      'ETIMEDOUT',
      'ENOTFOUND',
      'EAI_AGAIN',
      'EPIPE',
      'EHOSTUNREACH',
      'ENETUNREACH',
    ]) {
      expect(isRetryableJevError(new Error(`connect ${code} 1.2.3.4:443`))).toBe(true);
    }
  });

  test('rate limit and server errors are retryable', () => {
    for (const status of [408, 425, 429, 500, 502, 503, 504]) {
      expect(isRetryableJevError(new Error(`Jev request failed (${status}): body`))).toBe(true);
    }
  });

  test('client errors are not retryable', () => {
    for (const status of [400, 401, 403, 404, 422]) {
      expect(isRetryableJevError(new Error(`Jev request failed (${status}): body`))).toBe(false);
    }
  });

  test('a schema violation is not retryable', () => {
    expect(isRetryableJevError(new Error('Jev response is missing answers'))).toBe(false);
    expect(isRetryableJevError(new Error('Invalid Jev answer for call_t1'))).toBe(false);
    expect(isRetryableJevError(new Error('TYPESAFE_API_KEY is not configured'))).toBe(false);
  });

  test('malformed JSON is retryable (a truncated response body)', () => {
    expect(isRetryableJevError(new Error('Jev returned malformed JSON'))).toBe(true);
  });

  test('an HTTP status wins over unrelated transport-looking text', () => {
    // 401 carries no transport phrase, and must not be retried.
    expect(isRetryableJevError(new Error('Jev request failed (401): fetch failed'))).toBe(false);
  });

  test('a non-Error value is handled', () => {
    expect(isRetryableJevError('fetch failed')).toBe(true);
    expect(isRetryableJevError(undefined)).toBe(false);
  });
});

describe('errorText', () => {
  test('walks the cause chain', () => {
    const root = new Error('ENOTFOUND api.typesafe.ai');
    const mid = new Error('socket hang up');
    (mid as { cause?: unknown }).cause = root;
    const top = new Error('fetch failed');
    (top as { cause?: unknown }).cause = mid;
    const text = errorText(top);
    expect(text).toContain('fetch failed');
    expect(text).toContain('socket hang up');
    expect(text).toContain('ENOTFOUND');
  });

  test('survives a self-referential cause without hanging', () => {
    const err = new Error('loop');
    (err as { cause?: unknown }).cause = err;
    expect(() => errorText(err)).not.toThrow();
  });
});

describe('withRetry', () => {
  test('a transient failure is retried and the call succeeds', async () => {
    const { asker, attempts } = flaky(1, () => new Error('unknown certificate verification error'));
    const { sleep, delays } = collectingSleep();
    const wrapped = withRetry(asker, { sleep, baseDelayMs: 300 });

    const result = await wrapped.ask({}, { q: { type: 'noul', instructions: 'x' } });
    expect(result.answers.q).toEqual({ type: 'noul', noul: 0.9 });
    expect(attempts()).toBe(2);
    expect(delays).toEqual([300]);
  });

  test('repeated transient failures back off exponentially', async () => {
    const { asker, attempts } = flaky(3, () => new Error('fetch failed'));
    const { sleep, delays } = collectingSleep();
    const wrapped = withRetry(asker, { sleep, baseDelayMs: 100, maxAttempts: 4 });

    await wrapped.ask({}, { q: { type: 'noul', instructions: 'x' } });
    expect(attempts()).toBe(4);
    expect(delays).toEqual([100, 200, 400]);
  });

  test('backoff is capped at maxDelayMs', async () => {
    const { asker } = flaky(4, () => new Error('fetch failed'));
    const { sleep, delays } = collectingSleep();
    const wrapped = withRetry(asker, {
      sleep,
      baseDelayMs: 1000,
      maxDelayMs: 1500,
      maxAttempts: 5,
    });

    await wrapped.ask({}, { q: { type: 'noul', instructions: 'x' } });
    expect(delays).toEqual([1000, 1500, 1500, 1500]);
  });

  test('a non-retryable error fails immediately, without sleeping', async () => {
    const { asker, attempts } = flaky(10, () => new Error('Jev request failed (401): bad key'));
    const { sleep, delays } = collectingSleep();
    const wrapped = withRetry(asker, { sleep, baseDelayMs: 100 });

    await expect(wrapped.ask({}, { q: { type: 'noul', instructions: 'x' } })).rejects.toThrow(
      /401/,
    );
    expect(attempts()).toBe(1);
    expect(delays).toEqual([]);
  });

  test('a schema violation fails immediately', async () => {
    const { asker, attempts } = flaky(10, () => new Error('Invalid Jev answer for call_t1'));
    const { sleep } = collectingSleep();
    const wrapped = withRetry(asker, { sleep });
    await expect(wrapped.ask({}, { q: { type: 'noul', instructions: 'x' } })).rejects.toThrow(
      /Invalid Jev answer/,
    );
    expect(attempts()).toBe(1);
  });

  test('exhausting every attempt rethrows the last error', async () => {
    const { asker, attempts } = flaky(99, () => new Error('ETIMEDOUT'));
    const { sleep } = collectingSleep();
    const wrapped = withRetry(asker, { sleep, maxAttempts: 3, baseDelayMs: 1 });
    await expect(wrapped.ask({}, { q: { type: 'noul', instructions: 'x' } })).rejects.toThrow(
      /ETIMEDOUT/,
    );
    expect(attempts()).toBe(3);
  });

  test('a success on the first try never retries', async () => {
    const { asker, attempts } = flaky(0, () => new Error('never'));
    const { sleep, delays } = collectingSleep();
    const wrapped = withRetry(asker, { sleep });
    await wrapped.ask({}, { q: { type: 'noul', instructions: 'x' } });
    expect(attempts()).toBe(1);
    expect(delays).toEqual([]);
  });

  test('onRetry is told which attempt failed and how long it will wait', async () => {
    const { asker } = flaky(2, () => new Error('fetch failed'));
    const { sleep } = collectingSleep();
    const seen: Array<{ attempt: number; delayMs: number }> = [];
    const wrapped = withRetry(asker, {
      sleep,
      baseDelayMs: 50,
      onRetry: ({ attempt, delayMs }) => seen.push({ attempt, delayMs }),
    });

    await wrapped.ask({}, { q: { type: 'noul', instructions: 'x' } });
    expect(seen).toEqual([
      { attempt: 1, delayMs: 50 },
      { attempt: 2, delayMs: 100 },
    ]);
  });

  test('a throwing onRetry does not break the retry', async () => {
    const { asker, attempts } = flaky(1, () => new Error('fetch failed'));
    const { sleep } = collectingSleep();
    const wrapped = withRetry(asker, {
      sleep,
      onRetry: () => {
        throw new Error('notification failed');
      },
    });
    const result = await wrapped.ask({}, { q: { type: 'noul', instructions: 'x' } });
    expect(result.answers.q).toBeDefined();
    expect(attempts()).toBe(2);
  });

  test('maxAttempts is floored to at least one', async () => {
    const { asker, attempts } = flaky(1, () => new Error('fetch failed'));
    const { sleep } = collectingSleep();
    const wrapped = withRetry(asker, { sleep, maxAttempts: 0 });
    await expect(wrapped.ask({}, { q: { type: 'noul', instructions: 'x' } })).rejects.toThrow();
    expect(attempts()).toBe(1);
  });

  test('it composes with the engine: one blip does not fail a real compaction', async () => {
    // The real integration: every question is answerable, but the transport
    // throws once first. Without withRetry the whole `compact()` would throw
    // and the plugin would fall back to pi's summary.
    const inner = fakeJev({}, { defaultAnswer: 0 });
    let calls = 0;
    const blipping: JevAsker = {
      async ask(state, questions) {
        calls += 1;
        if (calls === 1) throw new Error('unknown certificate verification error');
        return inner.ask(state, questions);
      },
    };
    const { sleep } = collectingSleep();
    const client = withRetry(blipping, { sleep, baseDelayMs: 1 });

    const messages = [
      { role: 'user' as const, text: 'go', toolUses: [] },
      {
        role: 'assistant' as const,
        text: '',
        toolUses: [{ tool_use_id: 'a', tool: 'read', input: {}, text: 'output'.repeat(100) }],
        toolResults: [{ tool_use_id: 'a', text: 'output'.repeat(100) }],
      },
    ];
    const result = await compact(messages, client, { preserveRecentMessages: 0 });

    // The blip cost one extra transport attempt and nothing else.
    expect(calls).toBe(2);
    expect(result.stats.callsDropped).toBe(1);
  });
});
