import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AceApiError, type AceClient } from "../src/client.ts";
import { loadAceSearchConfig } from "../src/config.ts";
import { persistPiAceIndex, acemcpCachePath, piAceIndexPath } from "../src/index-store.ts";
import { runAceSearch } from "../src/search.ts";
import { chunkFileContent } from "../src/walk.ts";

interface FakeCall {
  readonly method: "uploadBlobs" | "findMissing" | "search";
  readonly payload: unknown;
}

function fakeClient(overrides: Partial<AceClient> = {}) {
  const calls: FakeCall[] = [];
  const client: AceClient = {
    async uploadBlobs(blobs, _signal) {
      calls.push({ method: "uploadBlobs", payload: blobs });
    },
    async findMissing(hashes, _signal) {
      calls.push({ method: "findMissing", payload: hashes });
      return { unknown: [], pending: [] };
    },
    async search(input, _signal) {
      calls.push({ method: "search", payload: input });
      return "Path: a.ts#chunk1of2\n  1\tcode";
    },
    ...overrides,
  };
  return { client, calls };
}

async function workspace(): Promise<{ root: string; dataDir: string }> {
  const root = await mkdtemp(join(tmpdir(), "pi-ace-ws-"));
  const dataDir = await mkdtemp(join(tmpdir(), "pi-ace-data-"));
  return { root, dataDir };
}

function configFor(dataDir: string, overrides: Record<string, string> = {}) {
  return loadAceSearchConfig({
    home: "/nonexistent-home",
    dataDir,
    env: { PI_ACE_BASE_URL: "https://ace.test", PI_ACE_TOKEN: "t", ...overrides },
  });
}

describe("runAceSearch", () => {
  test("a cold project uploads every chunk, then retrieves with hashes", async () => {
    const { root, dataDir } = await workspace();
    await writeFile(join(root, "a.ts"), "line1\nline2\n");
    const { client, calls } = fakeClient();

    const result = await runAceSearch({
      projectRoot: root,
      query: "where",
      config: configFor(dataDir, { PI_ACE_MAX_LINES_PER_BLOB: "100" }),
      client,
    });

    const upload = calls.find((call) => call.method === "uploadBlobs");
    expect(upload).toBeDefined();
    expect((upload!.payload as unknown[]).length).toBe(1);

    const search = calls.find((call) => call.method === "search")!;
    const request = search.payload as { addedBlobs: string[] };
    // Retrieval must receive hashes. Sending the chunk name here is the 400
    // "Invalid blob name" this test exists to prevent.
    const expectedHash = chunkFileContent("a.ts", "line1\nline2\n", {
      maxLinesPerBlob: 100,
      maxLineBytes: 10 * 1024,
    })[0]!.hash;
    expect(request.addedBlobs).toEqual([expectedHash]);
    expect((request.addedBlobs as string[])[0]).not.toBe("a.ts");

    expect(result.uploadedChunks).toBe(1);
    expect(result.blobCount).toBe(1);
    expect(result.indexFormat).toBe("acemcp-cache");
    expect(result.phases.map((phase) => phase.phase)).toEqual(["hash", "upload", "retrieve"]);
  });

  test("a warm index uploads nothing and skips the upload phase", async () => {
    const { root, dataDir } = await workspace();
    const content = "line1\n";
    await writeFile(join(root, "a.ts"), content);
    const chunk = chunkFileContent("a.ts", content, { maxLinesPerBlob: 100, maxLineBytes: 10240 })[0]!;

    // Seed this client's own index so the project is warm.
    const indexConfig = configFor(dataDir, { PI_ACE_MAX_LINES_PER_BLOB: "100" });
    const { piAceIndexPath } = await import("../src/index-store.ts");
    await persistPiAceIndex({
      path: piAceIndexPath(dataDir, root.split("\\").join("/")),
      projectRoot: root,
      entries: [{ filePath: "a.ts", chunks: [{ ...chunk, name: "a.ts" }] }],
      source: "pi-ace-index",
    });

    const { client, calls } = fakeClient();
    const result = await runAceSearch({
      projectRoot: root,
      query: "where",
      config: indexConfig,
      client,
    });

    expect(calls.some((call) => call.method === "uploadBlobs")).toBe(false);
    expect(result.uploadedChunks).toBe(0);
    // No upload ⇒ no wait, and the phase list must not claim otherwise.
    expect(result.phases.map((phase) => phase.phase)).toEqual(["hash", "retrieve"]);
    expect(result.indexFormat).toBe("pi-ace-index");
  });

  test("a stale hash forces a re-upload on the next run", async () => {
    const { root, dataDir } = await workspace();
    await writeFile(join(root, "a.ts"), "original\n");
    const { piAceIndexPath } = await import("../src/index-store.ts");
    await persistPiAceIndex({
      path: piAceIndexPath(dataDir, root.split("\\").join("/")),
      projectRoot: root,
      entries: [
        {
          filePath: "a.ts",
          chunks: [{ name: "a.ts", filePath: "a.ts", content: "original\n", hash: "stale-hash" }],
        },
      ],
      source: "pi-ace-index",
    });

    const { client, calls } = fakeClient();
    const result = await runAceSearch({
      projectRoot: root,
      query: "where",
      config: configFor(dataDir, { PI_ACE_MAX_LINES_PER_BLOB: "100" }),
      client,
    });

    expect(result.uploadedChunks).toBe(1);
    expect(calls.some((call) => call.method === "uploadBlobs")).toBe(true);
  });

  test("waitForIndex polls find-missing with hashes, not names", async () => {
    const { root, dataDir } = await workspace();
    await writeFile(join(root, "a.ts"), "x\n");
    const { client, calls } = fakeClient();

    await runAceSearch({
      projectRoot: root,
      query: "where",
      config: configFor(dataDir, { PI_ACE_MAX_LINES_PER_BLOB: "100" }),
      client,
      waitForIndex: true,
    });

    const poll = calls.find((call) => call.method === "findMissing");
    expect(poll).toBeDefined();
    const hashes = poll!.payload as string[];
    expect(hashes[0]).toMatch(/^[0-9a-f]{64}$/);
  });

  test("waitForIndex is skipped when there was nothing to upload", async () => {
    const { root, dataDir } = await workspace();
    await writeFile(join(root, "a.ts"), "x\n");
    const { client, calls } = fakeClient();
    // Cold upload of 0 chunks cannot happen with a real file, so assert the
    // inverse: a warm run never polls even when asked to wait.
    const { piAceIndexPath } = await import("../src/index-store.ts");
    const chunk = chunkFileContent("a.ts", "x\n", { maxLinesPerBlob: 100, maxLineBytes: 10240 })[0]!;
    await persistPiAceIndex({
      path: piAceIndexPath(dataDir, root.split("\\").join("/")),
      projectRoot: root,
      entries: [{ filePath: "a.ts", chunks: [{ ...chunk, name: "a.ts" }] }],
      source: "pi-ace-index",
    });

    await runAceSearch({
      projectRoot: root,
      query: "where",
      config: configFor(dataDir, { PI_ACE_MAX_LINES_PER_BLOB: "100" }),
      client,
      waitForIndex: true,
    });

    expect(calls.some((call) => call.method === "findMissing")).toBe(false);
  });

  test("a failing batch does not abort the run, but a 401 does", async () => {
    const { root, dataDir } = await workspace();
    await writeFile(join(root, "a.ts"), "x\n");

    const tolerable = fakeClient({
      async uploadBlobs() {
        throw new AceApiError(500, "transient");
      },
    });
    const result = await runAceSearch({
      projectRoot: root,
      query: "where",
      config: configFor(dataDir, { PI_ACE_MAX_LINES_PER_BLOB: "100" }),
      client: tolerable.client,
    });
    // Retrieval still ran: a lost upload batch degrades results, it does not
    // invalidate them.
    expect(tolerable.calls.some((call) => call.method === "search")).toBe(true);
    expect(result.uploadedChunks).toBe(0);

    const fatal = fakeClient({
      async uploadBlobs() {
        throw new AceApiError(401, "bad token");
      },
    });
    await expect(
      runAceSearch({
        projectRoot: root,
        query: "where",
        config: configFor(dataDir, { PI_ACE_MAX_LINES_PER_BLOB: "100" }),
        client: fatal.client,
      }),
    ).rejects.toThrow(/401/);
  });

  test("aborting mid-run stops the search phase from starting", async () => {
    const { root, dataDir } = await workspace();
    await writeFile(join(root, "a.ts"), "x\n");
    const controller = new AbortController();
    const { client, calls } = fakeClient({
      async uploadBlobs(_blobs, signal) {
        controller.abort(new Error("cancelled"));
        signal.throwIfAborted();
      },
    });

    await expect(
      runAceSearch({
        projectRoot: root,
        query: "where",
        config: configFor(dataDir, { PI_ACE_MAX_LINES_PER_BLOB: "100" }),
        client,
        signal: controller.signal,
      }),
    ).rejects.toThrow("cancelled");
    expect(calls.some((call) => call.method === "search")).toBe(false);
  });

  test("a failed upload is not persisted, so the next run retries it", async () => {
    const { root, dataDir } = await workspace();
    await writeFile(join(root, "a.ts"), "x\n");
    const { piAceIndexPath, loadBlobHashStore } = await import("../src/index-store.ts");
    const indexPath = piAceIndexPath(dataDir, root.split("\\").join("/"));

    const failing = fakeClient({
      async uploadBlobs() {
        throw new AceApiError(500, "transient");
      },
    });
    await runAceSearch({
      projectRoot: root,
      query: "where",
      config: configFor(dataDir, { PI_ACE_MAX_LINES_PER_BLOB: "100" }),
      client: failing.client,
    });

    // Writing the index after a failed batch would record hashes the server
    // never received; every later run would read them as "already present" and
    // skip the upload forever. The index must still be empty here.
    const store = await loadBlobHashStore(indexPath);
    expect(store.entryCount).toBe(0);

    // And the retry must actually re-upload.
    const retry = fakeClient();
    const result = await runAceSearch({
      projectRoot: root,
      query: "where",
      config: configFor(dataDir, { PI_ACE_MAX_LINES_PER_BLOB: "100" }),
      client: retry.client,
    });
    expect(result.uploadedChunks).toBe(1);
    expect(retry.calls.some((call) => call.method === "uploadBlobs")).toBe(true);
  });

  test("a successful upload is persisted and the next run is warm", async () => {
    const { root, dataDir } = await workspace();
    await writeFile(join(root, "a.ts"), "x\n");
    const config = configFor(dataDir, { PI_ACE_MAX_LINES_PER_BLOB: "100" });

    const first = fakeClient();
    const firstResult = await runAceSearch({
      projectRoot: root,
      query: "where",
      config,
      client: first.client,
    });
    expect(firstResult.uploadedChunks).toBe(1);

    const second = fakeClient();
    const secondResult = await runAceSearch({
      projectRoot: root,
      query: "where",
      config,
      client: second.client,
    });
    expect(secondResult.uploadedChunks).toBe(0);
    expect(secondResult.indexFormat).toBe("pi-ace-index");
  });

  test("the cache key is canonical, so a redundant spelling finds the same index", async () => {
    // The index file name is `sha256(projectRoot)`. `acemcp` hashes the
    // POSIX-absolute form, so `runAceSearch` must canonicalize before hashing:
    // a second spelling of the same directory (a trailing `/.`, a native
    // backslash path on Windows) must land on the index the first run wrote.
    // Hashing the raw string made every differently-spelled run cold, which is
    // the whole cost this plugin exists to remove.
    const { root, dataDir } = await workspace();
    await writeFile(join(root, "a.ts"), "x\n");
    const config = configFor(dataDir, { PI_ACE_MAX_LINES_PER_BLOB: "100" });

    const first = fakeClient();
    const firstResult = await runAceSearch({
      projectRoot: root,
      query: "where",
      config,
      client: first.client,
    });
    expect(firstResult.uploadedChunks).toBe(1);

    // The same directory, spelled non-canonically: a trailing `/.` is kept by
    // string concatenation but removed by `resolve`, so the raw bytes hashed
    // before the fix differ from the canonical ones after it. On Windows a
    // POSIX-separated spelling is added too, since the separator itself
    // changes the hashed bytes there.
    const spellings = [`${root}/.`];
    if (process.platform === "win32") spellings.push(root.split("\\").join("/"));

    for (const projectRoot of spellings) {
      const next = fakeClient();
      const result = await runAceSearch({
        projectRoot,
        query: "where",
        config,
        client: next.client,
      });
      expect(result.uploadedChunks).toBe(0);
      expect(next.calls.some((call) => call.method === "uploadBlobs")).toBe(false);
    }
  });

  test("progress reports every phase so a slow run is attributable", async () => {
    const { root, dataDir } = await workspace();
    await writeFile(join(root, "a.ts"), "x\n");
    const events: string[] = [];
    const { client } = fakeClient();

    await runAceSearch({
      projectRoot: root,
      query: "where",
      config: configFor(dataDir, { PI_ACE_MAX_LINES_PER_BLOB: "100" }),
      client,
      onProgress: (event) => events.push(event.phase),
    });

    expect(events).toContain("hash");
    expect(events).toContain("upload");
    expect(events).toContain("retrieve");
  });

  test("a file known only to this client's index is not re-uploaded", async () => {
    // Regression: this client uploads a file, writes its own index, and the
    // next run must be warm. The old store selection read acemcp's cache first
    // and stopped at the first non-empty store, so this client's index was
    // never consulted and the file was re-uploaded on every subsequent run.
    const { root, dataDir } = await workspace();
    const content = "x\n";
    await writeFile(join(root, "a.ts"), content);
    const projectRoot = root.split("\\").join("/");
    const chunk = chunkFileContent("a.ts", content, { maxLinesPerBlob: 100, maxLineBytes: 10240 })[0]!;

    // acemcp's cache exists and is warm, but knows nothing about `a.ts`.
    await mkdir(join(dataDir, "cache"), { recursive: true });
    await writeFile(
      acemcpCachePath(dataDir, projectRoot),
      JSON.stringify({ "other.ts": { h: ["unrelated-hash"], v: true } }),
    );
    // This client's own index has the file it uploaded.
    await mkdir(join(dataDir, "pi-ace-index"), { recursive: true });
    await writeFile(
      piAceIndexPath(dataDir, projectRoot),
      JSON.stringify({
        version: 1,
        projectRoot,
        updatedAt: new Date().toISOString(),
        source: "acemcp-cache",
        entries: { "a.ts": [chunk.hash] },
      }),
    );

    const { client, calls } = fakeClient();
    const result = await runAceSearch({
      projectRoot: root,
      query: "where",
      config: configFor(dataDir, { PI_ACE_MAX_LINES_PER_BLOB: "100" }),
      client,
    });

    expect(calls.some((call) => call.method === "uploadBlobs")).toBe(false);
    expect(result.uploadedChunks).toBe(0);
  });

  test("both stores contribute: the union is warm", async () => {
    // Neither store is authoritative on its own. Two files, each known to
    // exactly one store, must both count as uploaded.
    const { root, dataDir } = await workspace();
    const chunker = { maxLinesPerBlob: 100, maxLineBytes: 10240 };
    await writeFile(join(root, "from-acemcp.ts"), "x\n");
    await writeFile(join(root, "from-pi.ts"), "y\n");
    const projectRoot = root.split("\\").join("/");
    const aceChunk = chunkFileContent("from-acemcp.ts", "x\n", chunker)[0]!;
    const piChunk = chunkFileContent("from-pi.ts", "y\n", chunker)[0]!;

    await mkdir(join(dataDir, "cache"), { recursive: true });
    await writeFile(
      acemcpCachePath(dataDir, projectRoot),
      JSON.stringify({ "from-acemcp.ts": { h: [aceChunk.hash], v: true } }),
    );
    await mkdir(join(dataDir, "pi-ace-index"), { recursive: true });
    await writeFile(
      piAceIndexPath(dataDir, projectRoot),
      JSON.stringify({
        version: 1,
        projectRoot,
        updatedAt: new Date().toISOString(),
        source: "acemcp-cache",
        entries: { "from-pi.ts": [piChunk.hash] },
      }),
    );

    const { client, calls } = fakeClient();
    const result = await runAceSearch({
      projectRoot: root,
      query: "where",
      config: configFor(dataDir, { PI_ACE_MAX_LINES_PER_BLOB: "100" }),
      client,
    });

    // Both stores were read, so the format reports the merge.
    expect(result.indexFormat).toBe("merged");
    // Neither file needs uploading: each is warm via a different store.
    expect(result.uploadedChunks).toBe(0);
    expect(calls.some((call) => call.method === "uploadBlobs")).toBe(false);
  });

  test("a hash disagreement between the stores forces a re-upload", async () => {
    // Two stores disagreeing means one describes an older revision. Re-uploading
    // is safe; skipping an upload is not.
    const { root, dataDir } = await workspace();
    const content = "x\n";
    await writeFile(join(root, "a.ts"), content);
    const projectRoot = root.split("\\").join("/");
    const chunk = chunkFileContent("a.ts", content, { maxLinesPerBlob: 100, maxLineBytes: 10240 })[0]!;

    await mkdir(join(dataDir, "cache"), { recursive: true });
    await writeFile(
      acemcpCachePath(dataDir, projectRoot),
      JSON.stringify({ "a.ts": { h: [chunk.hash], v: true } }),
    );
    await mkdir(join(dataDir, "pi-ace-index"), { recursive: true });
    await writeFile(
      piAceIndexPath(dataDir, projectRoot),
      JSON.stringify({
        version: 1,
        projectRoot,
        updatedAt: new Date().toISOString(),
        source: "acemcp-cache",
        entries: { "a.ts": ["a-stale-hash"] },
      }),
    );

    const { client, calls } = fakeClient();
    const result = await runAceSearch({
      projectRoot: root,
      query: "where",
      config: configFor(dataDir, { PI_ACE_MAX_LINES_PER_BLOB: "100" }),
      client,
    });

    expect(result.uploadedChunks).toBe(1);
    expect(calls.some((call) => call.method === "uploadBlobs")).toBe(true);
  });
});
