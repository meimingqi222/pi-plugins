import { expect, test } from "bun:test";
import type { PaseoAgentTimelineEvent, PaseoAgentTimelineHandle } from "@getpaseo/client";
import type { WorkStatus } from "../shared/work-status.ts";
import { TaskStatusStore } from "../client/task-status-store.ts";
import { subagentStatuses, transformStatusToolCall, transformTaskInspection } from "../client/transform-status.ts";

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

test("one task keeps one status card across launch, failed inspection and terminal update", async () => {
  const source = host(async () => page([]));
  const store = new TaskStatusStore(() => source.timeline);
  const statusRow = (callId: string) => ({ type: "tool_call" as const, callId, name: "subagent-update", status: "completed" as const, error: null, detail: { type: "plain_text" as const, text: item("failed").text }, metadata: { customType: "subagent-update" } });
  const inspection = { type: "tool_call" as const, callId: "wait", name: "subagent_tasks", status: "completed" as const, error: null, detail: { type: "unknown" as const, input: { action: "wait" }, output: { details: { id: "sa-task", agent: "review", task: "task", status: "failed", errorMessage: "Provider failed" } } } };
  const terminal = statusRow("terminal");
  const emit = (row: any, seq: number) => source.emit({ agentId: "parent", seq, epoch: "epoch-1", event: { type: "timeline", provider: "pi", item: row } });
  const getSource = () => store.getCardSource("parent", "sa-task");
  try {
    store.subscribe("parent", () => {}); await settle();
    emit(inspection, 20);
    const queryCard: any = transformTaskInspection({ item: inspection, phase: "complete" })?.items[0];
    expect(queryCard.data.source).toBe("tool:wait");
    expect(getSource()).toBe(queryCard.data.source);
    emit(terminal, 21);
    const terminalCard: any = transformStatusToolCall({ item: terminal, phase: "complete" })?.items[0];
    expect(getSource()).toBe(terminalCard.data.source);
    expect(getSource()).not.toBe(queryCard.data.source);
    // An older page may arrive after the failed query: use its launch as the
    // permanent task card, and keep the newer failure as state evidence.
    const launch = { ...terminal, callId: "launch", name: "subagent", metadata: undefined, detail: { type: "sub_agent" as const, description: "task", log: item("running").text } };
    emit(launch, 10);
    expect(getSource()).toBe("tool:launch");
    expect(store.get("parent", "sa-task")?.status).toBe("failed");
    emit(statusRow("later-terminal"), 22);
    expect(getSource()).toBe("tool:launch");
  } finally { store.dispose(); }
});

test("a foreground tool returning its answer releases the card to the terminal status", async () => {
  const source = host(async () => page([]));
  const store = new TaskStatusStore(() => source.timeline);
  const running = { type: "tool_call" as const, callId: "foreground", name: "subagent", status: "running" as const, error: null, detail: { type: "sub_agent" as const, log: item("running").text } };
  const emit = (row: any, seq: number) => source.emit({ agentId: "parent", seq, epoch: "epoch-1", event: { type: "timeline", provider: "pi", item: row } });
  const getSource = () => store.getCardSource("parent", "sa-task");
  try {
    store.subscribe("parent", () => {}); await settle();
    emit(running, 10);
    expect(getSource()).toBe("tool:foreground");
    emit({ type: "tool_call", callId: "terminal", name: "subagent-update", status: "completed", error: null, detail: { type: "plain_text", text: item("completed").text }, metadata: { customType: "subagent-update" } }, 12);
    emit({ ...running, status: "completed", detail: { ...running.detail, log: "Exact answer" } }, 11);
    expect(getSource()).toBe("tool:terminal");
    // Late history must not resurrect a row that is now a native answer.
    emit(running, 10);
    expect(getSource()).toBe("tool:terminal");
    expect(store.get("parent", "sa-task")?.status).toBe("completed");
  } finally { store.dispose(); }
});

test("cold paginated history restores one card without reviving an answered foreground row", async () => {
  const nativeAnswer = { type: "tool_call" as const, callId: "foreground", name: "subagent", status: "completed" as const, error: null, detail: { type: "sub_agent" as const, log: "Exact answer" } };
  const terminal = { type: "tool_call" as const, callId: "terminal", name: "subagent-update", status: "completed" as const, error: null, detail: { type: "plain_text" as const, text: item("completed").text }, metadata: { customType: "subagent-update" } };
  const progress = { ...nativeAnswer, status: "running" as const, detail: { type: "sub_agent" as const, log: item("running").text } };
  const source = host(async options => options.cursor
    ? { ...page([]), entries: [{ item: progress, seqEnd: 10 }] }
    : { ...page([], true, 20), entries: [{ item: terminal, seqEnd: 22 }, { item: nativeAnswer, seqEnd: 21 }] });
  const store = new TaskStatusStore(() => source.timeline);
  try {
    store.subscribe("parent", () => {}); await settle();
    expect(store.getCardSource("parent", "sa-task")).toBe("tool:terminal");
    expect(store.get("parent", "sa-task")?.status).toBe("completed");
  } finally { store.dispose(); }
});

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
