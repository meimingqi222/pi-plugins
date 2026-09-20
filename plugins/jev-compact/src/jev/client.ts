/**
 * Vendored from `fast-jev-compaction` v0.2.0 (MIT, tamaratran). See ATTRIBUTION.md.
 */

import { buildJevRequest, parseJevResponse } from './request.ts';
import type { AskOptions, JevAsker, JevQuestions, JevResponse, JevState } from './types.ts';

export interface JevClientOptions {
  /** Defaults to `process.env.TYPESAFE_API_KEY`. */
  apiKey?: string;
  /** Defaults to `jev-latest`. */
  model?: string;
  /** Defaults to the System One endpoint. */
  baseUrl?: string;
  /** Defaults to the global `fetch`. */
  fetch?: typeof fetch;
  /** Per-request timeout in ms. Defaults to 120s; `0` disables it. */
  timeoutMs?: number;
}

/**
 * Per-request timeout. A window of state plus its questions is a large upload,
 * so this is generous — but it must exist. Without one a stalled connection
 * hangs the compaction forever, and pi has no timeout of its own on the hook.
 */
const DEFAULT_TIMEOUT_MS = 120_000;

/** Asks Jev over HTTP with the global `fetch` (or an injected one). */
export class JevClient implements JevAsker {
  private readonly apiKey: string;
  private readonly model: string | undefined;
  private readonly baseUrl: string | undefined;
  private readonly fetcher: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: JevClientOptions = {}) {
    this.apiKey = options.apiKey ?? process.env.TYPESAFE_API_KEY ?? '';
    this.model = options.model;
    this.baseUrl = options.baseUrl;
    this.fetcher = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async ask(
    state: JevState,
    questions: JevQuestions,
    options: AskOptions = {},
  ): Promise<JevResponse> {
    if (!this.apiKey) throw new Error('TYPESAFE_API_KEY is not configured');
    const request = buildJevRequest(
      { apiKey: this.apiKey, model: this.model, baseUrl: this.baseUrl },
      state,
      questions,
    );
    // Combine the caller's signal (pi's compaction cancellation) with this
    // client's timeout, so either can stop the request. A long session issues
    // several of these; cancelling must not leave them all in flight.
    const signal = combineSignals(options.signal, this.timeoutMs);
    const response = await this.fetcher(request.url, {
      method: request.method,
      headers: request.headers,
      body: request.body,
      ...(signal ? { signal } : {}),
    });
    return parseJevResponse(response.status, response.ok, await response.text());
  }
}

/**
 * Merges an optional caller signal with a timeout into one signal, or returns
 * undefined when neither applies. `AbortSignal.any` is the direct way; the
 * manual fallback keeps this working on runtimes without it.
 */
function combineSignals(
  caller: AbortSignal | undefined,
  timeoutMs: number,
): AbortSignal | undefined {
  const timeout =
    timeoutMs > 0 && typeof AbortSignal.timeout === 'function'
      ? AbortSignal.timeout(timeoutMs)
      : undefined;
  if (!caller) return timeout;
  if (!timeout) return caller;
  if (typeof AbortSignal.any === 'function') return AbortSignal.any([caller, timeout]);
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  if (caller.aborted || timeout.aborted) abort();
  else {
    caller.addEventListener('abort', abort, { once: true });
    timeout.addEventListener('abort', abort, { once: true });
  }
  return controller.signal;
}
