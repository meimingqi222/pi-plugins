import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acemcpCachePath,
  loadBlobHashStore,
  mergeHashStores,
  persistPiAceIndex,
  piAceIndexPath,
  type BlobHashStore,
  type IndexStoreFormat,
} from "../src/index-store.ts";
import type { InventoryEntry } from "../src/walk.ts";

async function temporaryDirectory(): Promise<string> {
  return mkdtemp(join(tmpdir(), "pi-ace-search-"));
}

describe("cache path", () => {
  test("matches acemcp's sha256(absPath)[:16] scheme", () => {
    // Pin the scheme against a value computed independently of the
    // implementation, so a change to the digest or the slice length fails here.
    const projectRoot = "/example/project";
    const expectedDigest = createHash("sha256").update(projectRoot, "utf8").digest("hex").slice(0, 16);
    expect(acemcpCachePath("/data", projectRoot)).toBe(`/data/cache/${expectedDigest}.json`);
  });

  test("the same project root always maps to the same cache file", () => {
    expect(acemcpCachePath("/data", "/example/project")).toBe(
      acemcpCachePath("/data", "/example/project"),
    );
    expect(acemcpCachePath("/data", "/example/project")).not.toBe(
      acemcpCachePath("/data", "/example/other"),
    );
  });

  test("this client's own index lives beside, not on top of, acemcp's", () => {
    const mine = piAceIndexPath("/data", "/proj");
    // Different directory ⇒ the two writers can never collide, which is the
    // whole point: this client does not write acemcp's manifest.
    expect(mine).toContain("/data/pi-ace-index/");
    expect(mine).not.toBe(acemcpCachePath("/data", "/proj"));
    expect(acemcpCachePath("/data", "/proj")).toContain("/data/cache/");
  });
});

describe("loadBlobHashStore", () => {
  test("reads acemcp's { h: [...] } manifest and reconstructs chunk names", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "cache.json");
    await writeFile(
      path,
      JSON.stringify({
        "single.ts": { h: ["hash-single"], m: 1, s: 10, v: true, c: 1 },
        "multi.ts": { h: ["h1", "h2", "h3"], m: 1, s: 10, v: true, c: 3 },
        "invalid.ts": { h: ["hx"], v: false },
        "no-hashes.ts": { v: true },
      }),
    );

    const store = await loadBlobHashStore(path);

    expect(store.format).toBe("acemcp-cache");
    expect(store.entryCount).toBe(3);
    expect(store.hashesByPath.get("single.ts")).toBe("hash-single");
    expect(store.hashesByPath.get("multi.ts#chunk1of3")).toBe("h1");
    expect(store.hashesByPath.get("multi.ts#chunk3of3")).toBe("h3");
    // A file with a single hash must NOT get a `#chunk1of1` suffix: acemcp
    // omits the suffix entirely for unsplit files.
    expect(store.hashesByPath.has("single.ts#chunk1of1")).toBe(false);
    expect(store.hashesByPath.has("no-hashes.ts")).toBe(false);
  });

  test("reads its own `entries` format", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "index.json");
    await writeFile(path, JSON.stringify({ version: 1, entries: { "a.ts": ["h1", "h2"] } }));

    const store = await loadBlobHashStore(path);

    expect(store.format).toBe("pi-ace-index");
    expect(store.entryCount).toBe(1);
    expect(store.hashesByPath.get("a.ts#chunk2of2")).toBe("h2");
  });

  test("a missing or corrupt file yields an empty store rather than throwing", async () => {
    const directory = await temporaryDirectory();
    const missing = await loadBlobHashStore(join(directory, "nope.json"));
    expect(missing.entryCount).toBe(0);
    expect(missing.hashesByPath.size).toBe(0);

    const corruptPath = join(directory, "corrupt.json");
    await writeFile(corruptPath, "{ this is not json");
    const corrupt = await loadBlobHashStore(corruptPath);
    expect(corrupt.entryCount).toBe(0);
  });

  test("a JSON array at the root does not masquerade as a manifest", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "array.json");
    await writeFile(path, JSON.stringify(["a", "b"]));
    const store = await loadBlobHashStore(path);
    expect(store.entryCount).toBe(0);
  });
});

describe("persistPiAceIndex", () => {
  test("round-trips through the entries format", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "index.json");
    // One file, two chunks: the persisted form is file → [chunkHashes] in
    // chunk order, which the loader re-expands into `#chunk{N}of{total}` names.
    const entries: InventoryEntry[] = [
      {
        filePath: "a.ts",
        chunks: [
          { name: "a.ts#chunk1of2", filePath: "a.ts", content: "x", hash: "ha" },
          { name: "a.ts#chunk2of2", filePath: "a.ts", content: "y", hash: "hb" },
        ],
      },
    ];

    await persistPiAceIndex({ path, projectRoot: "/p", entries, source: "acemcp-cache" });

    const store = await loadBlobHashStore(path);
    expect(store.format).toBe("pi-ace-index");
    expect(store.entryCount).toBe(1);
    expect(store.hashesByPath.get("a.ts#chunk1of2")).toBe("ha");
    expect(store.hashesByPath.get("a.ts#chunk2of2")).toBe("hb");
  });

  test("a single-chunk file is stored without a chunk suffix", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "index.json");
    await persistPiAceIndex({
      path,
      projectRoot: "/p",
      entries: [
        { filePath: "a.ts", chunks: [{ name: "a.ts", filePath: "a.ts", content: "x", hash: "ha" }] },
      ],
      source: "pi-ace-index",
    });

    const store = await loadBlobHashStore(path);
    expect(store.hashesByPath.get("a.ts")).toBe("ha");
    expect(store.hashesByPath.has("a.ts#chunk1of1")).toBe(false);
  });

  test("writes atomically and leaves no temporary file behind", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "index.json");
    await persistPiAceIndex({ path, projectRoot: "/p", entries: [], source: "pi-ace-index" });

    expect(JSON.parse(await readFile(path, "utf8")).entries).toEqual({});
    const leftover = await readFile(`${path}.tmp`, "utf8").catch(() => null);
    // A leftover `.tmp` means a previous crash; here the rename must have
    // consumed it, which is what makes a torn index impossible.
    expect(leftover).toBeNull();
  });

  test("re-writes replace the previous index rather than merging stale entries", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "index.json");
    const first: InventoryEntry[] = [
      { filePath: "gone.ts", chunks: [{ name: "gone.ts", filePath: "gone.ts", content: "x", hash: "h1" }] },
    ];
    await persistPiAceIndex({ path, projectRoot: "/p", entries: first, source: "pi-ace-index" });
    await persistPiAceIndex({ path, projectRoot: "/p", entries: [], source: "pi-ace-index" });

    const store = await loadBlobHashStore(path);
    expect(store.entryCount).toBe(0);
  });
});

describe("mergeHashStores", () => {
  const store = (format: IndexStoreFormat, entries: Record<string, string>): BlobHashStore => ({
    format,
    path: `${format}.json`,
    hashesByPath: new Map(Object.entries(entries)),
    entryCount: new Set(
      Object.keys(entries).map((name) => name.split("#chunk")[0]!),
    ).size,
  });

  test("a name known to only one store is still warm", () => {
    // The bug this replaces: ranking stores meant the non-winning store's
    // entries were discarded, so its files were re-uploaded every run.
    const merged = mergeHashStores([
      store("acemcp-cache", { "old.ts": "h-old" }),
      store("pi-ace-index", { "new.ts": "h-new" }),
    ]);

    expect(merged.hashesByPath.get("old.ts")).toBe("h-old");
    expect(merged.hashesByPath.get("new.ts")).toBe("h-new");
  });

  test("a name present in both with the same hash stays warm", () => {
    const merged = mergeHashStores([
      store("acemcp-cache", { "a.ts#chunk1of2": "h1", "a.ts#chunk2of2": "h2" }),
      store("pi-ace-index", { "a.ts#chunk1of2": "h1", "a.ts#chunk2of2": "h2" }),
    ]);

    expect(merged.hashesByPath.get("a.ts#chunk1of2")).toBe("h1");
    expect(merged.entryCount).toBe(1);
  });

  test("a name present in both with different hashes is dropped, forcing an upload", () => {
    // One store describes an older revision. Re-uploading is safe; trusting
    // either one could skip an upload the server never received.
    const merged = mergeHashStores([
      store("acemcp-cache", { "a.ts": "h-old" }),
      store("pi-ace-index", { "a.ts": "h-new" }),
    ]);

    expect(merged.hashesByPath.has("a.ts")).toBe(false);
  });

  test("a conflict on one name does not discard the others", () => {
    const merged = mergeHashStores([
      store("acemcp-cache", { "a.ts": "h1", "b.ts": "hb" }),
      store("pi-ace-index", { "a.ts": "h2", "c.ts": "hc" }),
    ]);

    expect(merged.hashesByPath.has("a.ts")).toBe(false);
    expect(merged.hashesByPath.get("b.ts")).toBe("hb");
    expect(merged.hashesByPath.get("c.ts")).toBe("hc");
  });

  test("empty stores contribute nothing and do not create conflicts", () => {
    const merged = mergeHashStores([
      store("acemcp-cache", {}),
      store("pi-ace-index", { "a.ts": "h" }),
    ]);

    expect(merged.hashesByPath.get("a.ts")).toBe("h");
    expect(merged.entryCount).toBe(1);
  });

  test("a single non-empty store is passed through", () => {
    const merged = mergeHashStores([
      store("acemcp-cache", {}),
      store("pi-ace-index", { "a.ts": "h" }),
    ]);
    expect(merged.entryCount).toBe(1);
  });

  test("no stores yields an empty result rather than throwing", () => {
    const merged = mergeHashStores([]);
    expect(merged.entryCount).toBe(0);
    expect(merged.hashesByPath.size).toBe(0);
  });

  test("entryCount counts files, not chunks", () => {
    // Kept comparable with `loadBlobHashStore`, which counts files.
    const merged = mergeHashStores([
      store("pi-ace-index", {
        "a.ts#chunk1of3": "h1",
        "a.ts#chunk2of3": "h2",
        "a.ts#chunk3of3": "h3",
        "b.ts": "hb",
      }),
    ]);

    expect(merged.hashesByPath.size).toBe(4);
    expect(merged.entryCount).toBe(2);
  });
});
