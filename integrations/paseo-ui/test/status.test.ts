import { expect, test } from "bun:test";
import { formatHostWork, type HostWork } from "../../../plugins/run-core/src/host-work.ts";
import { parseWorkStatus } from "../shared/work-status.ts";
import { transformStatusMessage, transformStatusToolCall, transformTaskInspection } from "../client/transform-status.ts";

/** Shape Paseo builds for a Pi custom message (mapCustomMessageToToolCall). */
function syntheticStatusRow(customType: string, text: string) {
  return { type: "tool_call" as const, callId: `pi-custom-${customType}`, name: customType, status: "completed" as const, error: null, detail: { type: "plain_text" as const, text }, metadata: { synthetic: true, customType, details: { id: "call_00_o8y9", status: "completed" } } };
}

/** The `subagent` host tool row; Paseo's pi subagent adapter maps its partial result to `detail.log`. */
function subagentToolCall(status: "running" | "completed", log: string) {
  return { type: "tool_call" as const, callId: "call_00_o8y9", name: "subagent", status, error: null, detail: { type: "sub_agent" as const, subAgentType: "general", description: "Run the deploy checks", log } };
}

test.each(["subagent", "workflow", "bash", "goal"] as const)("%s status survives the Pi-to-Paseo text boundary", (kind) => {
  const work: HostWork = { kind, id: "work-1", title: "检查 sources", status: "running", description: "find problems", activity: "using read src.ts", metric: "2 tools completed" };
  const text = formatHostWork(work);
  const message = transformStatusMessage({ phase: "complete", item: { type: "assistant_message", text } });
  if (kind === "subagent") expect(message).toEqual({ items: [] });
  else expect(message!.items[0]).toMatchObject({ type: "plugin", kind: "pi-work-status", version: 1, data: { id: "work-1", title: work.title, activity: work.activity, status: "running" } });
});

test("replayed subagent progress snapshots are hidden while the live tool card and terminal card remain", () => {
  const work: HostWork = { kind: "subagent", id: "call_00_o8y9", title: "review (explore)", status: "running", description: "Inspect the repository", activity: "thinking", metric: "0 tools completed" };
  const history = [0, 0, 3, 5].map(count => formatHostWork({ ...work, metric: `${count} tools completed` }));
  for (const text of history) {
    expect(transformStatusMessage({ phase: "complete", item: { type: "assistant_message", text } })).toEqual({ items: [] });
    for (const customType of ["subagent-update", "pi-work-status"]) {
      expect(transformStatusToolCall({ phase: "complete", item: syntheticStatusRow(customType, text) })).toEqual({ items: [] });
    }
    expect(transformStatusToolCall({ phase: "streaming", item: subagentToolCall("running", text) })?.items).toHaveLength(1);
  }
  const terminal = formatHostWork({ ...work, status: "completed", metric: "5 tools completed" });
  expect(transformStatusToolCall({ phase: "complete", item: syntheticStatusRow("subagent-update", terminal) })?.items).toHaveLength(1);
});

test("a custom status message renders as a card on hosts old and new", () => {
  const work: HostWork = { kind: "subagent", id: "call_00_o8y9", title: "deploy checks (explore)", status: "completed", description: "Run the deploy checks", activity: "completed", metric: "2 tools completed" };
  const text = formatHostWork(work);
  const before = transformStatusMessage({ phase: "complete", item: { type: "assistant_message", text } });
  expect(before).toBeDefined();
  // Paseo 0.11.1 maps a Pi custom message to a synthetic completed tool row
  // (provider/pi/agent.ts, mapCustomMessageToToolCall) instead of assistant speech.
  for (const customType of ["pi-work-status", "subagent-update"]) {
    const row = syntheticStatusRow(customType, text);
    expect(transformStatusToolCall({ phase: "complete", item: row })).toEqual(before);
  }
});

test("a running subagent tool call streams the same card while the child works", () => {
  const work: HostWork = { kind: "subagent", id: "call_00_o8y9", title: "deploy checks (explore)", status: "running", description: "Run the deploy checks", activity: "thinking", metric: "3 tools completed" };
  const live = transformStatusToolCall({ phase: "streaming", item: subagentToolCall("running", formatHostWork(work)) });
  expect(live?.items[0]).toMatchObject({ type: "plugin", kind: "pi-work-status", version: 1, data: { id: "call_00_o8y9", status: "running", activity: "thinking", metric: "3 tools completed" } });
  // A launched background call carries the running text in its completed result.
  expect(transformStatusToolCall({ phase: "complete", item: subagentToolCall("completed", formatHostWork(work)) })).toEqual(live);
});

test("foreground progress and background launch carry output-screen references without replacing answers", () => {
  const liveLog = "session-sa-12345678-1234-1234-1234-123456789abc.jsonl";
  const running = `[Subagent call-1] running\nExplore\nInspect sources\nthinking\n0 tools completed\n[Pi transcript: ${liveLog}]`;
  expect(transformStatusToolCall({ phase: "streaming", item: subagentToolCall("running", running) })?.items[0]).toMatchObject({ data: { liveLog } });
  const launch = `Subagent sa-12345678-1234-1234-1234-123456789abc (explore) started in the background. Continue independent work.\nOutput file: /tmp/host.jsonl\n[Pi transcript: ${liveLog}]`;
  expect(transformStatusToolCall({ phase: "complete", item: subagentToolCall("completed", launch) })?.items[0]).toMatchObject({ data: { kind: "Subagent", status: "running", liveLog, description: "Run the deploy checks" } });
});

test("tool rows that are not status keep Paseo's native renderer", () => {
  // A settled child answers in the same field the live status streamed through.
  const answer = subagentToolCall("completed", "Exact output:\n\n```\nchild-done\n```");
  expect(transformStatusToolCall({ phase: "complete", item: answer })).toBeUndefined();
  expect(transformStatusToolCall({ phase: "streaming", item: { ...answer, detail: { ...answer.detail, log: "no status header here" } } })).toBeUndefined();
  expect(transformStatusToolCall({ phase: "complete", item: syntheticStatusRow("subagent-result", formatHostWork({ kind: "subagent", id: "x", title: "t", status: "completed", description: "d" })) })).toBeUndefined();
  expect(transformStatusToolCall({ phase: "complete", item: { ...answer, name: "bash", detail: { type: "shell", command: "bun test", output: formatHostWork({ kind: "bash", id: "b", title: "bun test", status: "running", description: "Background command" }), exitCode: 0 } } })).toBeUndefined();
});

test("unrelated, incomplete and unknown-version text keeps Paseo's native renderer", () => {
  for (const text of ["normal answer", "[Goal work-1] active\ntask", "[Goal work-1] invented\ntask\n\n\n", "prefix\n[Goal work-1] active\ntask\n\n\n", "x".repeat(1_201)]) {
    expect(parseWorkStatus(text)).toBeUndefined();
  }
  const text = formatHostWork({ kind: "goal", id: "goal-1", title: "finish", status: "complete", description: "verified" });
  expect(transformStatusMessage({ phase: "streaming", item: { type: "assistant_message", text } })).toBeUndefined();
  expect(parseWorkStatus(text)).toMatchObject({ status: "complete", activity: "", metric: "" });
});

test.each(["failed", "aborted", "exited", "timedout", "paused", "budget_limited", "blocked"])("terminal %s stays terminal in history replay", (status) => {
  const text = formatHostWork({ kind: "goal", id: "goal-1", title: "finish", status, description: "reason", metric: "100/100 tokens" });
  expect(parseWorkStatus(text)).toMatchObject({ status, description: "reason", metric: "100/100 tokens" });
});

test("task inspection cards hide diagnostic paths and preserve successful answers and control output", () => {
  const lane = { id: "sa-task", alias: "Transport review", agent: "review", task: "Check transport", status: "failed", errorMessage: "Total deadline; its event stream is at C:/private/events.jsonl", progress: { completedTools: 30, activeTool: "bash", phase: "tool" } };
  const item = { type: "tool_call" as const, callId: "show", name: "subagent_tasks", status: "completed" as const, error: null, detail: { type: "unknown" as const, input: { action: "show" }, output: { details: lane } } };
  const result = transformTaskInspection({ phase: "complete", item });
  expect(result?.items[0]).toMatchObject({ data: { title: "Transport review", activity: "Total deadline", metric: "30 tools completed" } });
  expect(JSON.stringify(result)).not.toContain("C:/private");
  expect(transformTaskInspection({ phase: "complete", item: { ...item, detail: { ...item.detail, input: { action: "reply" } } } })).toBeUndefined();
  expect(transformTaskInspection({ phase: "complete", item: { ...item, detail: { ...item.detail, input: { action: "wait" }, output: { details: { ...lane, status: "running" } } } } })).toBeUndefined();
  expect(transformTaskInspection({ phase: "complete", item: { ...item, detail: { ...item.detail, output: { details: { ...lane, status: "running", result: { details: { status: "completed" } } } } } } })).toBeUndefined();
});
