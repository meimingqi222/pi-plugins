/**
 * ACE (Augment Code Engine) retrieval API client.
 *
 * Wire format is fixed by the server; the four endpoints below are what
 * `acemcp-go` calls, and the payload shapes were copied from
 * `internal/scanner/scanner.go` so both clients address the same server-side
 * index for a given project.
 *
 * Two differences from acemcp worth naming, because they are the reason this
 * client exists:
 *
 *   1. Every request takes an `AbortSignal`. acemcp builds its upload requests
 *      with `http.NewRequest` (no context), so a cancelled search keeps
 *      uploading; here a cancel actually stops the network.
 *   2. Timeouts are per request and driven by the caller instead of a blanket
 *      `http.Client{Timeout: 60s}` plus `time.Sleep` retry backoff that ignores
 *      cancellation.
 */

export interface AceClientOptions {
  readonly baseUrl: string;
  readonly token: string;
  /** Per-attempt timeout for a single HTTP request. */
  readonly requestTimeoutMs?: number;
  readonly maxAttempts?: number;
  readonly fetchImpl?: typeof fetch;
}

/**
 * A blob's identity depends on the endpoint, and getting this wrong is a 400:
 *
 *   `/batch-upload`                `path`    the blob name (`a.ts#chunk1of2`)
 *   `/find-missing`                hash      `sha256(chunkName + chunkContent)`
 *   `/agents/codebase-retrieval`   hash      same
 *
 * `search()` therefore takes hashes; `uploadBlobs()` takes names. This mirrors
 * `acemcp-go`, which sends `meta.Hashes` to retrieval and `chunk.ChunkPath` to
 * upload (`internal/scanner/scanner.go`).
 */
export interface BlobUpload {
  /** `path` / `path#chunk2of5`, matching acemcp's chunk naming. */
  readonly path: string;
  readonly content: string;
}

export interface FindMissingResult {
  /** Hashes the server has never seen. */
  readonly unknown: readonly string[];
  /** Hashes the server knows but has not finished indexing. */
  readonly pending: readonly string[];
}

export class AceApiError extends Error {
  readonly status: number;
  readonly body: string;

  constructor(status: number, body: string) {
    super(`ACE request failed (HTTP ${status}): ${body.slice(0, 500)}`);
    this.name = "AceApiError";
    this.status = status;
    this.body = body;
  }
}

/** 401 means the token is wrong, which no amount of retrying fixes. */
export function isFatalAceError(error: unknown): boolean {
  return error instanceof AceApiError && (error.status === 401 || error.status === 403);
}

const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_ATTEMPTS = 3;

export interface AceClient {
  /** Uploads chunk *bodies*, keyed by blob name. */
  uploadBlobs(blobs: readonly BlobUpload[], signal: AbortSignal): Promise<void>;
  /** Checks indexing state by blob *hash*. */
  findMissing(hashes: readonly string[], signal: AbortSignal): Promise<FindMissingResult>;
  /**
   * Ask the server for code context.
   *
   * `addedBlobs` and `deletedBlobs` are blob *hashes* and are sent on every
   * call. acemcp does the same, which makes the request self-describing — the
   * server reconciles whatever it has against the set the client claims.
   */
  search(input: AceSearchRequest, signal: AbortSignal): Promise<string>;
}

export interface AceSearchRequest {
  readonly informationRequest: string;
  /** Chunk hashes currently present in the workspace. */
  readonly addedBlobs: readonly string[];
  /** Chunk hashes that were present before and are now gone. */
  readonly deletedBlobs: readonly string[];
  readonly maxOutputLength?: number;
}

export function createAceClient(options: AceClientOptions): AceClient {
  const baseUrl = options.baseUrl.replace(/\/+$/, "");
  const token = options.token;
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const fetchImpl = options.fetchImpl ?? fetch;

  async function post(
    path: string,
    body: unknown,
    signal: AbortSignal,
    timeoutMs = requestTimeoutMs,
  ): Promise<unknown> {
    const url = `${baseUrl}/${path}`;
    const payload = JSON.stringify(body);
    let lastError: unknown;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      signal.throwIfAborted();
      const attemptSignal = combineWithTimeout(signal, timeoutMs);
      try {
        const response = await fetchImpl(url, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: payload,
          signal: attemptSignal.signal,
        });
        if (!response.ok) {
          const text = await response.text().catch(() => "");
          const error = new AceApiError(response.status, text);
          // A 4xx that is not rate limiting will not succeed on retry.
          if (response.status >= 400 && response.status < 500 && response.status !== 429) {
            throw error;
          }
          lastError = error;
        } else {
          const text = await response.text();
          return text ? JSON.parse(text) : {};
        }
      } catch (error) {
        if (signal.aborted) throw signal.reason ?? new Error("aborted");
        if (isFatalAceError(error)) throw error;
        lastError = error;
      } finally {
        attemptSignal.dispose();
      }
      if (attempt < maxAttempts) await sleepForAttempt(attempt, signal);
    }

    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  return {
    async uploadBlobs(blobs, signal) {
      if (blobs.length === 0) return;
      await post("batch-upload", { blobs }, signal);
    },

    async findMissing(hashes, signal) {
      if (hashes.length === 0) return { unknown: [], pending: [] };
      const result = (await post("find-missing", { mem_object_names: hashes }, signal)) as {
        unknown_memory_names?: unknown;
        nonindexed_blob_names?: unknown;
      };
      return {
        unknown: toStringArray(result?.unknown_memory_names),
        pending: toStringArray(result?.nonindexed_blob_names),
      };
    },

    async search(input, signal) {
      const response = (await post(
        "agents/codebase-retrieval",
        {
          information_request: input.informationRequest,
          blobs: {
            checkpoint_id: null,
            added_blobs: [...input.addedBlobs],
            deleted_blobs: [...input.deletedBlobs],
          },
          dialog: [],
          max_output_length: input.maxOutputLength ?? 0,
          disable_codebase_retrieval: false,
          enable_commit_retrieval: false,
        },
        signal,
        // A cold server-side index takes several seconds even when the client
        // side is warm; 6.3s was measured on a warm run for a 4.4k-file repo.
        120_000,
      )) as { formatted_retrieval?: unknown };
      const formatted = typeof response?.formatted_retrieval === "string" ? response.formatted_retrieval : "";
      return formatted || "No relevant code context found.";
    },
  };
}

function toStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

interface CombinedSignal {
  readonly signal: AbortSignal;
  dispose(): void;
}

/**
 * `AbortSignal.timeout` cannot be unref'd or cancelled, so an abandoned attempt
 * would keep its timer alive. Composing a controller and clearing the timer
 * keeps a fast search from holding the event loop open.
 */
function combineWithTimeout(signal: AbortSignal, timeoutMs: number): CombinedSignal {
  const controller = new AbortController();
  const onAbort = () => controller.abort(signal.reason ?? new Error("aborted"));
  if (signal.aborted) onAbort();
  else signal.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error(`request timed out after ${timeoutMs}ms`)), timeoutMs);
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    },
  };
}

/** Cancel-aware backoff: an abort during the wait returns immediately. */
function sleepForAttempt(attempt: number, signal: AbortSignal): Promise<void> {
  const delayMs = Math.min(250 * 2 ** (attempt - 1), 2_000);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error("aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
