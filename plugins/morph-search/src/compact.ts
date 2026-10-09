import { CompactClient, MorphAPIClient, type CompactInput, type MorphAPIClientOptions, type RequestOptions } from "@morphllm/morphsdk";

// CompactClient lacks a signal argument, but its public transport supports one.
// Bind a transport to this one request; never change global fetch or SDK state.
class CancellableTransport extends MorphAPIClient {
  constructor(options: MorphAPIClientOptions, private readonly signal: AbortSignal) {
    // SDK retry backoff is not abortable. Let pi fall back after a failed attempt.
    super({ ...options, retryConfig: { maxRetries: 0 } });
  }
  override request<T>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
    this.signal.throwIfAborted();
    return super.request<T>(method, path, { ...options, signal: this.signal, timeout: this.timeout });
  }
}

export async function compactWithSignal(options: MorphAPIClientOptions & { timeout: number }, input: CompactInput, signal: AbortSignal) {
  signal.throwIfAborted();
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(new Error("Morph compact timed out")), options.timeout);
  const requestSignal = AbortSignal.any([signal, timeout.signal]);
  try {
    const result = await new CompactClient(new CancellableTransport(options, requestSignal)).compact(input);
    requestSignal.throwIfAborted();
    return result;
  } finally { clearTimeout(timer); }
}
