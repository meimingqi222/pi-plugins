/**
 * Search orchestration: hash → upload what is missing → retrieve.
 *
 * The phase timings returned here exist because the original problem was
 * indistinguishable from a hang. acemcp prints nothing until the whole search
 * returns, so a 69s upload followed by a 35s index wait looked like a dead
 * process. Every phase is reported separately and progress is streamed through
 * `onProgress`, so a slow run is always attributable.
 */

import { createAceClient, isFatalAceError, type AceClient, type BlobUpload } from "./client.ts";
import { type AceSearchConfig } from "./config.ts";
import {
  acemcpCachePath,
  loadBlobHashStore,
  mergeHashStores,
  persistPiAceIndex,
  piAceIndexPath,
  type BlobHashStore,
} from "./index-store.ts";
import { buildBlobInventory, type BlobInventory } from "./walk.ts";

export interface AceSearchPhase {
  readonly phase: "hash" | "upload" | "wait" | "retrieve";
  readonly durationMs: number;
  readonly detail: string;
}

export interface AceSearchResult {
  /** Raw `formatted_retrieval` payload from the server. */
  readonly text: string;
  readonly projectRoot: string;
  readonly query: string;
  readonly phases: readonly AceSearchPhase[];
  readonly totalDurationMs: number;
  readonly indexFormat: string;
  readonly indexEntryCount: number;
  readonly includedFiles: number;
  readonly skippedFiles: number;
  readonly blobCount: number;
  readonly uploadedChunks: number;
  readonly indexWaitMs: number;
}

export interface AceSearchProgress {
  (event: { readonly phase: string; readonly message: string }): void;
}

interface UploadOutcome {
  readonly uploadedChunks: number;
  readonly failedBatches: number;
}

export interface RunAceSearchOptions {
  readonly projectRoot: string;
  readonly query: string;
  readonly config: AceSearchConfig;
  readonly signal?: AbortSignal;
  readonly onProgress?: AceSearchProgress;
  /**
   * Skip the `/find-missing` poll and retrieve immediately.
   *
   * The poll is what made acemcp feel hung: 60s of blocking waits on the
   * critical path, and even a "mostly indexed" exit needs three stable polls.
   * Retrieval against a partially indexed project already works, so waiting is
   * opt-in rather than default.
   */
  readonly waitForIndex?: boolean;
  readonly maxIndexWaitMs?: number;
  readonly client?: AceClient;
}

const DEFAULT_MAX_INDEX_WAIT_MS = 30_000;

export async function runAceSearch(options: RunAceSearchOptions): Promise<AceSearchResult> {
  const { projectRoot, query, config } = options;
  const signal = options.signal ?? new AbortController().signal;
  const progress = options.onProgress ?? (() => {});
  const client = options.client ?? createAceClient({ baseUrl: config.baseUrl, token: config.token });
  const phases: AceSearchPhase[] = [];
  const totalStartedAt = Date.now();

  progress({ phase: "hash", message: `Hashing ${projectRoot}` });
  const startedAt = Date.now();
  const store = await resolveHashStore(config, projectRoot);
  // Hashing happens once here; the store is already in memory, so nothing
  // downstream may re-read or re-walk the workspace.
  const inventory = await buildBlobInventory({
    projectRoot,
    config,
    hashesByPath: store.hashesByPath,
    signal,
  });
  phases.push({
    phase: "hash",
    durationMs: Date.now() - startedAt,
    detail: `${inventory.includedFiles} files, ${inventory.names.length} blobs (store: ${store.format})`,
  });

  let uploadedChunks = 0;
  if (inventory.missing.length === 0) {
    progress({ phase: "upload", message: "Index is warm; nothing to upload" });
  } else {
    progress({
      phase: "upload",
      message: `Uploading ${inventory.missing.length} of ${inventory.names.length} blobs`,
    });
    const uploadStartedAt = Date.now();
    const outcome = await uploadChunks(client, inventory, config, signal, progress);
    uploadedChunks = outcome.uploadedChunks;
    phases.push({
      phase: "upload",
      durationMs: Date.now() - uploadStartedAt,
      detail: `${uploadedChunks} chunks in batches of ${config.batchSize}, concurrency ${config.concurrency}${outcome.failedBatches > 0 ? `, ${outcome.failedBatches} batches failed` : ""}`,
    });
    // Only a fully successful upload may be recorded.
    //
    // Persisting a partially failed run would write the hashes of chunks that
    // never reached the server, and every later run would read them back as
    // "already present" and skip the upload again — the index would be
    // permanently wrong until the file changed. Skipping the write keeps the
    // previous index, so the next run retries exactly what failed.
    if (outcome.failedBatches === 0) {
      await persistPiAceIndex({
        path: piAceIndexPath(config.dataDir, projectRoot),
        projectRoot,
        entries: inventory.entries,
        source: store.format,
      }).catch(() => undefined);
    } else {
      progress({
        phase: "upload",
        message: `${outcome.failedBatches} batches failed; index left unchanged so they are retried`,
      });
    }
  }

  let indexWaitMs = 0;
  if (options.waitForIndex === true && uploadedChunks > 0) {
    progress({ phase: "wait", message: "Waiting for the server to index new blobs" });
    const waitStartedAt = Date.now();
    // Hashes, not names: `/find-missing` keys on hash even though
    // `/batch-upload` keys on name.
    const outcome = await waitForIndexed(
      client,
      inventory.hashes,
      signal,
      options.maxIndexWaitMs ?? DEFAULT_MAX_INDEX_WAIT_MS,
      progress,
    );
    indexWaitMs = Date.now() - waitStartedAt;
    phases.push({ phase: "wait", durationMs: indexWaitMs, detail: outcome });
  }

  progress({ phase: "retrieve", message: "Retrieving code context" });
  const retrieveStartedAt = Date.now();
  const text = await client.search(
    { informationRequest: query, addedBlobs: inventory.hashes, deletedBlobs: [] },
    signal,
  );
  phases.push({
    phase: "retrieve",
    durationMs: Date.now() - retrieveStartedAt,
    detail: `${inventory.hashes.length} blob hashes against ${config.baseUrl}`,
  });

  return {
    text,
    projectRoot,
    query,
    phases,
    totalDurationMs: Date.now() - totalStartedAt,
    indexFormat: store.format,
    indexEntryCount: store.entryCount,
    includedFiles: inventory.includedFiles,
    skippedFiles: inventory.skippedFiles,
    blobCount: inventory.names.length,
    uploadedChunks,
    indexWaitMs,
  };
}

/**
 * Prefer acemcp's cache so a project acemcp already indexed needs no upload.
 * Fall back to this client's own index, then to an explicit override.
 */
async function resolveHashStore(
  config: AceSearchConfig,
  projectRoot: string,
): Promise<BlobHashStore> {
  const candidates = [
    config.indexPath,
    acemcpCachePath(config.dataDir, projectRoot),
    piAceIndexPath(config.dataDir, projectRoot),
  ].filter((path) => path.length > 0);

  // Every candidate is read and merged, not ranked.
  //
  // Ranking by "first non-empty" hid this client's own index behind acemcp's
  // cache forever, so a file this client uploaded was re-uploaded on every
  // later run. Ranking by entry count was no better: the counts differ by a
  // few entries even when the differing entries are exactly the changed files.
  // See `mergeHashStores` for why a union is the only rule that is safe for
  // both writers.
  const stores = await Promise.all(candidates.map((path) => loadBlobHashStore(path)));
  return mergeHashStores(stores);
}

async function uploadChunks(
  client: AceClient,
  inventory: BlobInventory,
  config: AceSearchConfig,
  signal: AbortSignal,
  progress: AceSearchProgress,
): Promise<UploadOutcome> {
  const batches: { blobs: BlobUpload[]; size: number }[] = [];
  for (let index = 0; index < inventory.missing.length; index += config.batchSize) {
    const slice = inventory.missing.slice(index, index + config.batchSize);
    batches.push({
      blobs: slice.map((chunk) => ({ path: chunk.name, content: chunk.content })),
      size: slice.length,
    });
  }

  let completed = 0;
  let failedBatches = 0;
  let uploadedChunks = 0;
  const total = batches.length;

  // A small worker pool instead of spawning one promise per batch: a file
  // created with thousands of chunks should not open thousands of sockets.
  let cursor = 0;
  const workers = Array.from({ length: Math.min(config.concurrency, total) }, async () => {
    while (true) {
      signal.throwIfAborted();
      const index = cursor;
      cursor += 1;
      if (index >= total) return;
      const batch = batches[index]!;
      try {
        await client.uploadBlobs(batch.blobs, signal);
      } catch (error) {
        // An auth failure will repeat for every batch, so stop the whole run
        // rather than uploading nothing and reporting success.
        if (isFatalAceError(error)) throw error;
        // Retries are already exhausted inside the client; losing one batch
        // must not abort the run, because retrieval still improves with the
        // chunks that did land. It must, however, stop the index from being
        // persisted as if it had landed.
        failedBatches += 1;
        progress({
          phase: "upload",
          message: `Batch ${index + 1}/${total} failed: ${(error as Error).message}`,
        });
        continue;
      }
      completed += 1;
      uploadedChunks += batch.size;
      if (completed % 10 === 0 || completed === total) {
        progress({ phase: "upload", message: `${completed}/${total} batches` });
      }
    }
  });

  await Promise.all(workers);
  return { uploadedChunks, failedBatches };
}

async function waitForIndexed(
  client: AceClient,
  hashes: readonly string[],
  signal: AbortSignal,
  budgetMs: number,
  progress: AceSearchProgress,
): Promise<string> {
  const startedAt = Date.now();
  let pending = Number.POSITIVE_INFINITY;
  while (Date.now() - startedAt < budgetMs) {
    signal.throwIfAborted();
    let result;
    try {
      result = await client.findMissing(hashes, signal);
    } catch (error) {
      return `poll failed: ${(error as Error).message}`;
    }
    pending = result.pending.length + result.unknown.length;
    if (pending === 0) return `indexed after ${Date.now() - startedAt}ms`;
    progress({ phase: "wait", message: `${pending} blobs still indexing` });
    await sleep(1_000, signal);
  }
  return `gave up after ${budgetMs}ms with ${pending} blobs pending`;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error("aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
