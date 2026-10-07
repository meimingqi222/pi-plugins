import { expect, test } from "bun:test";
import { formatHostWork, type HostWork } from "../../../plugins/run-core/src/host-work.ts";
import { parseWorkStatus } from "../shared/work-status.ts";
import { transformStatusMessage, transformStatusNotification, transformTaskInspection } from "../client/transform-status.ts";

test.each(["subagent", "workflow", "bash", "goal"] as const)("%s status survives the Pi-to-Paseo text boundary", (kind) => {
  const work: HostWork = { kind, id: "work-1", title: "检查 sources", status: "running", description: "find problems", activity: "using read src.ts", metric: "2 tools completed" };
  const text = formatHostWork(work);
  const message = transformStatusMessage({ phase: "complete", item: { type: "assistant_message", text } });
  const notification = transformStatusNotification({ phase: "complete", item: { type: "notification", message: text, level: "info" } });
  expect(message).toEqual(notification);
  expect(message!.items[0]).toMatchObject({ type: "plugin", kind: "pi-work-status", version: 1, data: { id: "work-1", title: work.title, activity: work.activity, status: "running" } });
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
