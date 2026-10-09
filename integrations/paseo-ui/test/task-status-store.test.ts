import { expect, test } from "bun:test";
import type { PaseoAgentTimelineEvent, PaseoAgentTimelineHandle } from "@getpaseo/client";
import type { WorkStatus } from "../shared/work-status.ts";
import { TaskStatusStore } from "../client/task-status-store.ts";
import { subagentStatuses } from "../client/transform-status.ts";

const work = (status: WorkStatus["status"], id = "sa-task"): WorkStatus => ({ kind: "Subagent", id, title: "review", description: "task", status, activity: status, metric: "72 tools completed" });
function item(status: WorkStatus["status"], id = "sa-task") {
  const w = work(status, id);
  return { type: "assistant_message" as const, text: `[Subagent ${id}] ${status}\n${w.title}\n${w.description}\n${w.activity}\n${w.metric}` };
}
const entry = (status: WorkStatus["status"], seq: number, id = "sa-task") => ({ item: item(status, id), seqEnd: seq });
const page = (entries: ReturnType<typeof entry>[], hasOlder = false, seq = 1, epoch = "epoch-1") => ({ entries, epoch, error: null, hasOlder, startCursor: { epoch, seq } });
const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
function host(read: (options: any) => Promise<any>) {
  let receive!: (event: PaseoAgentTimelineEvent) => void;
  let subscribed = 0;
  let released = 0;
  const timeline = {
    refetch: read,
    subscribe(handler: typeof receive) {
      receive = handler; subscribed++;
      return Object.assign(() => { released++; }, { ready: Promise.resolve() });
    },
  } as unknown as PaseoAgentTimelineHandle;
  return { timeline, emit: (event: any) => receive(event), counts: () => ({ subscribed, released }) };
}
const live = (status: WorkStatus["status"], seq: number, epoch = "epoch-1") => ({ agentId: "parent", seq, epoch, event: { type: "timeline", provider: "pi", item: item(status) } });

test("cold history restores completion from older pages even when the completed card is not mounted", async () => {
  const directions: string[] = [];
  const source = host(async options => {
    directions.push(options.direction);
    if (!options.cursor) return page([], true, 300);
    return page([entry("completed", 220), entry("running", 100)]);
  });
  const store = new TaskStatusStore(() => source.timeline);
  try {
    store.subscribe("parent", () => {});
    await settle();
    expect(store.get("parent", "sa-task")?.status).toBe("completed");
    expect(store.get("parent", "sa-task")?.metric).toBe("72 tools completed");
    expect(directions).toEqual(["tail", "before"]);
  } finally { store.dispose(); }
});

test("live completion updates all observers, survives an older fetch, and a later reply may run again", async () => {
  let finish!: (value: any) => void;
  let reads = 0;
  const source = host(() => ++reads === 1 ? new Promise(resolve => { finish = resolve; }) : Promise.resolve(page([entry("completed", 11)])));
  const store = new TaskStatusStore(() => source.timeline);
  let updates = 0;
  try {
    store.subscribe("parent", () => { updates++; });
    store.subscribe("parent", () => { updates++; });
    await settle();
    source.emit(live("completed", 11));
    expect(store.get("parent", "sa-task")?.status).toBe("completed");
    expect(updates).toBeGreaterThanOrEqual(2);
    finish(page([entry("running", 3)])); await settle();
    expect(store.get("parent", "sa-task")?.status).toBe("completed");
    source.emit(live("running", 12));
    expect(store.get("parent", "sa-task")?.status).toBe("running");
    expect(source.counts().subscribed).toBe(1);
  } finally { store.dispose(); }
});

test("reopening a conversation reads persisted latest state and isolates identical task IDs in other parents", async () => {
  let status: WorkStatus["status"] = "running";
  const a = host(async () => page([entry(status, 7)]));
  const b = host(async () => page([entry("failed", 9)]));
  const store = new TaskStatusStore(id => id === "parent-a" ? a.timeline : b.timeline);
  try {
    const stop = store.subscribe("parent-a", () => {});
    store.subscribe("parent-b", () => {}); await settle();
    stop(); status = "aborted";
    store.subscribe("parent-a", () => {}); await settle();
    expect(store.get("parent-a", "sa-task")?.status).toBe("aborted");
    expect(store.get("parent-b", "sa-task")?.status).toBe("failed");
    expect(a.counts()).toEqual({ subscribed: 2, released: 1 });
  } finally { store.dispose(); }
});

test("reconnection recovers missed completion and replacement drops old epoch state", async () => {
  let result = page([entry("running", 10)]);
  const source = host(async () => result);
  const store = new TaskStatusStore(() => source.timeline);
  try {
    store.subscribe("parent", () => {}); await settle();
    result = page([entry("completed", 20)]);
    source.emit({ agentId: "parent", subscriptionId: "one", event: { type: "subscription_restored" } }); await settle();
    expect(store.get("parent", "sa-task")?.status).toBe("completed");
    result = page([entry("failed", 2)], false, 1, "epoch-2");
    source.emit({ agentId: "parent", event: { type: "replacement", epoch: "epoch-2" } }); await settle();
    expect(store.get("parent", "sa-task")?.status).toBe("failed");
  } finally { store.dispose(); }
});

test("navigation releases the shared subscription only after the last card and drops late reads", async () => {
  let finish!: (value: any) => void;
  const source = host(() => new Promise(resolve => { finish = resolve; }));
  const store = new TaskStatusStore(() => source.timeline);
  let updates = 0;
  const first = store.subscribe("parent", () => { updates++; });
  const second = store.subscribe("parent", () => { updates++; });
  await settle();
  first(); expect(source.counts().released).toBe(0);
  second(); expect(source.counts().released).toBe(1);
  finish(page([entry("completed", 20)])); await settle();
  expect(updates).toBe(0);
  expect(store.get("parent", "sa-task")).toBeUndefined();
  store.dispose();
});

test("hidden progress and metadata-only host updates still provide task evidence", () => {
  expect(subagentStatuses(item("running"))[0]?.status).toBe("running");
  const row = { type: "tool_call" as const, name: "subagent-update", callId: "custom", status: "completed" as const, error: null, detail: { type: "plain_text" as const, text: "" }, metadata: { customType: "subagent-update", details: { id: "sa-task", nativeStatus: "failed" } } };
  expect(subagentStatuses(row)[0]).toMatchObject({ id: "sa-task", status: "failed" });
  expect(subagentStatuses({ ...row, metadata: { customType: "unrelated", details: row.metadata.details } })).toEqual([]);
});

test("observation errors retry independently of a concurrent failed history read", async () => {
  let reads = 0;
  const source = host(async () => {
    reads++;
    if (reads === 2) throw new Error("history unavailable");
    return page([entry(reads > 2 ? "completed" : "running", reads * 10)]);
  });
  const store = new TaskStatusStore(() => source.timeline);
  try {
    store.subscribe("parent", () => {}); await settle();
    source.emit({ agentId: "parent", event: { type: "error", error: "observation lost" } });
    source.emit({ agentId: "parent", subscriptionId: "one", event: { type: "subscription_restored" } });
    await settle();
    expect(store.get("parent", "sa-task")?.status).toBe("running");
    await new Promise(resolve => setTimeout(resolve, 1100));
    expect(source.counts().subscribed).toBe(2);
    expect(store.get("parent", "sa-task")?.status).toBe("completed");
  } finally { store.dispose(); }
});
