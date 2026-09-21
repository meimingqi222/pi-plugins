/**
 * Blob-hash stores.
 *
 * Two formats are read:
 *
 *   `acemcp-cache`  `~/.acemcp/data/cache/<sha256(absPath)[:16]>.json`
 *                   acemcp's manifest: `{ "<relPath>": { h, m, s, v, c } }`.
 *                   `h` is the chunk-hash array in chunk order, which is how a
 *                   warm client can skip uploads acemcp already paid for.
 *
 *   `pi-ace-index`  this client's own file. Read *and* written, so uploads made
 *                   here stay warm even when acemcp's cache is absent or stale.
 *                   acemcp's file is never written to — two processes sharing
 *                   one manifest with non-atomic writers was one of the
 *                   problems this plugin was written to avoid.
 *
 * acemcp's `filePath → [hash]` shape carries no chunk *names*, so names are
 * reconstructed with the same `#chunk{N}of{TOTAL}` rule the chunker uses. If
 * the file changed since acemcp hashed it, the reconstructed names describe the
 * old split — harmless, because the name/hash pair then disagrees with the
 * freshly computed chunk, so the chunk is reported missing and uploaded. A
 * stale store can cause an extra upload, never a skipped one.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { InventoryEntry } from "./walk.ts";

export type IndexStoreFormat = "acemcp-cache" | "pi-ace-index" | "merged";

export interface BlobHashStore {
  readonly format: IndexStoreFormat;
  readonly path: string;
  readonly hashesByPath: ReadonlyMap<string, string>;
  readonly entryCount: number;
}

/** acemcp's cache path for a normalized project root. */
export function acemcpCachePath(dataDir: string, projectRoot: string): string {
  return join(dataDir, "cache", `${sha256Short(projectRoot)}.json`);
}

/** This client's own index path for a project. */
export function piAceIndexPath(dataDir: string, projectRoot: string): string {
  return join(dataDir, "pi-ace-index", `${sha256Short(projectRoot)}.json`);
}

function sha256Short(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 16);
}

export async function loadBlobHashStore(path: string): Promise<BlobHashStore> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch {
    return emptyStore(path, "acemcp-cache");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return emptyStore(path, "acemcp-cache");
  }

  const record = parsed as Record<string, unknown>;
  const hashesByPath = new Map<string, string>();
  let entryCount = 0;

  if ("entries" in record) {
    const entries = record.entries;
    if (entries && typeof entries === "object" && !Array.isArray(entries)) {
      for (const [filePath, hashes] of Object.entries(entries as Record<string, unknown>)) {
        if (!Array.isArray(hashes)) continue;
        addReconstructedHashes(hashesByPath, filePath, hashes);
        entryCount += 1;
      }
    }
    return { format: "pi-ace-index", path, hashesByPath, entryCount };
  }

  for (const [filePath, meta] of Object.entries(record)) {
    if (!meta || typeof meta !== "object") continue;
    const hashes = (meta as { h?: unknown }).h;
    if (!Array.isArray(hashes)) continue;
    addReconstructedHashes(hashesByPath, filePath, hashes);
    entryCount += 1;
  }
  return { format: "acemcp-cache", path, hashesByPath, entryCount };
}

function addReconstructedHashes(
  target: Map<string, string>,
  filePath: string,
  hashes: readonly unknown[],
): void {
  const strings = hashes.filter((hash): hash is string => typeof hash === "string");
  if (strings.length === 0) return;
  if (strings.length === 1) {
    target.set(filePath, strings[0]!);
    return;
  }
  const total = strings.length;
  for (let index = 0; index < total; index += 1) {
    target.set(`${filePath}#chunk${index + 1}of${total}`, strings[index]!);
  }
}

function emptyStore(path: string, format: IndexStoreFormat): BlobHashStore {
  return { format, path, hashesByPath: new Map(), entryCount: 0 };
}

/**
 * Combine several stores into one, without ever turning a "present" answer into
 * a "missing" one.
 *
 * This exists because a single store cannot be authoritative. `acemcp`'s cache
 * is a snapshot taken by another process and is not updated when this client
 * uploads a new or changed file, while this client's own index only knows about
 * the runs it has performed itself. Either one alone is therefore guaranteed to
 * be stale in some situation.
 *
 * Two earlier approaches were wrong, and the second one was actively harmful:
 *
 *   1. Pick the first non-empty store. If `acemcp`'s cache exists at all, this
 *      client's index is never read, so a file uploaded by this client is
 *      reported missing on every later run and re-uploaded forever.
 *   2. Pick the store with more entries. The counts differ by a handful even
 *      when the *sets* differ in exactly the files that changed, so the larger
 *      store wins and the newer file is still missed. Entry count is not
 *      evidence of freshness.
 *
 * Merging is the only rule that holds for both: a name is warm if *any* store
 * has that name with that hash. A name present in two stores with different
 * hashes is dropped, because the disagreement means one of them describes an
 * older revision of the file — and re-uploading is always safe, whereas
 * skipping an upload is not.
 */
export function mergeHashStores(stores: readonly BlobHashStore[]): BlobHashStore {
  const present = stores.filter((store) => store.entryCount > 0);
  if (present.length === 0) {
    // Report the first candidate's own format rather than "merged": it names
    // the file that was consulted, and no store contributed anything anyway.
    const first = stores[0];
    return first ? emptyStore(first.path, first.format) : emptyStore("", "merged");
  }
  if (present.length === 1) {
    const only = present[0]!;
    return { ...only, hashesByPath: new Map(only.hashesByPath) };
  }

  // A name seen twice with different hashes is recorded as conflicted and left
  // out of the result, so the caller re-uploads it instead of trusting a store
  // that may predate an edit.
  const merged = new Map<string, string>();
  const conflicted = new Set<string>();
  for (const store of present) {
    for (const [name, hash] of store.hashesByPath) {
      if (conflicted.has(name)) continue;
      const existing = merged.get(name);
      if (existing === undefined) {
        merged.set(name, hash);
      } else if (existing !== hash) {
        merged.delete(name);
        conflicted.add(name);
      }
    }
  }

  return {
    format: "merged",
    path: present.map((store) => store.path).join(","),
    hashesByPath: merged,
    // Counted as distinct files, matching `loadBlobHashStore`, so the two
    // numbers are comparable.
    entryCount: countFiles(merged),
  };
}

/** Distinct file paths behind a name→hash map (`path` or `path#chunkNofM`). */
function countFiles(hashesByPath: ReadonlyMap<string, string>): number {
  const files = new Set<string>();
  for (const name of hashesByPath.keys()) {
    const marker = name.indexOf("#chunk");
    files.add(marker === -1 ? name : name.slice(0, marker));
  }
  return files.size;
}

export interface PersistPiAceIndexOptions {
  readonly path: string;
  readonly projectRoot: string;
  readonly entries: readonly InventoryEntry[];
  readonly source: IndexStoreFormat;
}

export async function persistPiAceIndex(options: PersistPiAceIndexOptions): Promise<void> {
  // `entries` maps a *file* to all of its chunk hashes. Writing it keyed by
  // chunk *name* would lose the file→chunks relationship, and the reader
  // reconstructs names from the array, so the array must be in chunk order.
  const entries: Record<string, readonly string[]> = {};
  for (const entry of options.entries) {
    entries[entry.filePath] = entry.chunks.map((chunk) => chunk.hash);
  }
  const payload = JSON.stringify(
    {
      version: 1,
      projectRoot: options.projectRoot,
      updatedAt: new Date().toISOString(),
      source: options.source,
      entries,
    },
    null,
    2,
  );
  // Atomic replace: a crash mid-write must not leave a truncated index that the
  // next run parses as "no hashes" and then re-uploads the whole project.
  const temporaryPath = `${options.path}.tmp`;
  await mkdir(dirname(options.path), { recursive: true });
  await writeFile(temporaryPath, payload, "utf8");
  await rename(temporaryPath, options.path);
}
