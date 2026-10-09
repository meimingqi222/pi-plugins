import { expect, mock, test } from "bun:test";
import { createElement, type CSSProperties, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { mkdirSync, writeFileSync } from "node:fs";
import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import type { WorkStatus } from "../shared/work-status.ts";

// Host-independent render verification uses the actual component and a DOM surface.
function surface(tag: "div" | "span") {
  return ({ children, style, accessibilityLabel, accessibilityState, numberOfLines }: { children?: ReactNode; style?: CSSProperties & { paddingVertical?: number; paddingHorizontal?: number }; accessibilityLabel?: string; accessibilityState?: { expanded?: boolean }; numberOfLines?: number }) => {
    const { paddingVertical, paddingHorizontal, ...css } = style ?? {};
    return createElement(tag, { "aria-label": accessibilityLabel, "aria-expanded": accessibilityState?.expanded, "data-lines": numberOfLines, style: { borderWidth: 0, ...(tag === "div" ? { display: "flex", flexDirection: "column" } : {}), ...css, paddingTop: paddingVertical, paddingBottom: paddingVertical, paddingLeft: paddingHorizontal, paddingRight: paddingHorizontal, borderStyle: "solid", minWidth: 0, overflowWrap: "anywhere" } }, children);
  };
}
mock.module("react-native", () => ({ View: surface("div"), Text: surface("span"), Pressable: surface("div"), ScrollView: surface("div"), Switch: surface("span") }));
mock.module("@getpaseo/plugin/client/react-native", () => ({ Icon: surface("span") }));
const { WorkCard } = await import("../client/work-card.tsx");

const colors = { surface1: "#171a1f", border: "#343b44", foreground: "#edf0f4", foregroundMuted: "#a9b1bd", accent: "#65b9ee", statusSuccess: "#75be8c", statusDanger: "#ee8b82" };
function render(data: WorkStatus, palette = colors): string {
  const props = { item: { type: "plugin", kind: "pi-work-status", version: 1, data }, theme: { colors: palette } } as unknown as PluginTimelineItemProps<WorkStatus>;
  return renderToStaticMarkup(createElement(WorkCard, props));
}

test("cards render task, execution state, failure reason and budget with the host theme", () => {
  const data: WorkStatus = { kind: "Subagent", id: "sa-review", title: "检查工具调用的并发行为", status: "failed", description: "Review source files", activity: "Child timed out while reading sources", metric: "3 tools completed" };
  const html = render(data);
  expect(html).toContain("Collapse Subagent:");
  expect(html).toContain("Failed");
  expect(html).toContain(data.title);
  expect(html).toContain(data.activity);
  expect(html).toContain("#ee8b82");
  const goal = render({ ...data, kind: "Goal", status: "budget_limited", metric: "100/100 tokens" });
  expect(goal).toContain("Budget reached");
  expect(goal).not.toContain("100/100 tokens");
});

test("bash cards show readable terminal states without placeholder commands or redundant lines", () => {
  const bash: WorkStatus = { kind: "Bash", id: "bg027", title: "(restored job)", status: "killed", description: "Background command", activity: "exit unknown", metric: "" };
  const stopped = render(bash);
  expect(stopped).toContain("Stopped");
  expect(stopped).toContain("Background job");
  expect(stopped).not.toContain("(restored job)");
  expect(stopped).not.toContain("Background command");
  expect(stopped).not.toContain("exit unknown");
  const completed = render({ ...bash, title: "bun run typecheck", status: "exited", activity: "exit 0" });
  expect(completed).toContain("Completed");
  expect(completed).toContain("bun run typecheck");
  expect(completed).not.toContain("exit 0");
  const failed = render({ ...bash, status: "failed", activity: "exit 2" });
  expect(failed).toContain("Failed");
  expect(failed).toContain("Exit code 2");
  expect(failed).toContain(colors.statusDanger);
  expect(render({ ...bash, status: "timedout" })).toContain("Timed out");
  expect(render({ ...bash, status: "interrupted" })).toContain("Interrupted");
});

test("optional preview renders the same cards at mobile and desktop widths", () => {
  const rows: WorkStatus[] = [
    { kind: "Subagent", id: "sa-review", title: "检查 RPC 传输和状态上报", status: "running", description: "Review transport and progress handling", activity: "using read plugins/subagent/src/index.ts", metric: "3 tools completed" },
    { kind: "Workflow", id: "wf-review", title: "Repository review", status: "running", description: "Run independent checks", activity: "review", metric: "2/4 agents · 1,520 tokens" },
    { kind: "Bash", id: "bg001", title: "bun run typecheck", status: "exited", description: "Background command", activity: "exit 0", metric: "pid 21480" },
    { kind: "Bash", id: "bg027", title: "(restored job)", status: "killed", description: "Background command", activity: "exit unknown", metric: "" },
    { kind: "Bash", id: "bg076", title: "bun run --filter pi-plugins-paseo-ui typecheck", status: "exited", description: "Background command", activity: "exit 0", metric: "" },
    { kind: "Bash", id: "bg077", title: `node ./scripts/${"long-path-".repeat(16)}.mjs`, status: "failed", description: "Background command", activity: "exit 2", metric: "" },
    { kind: "Goal", id: "goal-1", title: "Complete Paseo display support", status: "budget_limited", description: "Token budget exhausted", activity: "4 work runs", metric: "20,000/20,000 tokens" },
  ];
  const cards = rows.map(row => render(row)).join("");
  expect(cards).toContain("Workflow");
  expect(cards).not.toContain("pid 21480");
  if (process.env.PI_WORK_CARD_PREVIEW) {
    const path = process.env.PI_WORK_CARD_PREVIEW;
    mkdirSync(path.slice(0, Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"))), { recursive: true });
    const light = { ...colors, surface1: "#fafafa", border: "#dedee3", foreground: "#222226", foregroundMuted: "#71717b", statusSuccess: "#39764a", statusDanger: "#b73332", accent: "#246fa0" };
    const lightCards = rows.map(row => render(row, light)).join("");
    writeFileSync(path, `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>*{box-sizing:border-box}body{background:#fff;color:#222226;font-family:Segoe UI,Arial,sans-serif;margin:16px}main{display:flex;align-items:flex-start;gap:24px;flex-wrap:wrap}.column{display:flex;flex-direction:column;gap:10px;width:360px;max-width:100%}h2{font-size:14px;font-weight:400;color:#71717b;margin:0}</style><main><section class="column"><h2>Mobile · 360px</h2>${lightCards}</section><section class="column" style="width:600px"><h2>Desktop · 600px</h2>${lightCards}</section><section class="column"><h2>Dark · 360px</h2>${cards}</section></main>`);
  }
});


test.each(["completed", "failed", "aborted"] as const)("historical subagent launch cards display the latest %s state without rewriting the task", status => {
  const original: WorkStatus = { kind: "Subagent", id: "sa-task", title: "review", description: "Original task description", status: "running", activity: "Background", metric: "", liveLog: "session-sa001.jsonl" };
  const latest: WorkStatus = { ...original, title: "New alias", description: "Changed description", status, activity: status === "failed" ? "Child failed" : status, metric: "72 tools completed" };
  const props = { item: { type: "plugin", kind: "pi-work-status", version: 1, data: original }, theme: { colors }, latest };
  const html = renderToStaticMarkup(createElement(WorkCard, props as any));
  expect(html).toContain(status === "completed" ? "Completed" : status === "failed" ? "Failed" : "Cancelled");
  expect(html).not.toContain("Running");
  expect(html).not.toContain("Background");
  expect(html).toContain("review");
  if (status === "failed") {
    expect(html).toContain("72 tools completed");
    expect(html).toContain("Original task description");
  } else {
    expect(html).not.toContain("72 tools completed");
    expect(html).not.toContain("Original task description");
  }
  expect(html).not.toContain("Changed description");
  expect(html).not.toContain("New alias");
});


test.each(["Bash", "Subagent", "Workflow", "Goal"] as const)("%s uses a compact native disclosure with technical metadata hidden", kind => {
  const html = render({ kind, id: "fixture-technical-id", title: "A long task or command", status: "running", description: "Full task details", activity: "running activity", metric: "pid 98765" });
  expect(html).toContain('aria-expanded="false"');
  expect(html).toContain('data-lines="1"');
  expect(html).toContain("padding-top:4px");
  expect(html).toContain("font-weight:normal");
  expect(html).not.toContain("font-weight:600");
  expect(html).not.toContain("fixture-technical-id");
  expect(html).not.toContain("pid 98765");
  expect(html).not.toContain("Full task details");
  expect(html).not.toContain("background-color:");
});

test("subagent output navigation stays a separate action from disclosure", () => {
  const data: WorkStatus = { kind: "Subagent", id: "sa-task", title: "Review source", status: "running", description: "Details", activity: "read", metric: "", liveLog: "session-sa001.jsonl" };
  const props = { item: { data }, theme: { colors }, onOpen: () => {} };
  const html = renderToStaticMarkup(createElement(WorkCard, props as any));
  expect(html).toContain("Expand Subagent: Review source");
  expect(html).toContain("Open subagent output: Review source");
});
