/**
 * Process-wide admission for live model work.
 *
 * The concurrency ceilings in the plugins were all local: a workflow bounded one
 * run, a subagent bounded its own fleet, and nothing bounded the sum. Four
 * workflow runs with four agents each plus a subagent fleet is sixteen to
 * twenty live child sessions against one provider account, and the failure mode
 * is not a slow run — it is refused calls that surface as failed agents.
 *
 * This module is the one place that decides how many model calls are live at
 * once. Every spawner acquires a ticket first; the ceiling is a provider
 * property, so it is process-wide rather than per run, per plugin or per
 * session. Buckets exist so a future caller can separate providers, but the
 * plugins all use the default bucket: one provider account is the common case,
 * and splitting by model would silently multiply the bound.
 *
 * The controller is deliberately named "admission" rather than "semaphore": a
 * semaphore is a counter, admission is a decision (capacity, cooldown, fairness).
 *
 * On fairness: waiters are grouped by run id and granted round-robin. Without
 * that, a wide `parallel()` panel would fill the queue and starve every other
 * run until it finished, turning a global bound into a global convoy.
 */

export type AdmissionEvent = "succeeded" | "failed" | "throttled";

export interface AdmissionTicket {
  readonly runId: string;
  readonly key: string;
  /** Idempotent: a second release is a no-op, so a caller can release in `finally`. */
  release(): void;
}

export interface AdmissionRequest {
  /** Stable owner of the work; waiters from one run are served in FIFO order. */
  runId: string;
  /** Bucket key. Plugins use `DEFAULT_ADMISSION_KEY`; separate providers may pass their own. */
  key?: string;
  signal?: AbortSignal;
}

export interface AdmissionSnapshot {
  cap: number;
  ceiling: number;
  inFlight: number;
  queued: number;
  cooldownUntil?: number;
  throttled: boolean;
}

export interface Admission {
  acquire(request: AdmissionRequest): Promise<AdmissionTicket>;
  /**
   * Acquire without queueing. Returns undefined when the caller would have to
   * wait, so a latency-sensitive helper call can decide to skip rather than
   * park behind a queue.
   */
  tryAcquire(request: AdmissionRequest): AdmissionTicket | undefined;
  observe(key: string, event: AdmissionEvent, retryAfterMs?: number): void;
  snapshot(key?: string): AdmissionSnapshot;
  /** Reject every waiter and stop timers. Tests only; a live process keeps one controller. */
  dispose(): void;
}

export interface AdmissionOptions {
  /** Provider ceiling. Defaults to `admissionCeiling()`. */
  ceiling?: number;
  now?: () => number;
  /** Injectable so a test can assert the cooldown wake without waiting it out. */
  schedule?: (run: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clearSchedule?: (handle: ReturnType<typeof setTimeout>) => void;
}

/** All plugins share this bucket unless a caller deliberately separates providers. */
export const DEFAULT_ADMISSION_KEY = "provider";

/** How long a throttle can pause admission; a provider's Retry-After can be hours. */
export const MAX_ADMISSION_COOLDOWN_MS = 30_000;

/** Successful calls needed before a throttled cap recovers by one. */
export const ADMISSION_RECOVERY_SUCCESSES = 4;

const DEFAULT_CEILING = 4;
const MAX_CEILING = 32;

/**
 * The provider ceiling for this process.
 *
 * `PI_ADMISSION_MAX_CONCURRENCY` is the new name. `PI_WORKFLOW_MAX_CONCURRENCY`
 * is honoured as a fallback because it documented the same provider tolerance
 * before admission existed; keeping it avoids breaking an installed workspace
 * that already raised the bound. A malformed value falls back to the default
 * rather than disabling the bound.
 */
export function admissionCeiling(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.PI_ADMISSION_MAX_CONCURRENCY ?? env.PI_WORKFLOW_MAX_CONCURRENCY;
  if (raw === undefined || raw.trim() === "") return DEFAULT_CEILING;
  const value = Number(raw.trim());
  if (!Number.isFinite(value) || value < 1) return DEFAULT_CEILING;
  return Math.min(MAX_CEILING, Math.floor(value));
}

interface Waiter {
  runId: string;
  resolve: (ticket: AdmissionTicket) => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

interface Bucket {
  cap: number;
  readonly ceiling: number;
  inFlight: number;
  successes: number;
  cooldownUntil: number;
  /** FIFO per run, so a run's own calls keep their order. */
  readonly queues: Map<string, Waiter[]>;
  lastGrantedRun?: string;
  timer?: ReturnType<typeof setTimeout>;
}

function abortedError(signal: AbortSignal): Error {
  const reason = signal.reason;
  return reason instanceof Error ? reason : new Error("Admission was aborted");
}

function waiterCount(bucket: Bucket): number {
  let total = 0;
  for (const queue of bucket.queues.values()) total += queue.length;
  return total;
}

function nextRunWithWaiters(bucket: Bucket): string | undefined {
  const runs = [...bucket.queues.entries()].filter(([, queue]) => queue.length > 0).map(([runId]) => runId);
  if (runs.length === 0) return undefined;
  const lastIndex = bucket.lastGrantedRun === undefined ? -1 : runs.indexOf(bucket.lastGrantedRun);
  return runs[(lastIndex + 1) % runs.length];
}

export function createAdmission(options: AdmissionOptions = {}): Admission {
  const now = options.now ?? Date.now;
  const schedule = options.schedule ?? ((run, delayMs) => {
    const handle = setTimeout(run, delayMs);
    handle.unref?.();
    return handle;
  });
  const clearSchedule = options.clearSchedule ?? ((handle) => clearTimeout(handle));
  const ceiling = Math.max(1, Math.min(MAX_CEILING, Math.floor(options.ceiling ?? admissionCeiling())));
  const buckets = new Map<string, Bucket>();
  let disposed = false;

  function bucketFor(key: string): Bucket {
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = {
        cap: ceiling,
        ceiling,
        inFlight: 0,
        successes: 0,
        cooldownUntil: 0,
        queues: new Map(),
      };
      buckets.set(key, bucket);
    }
    return bucket;
  }

  function armCooldownWake(bucket: Bucket): void {
    if (bucket.timer) {
      clearSchedule(bucket.timer);
      bucket.timer = undefined;
    }
    if (disposed || waiterCount(bucket) === 0) return;
    const until = bucket.cooldownUntil;
    if (until <= now()) return;
    bucket.timer = schedule(() => {
      bucket.timer = undefined;
      drain(bucket);
    }, Math.max(0, until - now()));
  }

  function grant(bucket: Bucket, waiter: Waiter): void {
    if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
    bucket.inFlight += 1;
    bucket.lastGrantedRun = waiter.runId;
    let released = false;
    waiter.resolve({
      runId: waiter.runId,
      key: DEFAULT_ADMISSION_KEY,
      release() {
        if (released) return;
        released = true;
        bucket.inFlight = Math.max(0, bucket.inFlight - 1);
        drain(bucket);
      },
    });
  }

  function drain(bucket: Bucket): void {
    if (disposed) return;
    if (now() < bucket.cooldownUntil) {
      armCooldownWake(bucket);
      return;
    }
    while (bucket.inFlight < bucket.cap) {
      const runId = nextRunWithWaiters(bucket);
      if (runId === undefined) break;
      const queue = bucket.queues.get(runId);
      if (!queue || queue.length === 0) {
        bucket.queues.delete(runId);
        continue;
      }
      const waiter = queue.shift();
      if (!waiter) break;
      if (queue.length === 0) bucket.queues.delete(runId);
      if (waiter.signal?.aborted) {
        if (waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
        waiter.reject(abortedError(waiter.signal));
        continue;
      }
      grant(bucket, waiter);
    }
    armCooldownWake(bucket);
  }

  function enqueue(bucket: Bucket, request: AdmissionRequest): Promise<AdmissionTicket> {
    const signal = request.signal;
    if (signal?.aborted) return Promise.reject(abortedError(signal));
    return new Promise<AdmissionTicket>((resolve, reject) => {
      const waiter: Waiter = { runId: request.runId, resolve, reject, ...(signal ? { signal } : {}) };
      if (signal) {
        const onAbort = (): void => {
          const queue = bucket.queues.get(request.runId);
          if (queue) {
            const index = queue.indexOf(waiter);
            if (index >= 0) queue.splice(index, 1);
            if (queue.length === 0) bucket.queues.delete(request.runId);
          }
          reject(abortedError(signal));
          drain(bucket);
        };
        waiter.onAbort = onAbort;
        signal.addEventListener("abort", onAbort, { once: true });
      }
      const queue = bucket.queues.get(request.runId) ?? [];
      queue.push(waiter);
      bucket.queues.set(request.runId, queue);
      drain(bucket);
    });
  }

  return {
    acquire(request) {
      if (disposed) return Promise.reject(new Error("Admission is closed"));
      const bucket = bucketFor(request.key ?? DEFAULT_ADMISSION_KEY);
      if (request.signal?.aborted) return Promise.reject(abortedError(request.signal));
      // A waiting run must not be bypassed: otherwise a stream of new arrivals
      // starves the queue while capacity keeps becoming free for them.
      if (waiterCount(bucket) === 0 && now() >= bucket.cooldownUntil && bucket.inFlight < bucket.cap) {
        let released = false;
        bucket.inFlight += 1;
        bucket.lastGrantedRun = request.runId;
        return Promise.resolve({
          runId: request.runId,
          key: request.key ?? DEFAULT_ADMISSION_KEY,
          release() {
            if (released) return;
            released = true;
            bucket.inFlight = Math.max(0, bucket.inFlight - 1);
            drain(bucket);
          },
        });
      }
      return enqueue(bucket, request);
    },

    tryAcquire(request) {
      if (disposed) return undefined;
      const bucket = bucketFor(request.key ?? DEFAULT_ADMISSION_KEY);
      if (request.signal?.aborted) return undefined;
      if (waiterCount(bucket) > 0 || now() < bucket.cooldownUntil || bucket.inFlight >= bucket.cap) return undefined;
      let released = false;
      bucket.inFlight += 1;
      bucket.lastGrantedRun = request.runId;
      return {
        runId: request.runId,
        key: request.key ?? DEFAULT_ADMISSION_KEY,
        release() {
          if (released) return;
          released = true;
          bucket.inFlight = Math.max(0, bucket.inFlight - 1);
          drain(bucket);
        },
      };
    },

    observe(key, event, retryAfterMs) {
      if (disposed) return;
      const bucket = bucketFor(key);
      if (event === "succeeded") {
        if (bucket.cap >= bucket.ceiling) return;
        bucket.successes += 1;
        if (bucket.successes >= ADMISSION_RECOVERY_SUCCESSES && waiterCount(bucket) > 0) {
          bucket.cap = Math.min(bucket.ceiling, bucket.cap + 1);
          bucket.successes = 0;
          drain(bucket);
        }
        return;
      }
      bucket.successes = 0;
      if (event === "throttled") {
        // A throttle is the provider speaking, so the cap is wrong until proven
        // otherwise. A cooldown longer than the bound is not honoured: a far
        // future Retry-After would otherwise stall every run with no error.
        const delay = Math.max(0, Math.min(MAX_ADMISSION_COOLDOWN_MS, retryAfterMs ?? 0));
        bucket.cooldownUntil = Math.max(bucket.cooldownUntil, now() + delay);
        bucket.cap = Math.max(1, Math.floor(bucket.cap * 0.75));
        drain(bucket);
      }
    },

    snapshot(key = DEFAULT_ADMISSION_KEY) {
      const bucket = bucketFor(key);
      return {
        cap: bucket.cap,
        ceiling: bucket.ceiling,
        inFlight: bucket.inFlight,
        queued: waiterCount(bucket),
        ...(bucket.cooldownUntil > now() ? { cooldownUntil: bucket.cooldownUntil } : {}),
        throttled: bucket.cap < bucket.ceiling || bucket.cooldownUntil > now(),
      };
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      for (const bucket of buckets.values()) {
        if (bucket.timer) clearSchedule(bucket.timer);
        bucket.timer = undefined;
        for (const queue of bucket.queues.values()) {
          for (const waiter of queue.splice(0)) {
            if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
            waiter.reject(new Error("Admission is closed"));
          }
        }
        bucket.queues.clear();
      }
    },
  };
}

/**
 * The process-wide controller.
 *
 * Held on `globalThis` under a symbol rather than in a module variable: a
 * workspace can resolve two copies of this package (one per plugin's
 * dependency tree), and two module-level controllers would each believe they
 * own the provider ceiling — the exact multiplication this module exists to
 * remove.
 */
const PROCESS_ADMISSION = Symbol.for("pi.run-core.admission.v1");

interface AdmissionGlobal {
  [PROCESS_ADMISSION]?: Admission;
}

export function processAdmission(env: NodeJS.ProcessEnv = process.env): Admission {
  const store = globalThis as unknown as AdmissionGlobal;
  let admission = store[PROCESS_ADMISSION];
  if (!admission) {
    admission = createAdmission({ ceiling: admissionCeiling(env) });
    store[PROCESS_ADMISSION] = admission;
  }
  return admission;
}

/** Drop the singleton. Tests only: a live process must keep one controller. */
export function resetProcessAdmission(): void {
  const store = globalThis as unknown as AdmissionGlobal;
  store[PROCESS_ADMISSION]?.dispose();
  delete store[PROCESS_ADMISSION];
}

/**
 * Whether a provider error is a concurrency/throttle signal rather than an
 * ordinary failure. Kept here so workflow and subagent cannot drift on which
 * messages lower the cap.
 */
export function isAdmissionThrottle(message: string): boolean {
  return /(?:^|[^0-9])429(?:[^0-9]|$)|rate.?limit|too many requests|concurrency reached|overloaded/i.test(message);
}
