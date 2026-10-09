import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CompactClient } from "@morphllm/morphsdk";
import morphSearch from "../src/index.ts";
import { compactWithSignal } from "../src/compact.ts";
import { GITHUB_PAT } from "../../redact/test/fixtures.ts";

function setup(service?: unknown, timeoutMs = 60000) {
  const directory = mkdtempSync(join(tmpdir(), "morph-boundary-"));
  const config = join(directory, "config.json");
  writeFileSync(config, JSON.stringify({ apiKey: "example", compact: { enabled: true, timeoutMs } }));
  const old = process.env.PI_MORPH_SEARCH_CONFIG;
  process.env.PI_MORPH_SEARCH_CONFIG = config;
  let hook!: (event: any) => Promise<any>;
  let announce: ((value: unknown) => void) | undefined;
  try {
    morphSearch({ registerTool() {}, on(_name: string, handler: typeof hook) { hook = handler; }, events: {
      on(name: string, handler: typeof announce) { if (name === "pi-redact:service") announce = handler; },
      emit(name: string) { if (name === "pi-redact:service-request" && service) announce?.(service); },
    } } as never);
  } finally {
    if (old === undefined) delete process.env.PI_MORPH_SEARCH_CONFIG;
    else process.env.PI_MORPH_SEARCH_CONFIG = old;
    rmSync(directory, { recursive: true, force: true });
  }
  const run = (signal = new AbortController().signal) => hook({ signal, preparation: {
    previousSummary: GITHUB_PAT, messagesToSummarize: [{ role: "user", content: GITHUB_PAT, timestamp: 1 }],
    turnPrefixMessages: [{ role: "user", content: GITHUB_PAT, timestamp: 2 }], firstKeptEntryId: "kept", tokensBefore: 100,
  } });
  return { run, announce: (value: unknown) => announce?.(value) };
}

const service = { version: 2, isEnabled: () => true, redactString: (s: string) => s.replaceAll(GITHUB_PAT, "[removed]"),
  redactJson: (v: unknown) => JSON.parse(JSON.stringify(v).replaceAll(GITHUB_PAT, "[removed]")) };

test("Morph compact redacts history, prefix and previous summary in either plugin load order", async () => {
  const requests: unknown[] = [];
  const compact = spyOn(CompactClient.prototype, "compact").mockImplementation(async input => {
    requests.push(input); return { output: "summary" } as any;
  });
  try {
    await setup(service).run();
    const late = setup(); late.announce(service); await late.run();
    expect(requests).toHaveLength(2);
    for (const request of requests) {
      expect(JSON.stringify(request).includes(GITHUB_PAT)).toBe(false);
      expect((request as any).messages).toHaveLength(3);
      expect(JSON.stringify(request)).toContain("[removed]");
    }
  } finally { compact.mockRestore(); }
});

test("Morph compact fails closed when a discovered redactor throws", async () => {
  const compact = spyOn(CompactClient.prototype, "compact").mockResolvedValue({ output: "unsafe" } as any);
  try {
    expect(await setup({ ...service, redactJson() { throw new Error("redactor failed"); } }).run()).toBeUndefined();
    expect(compact).not.toHaveBeenCalled();
  } finally { compact.mockRestore(); }
});

test("Morph compact sends nothing when cancelled before the hook", async () => {
  const compact = spyOn(CompactClient.prototype, "compact").mockResolvedValue({ output: "late" } as any);
  const controller = new AbortController(); controller.abort();
  try {
    const result = await setup().run(controller.signal);
    expect(compact).not.toHaveBeenCalled();
    expect(result).toEqual({ cancel: true });
  } finally { compact.mockRestore(); }
});

test("Morph compact aborts the transport during cancellation and discards late summaries", async () => {
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  let aborted = false;
  const fetchMock = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (_url: Parameters<typeof fetch>[0], options?: Parameters<typeof fetch>[1]) => {
    const signal = options?.signal;
    started();
    return new Promise<Response>(resolve => {
      const finish = () => { aborted = signal?.aborted === true; resolve(Response.json({ output: "late" })); };
      if (signal) signal.addEventListener("abort", finish, { once: true });
      else finish();
    });
  }, { preconnect() {} }));
  try {
    const controller = new AbortController();
    const result = setup().run(controller.signal);
    await ready; controller.abort();
    expect(await result).toEqual({ cancel: true });
    expect(aborted).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  } finally { fetchMock.mockRestore(); }
});


test("Morph compact timeout aborts fetch rather than leaving an external request alive", async () => {
  let aborted = false;
  const fetchMock = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (_url: Parameters<typeof fetch>[0], options?: Parameters<typeof fetch>[1]) => {
    const signal = options!.signal!;
    return new Promise<Response>((_resolve, reject) => {
      signal.addEventListener("abort", () => { aborted = true; reject(signal.reason); }, { once: true });
    });
  }, { preconnect() {} }));
  try {
    await expect(compactWithSignal({ apiKey: "example", timeout: 10 }, { messages: [{ role: "user", content: "hello" }] }, new AbortController().signal)).rejects.toThrow();
    expect(aborted).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  } finally { fetchMock.mockRestore(); }
});
