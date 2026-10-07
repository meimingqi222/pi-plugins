import { expect, mock, test } from "bun:test";
import { createElement, type CSSProperties, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { mkdirSync, writeFileSync } from "node:fs";
import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import type { WorkStatus } from "../shared/work-status.ts";

// Host-independent render verification uses the actual component and a DOM surface.
function surface(tag: "div" | "span") {
  return ({ children, style, accessibilityLabel }: { children?: ReactNode; style?: CSSProperties & { paddingVertical?: number; paddingHorizontal?: number }; accessibilityLabel?: string }) => {
    const { paddingVertical, paddingHorizontal, ...css } = style ?? {};
    return createElement(tag, { "aria-label": accessibilityLabel, style: { borderWidth: 0, ...(tag === "div" ? { display: "flex", flexDirection: "column" } : {}), ...css, paddingTop: paddingVertical, paddingBottom: paddingVertical, paddingLeft: paddingHorizontal, paddingRight: paddingHorizontal, borderStyle: "solid", minWidth: 0, overflowWrap: "anywhere" } }, children);
  };
}
mock.module("react-native", () => ({ View: surface("div"), Text: surface("span") }));
const { WorkCard } = await import("../client/work-card.tsx");

const colors = { surface1: "#171a1f", border: "#343b44", foreground: "#edf0f4", foregroundMuted: "#a9b1bd", accent: "#65b9ee", statusSuccess: "#75be8c", statusDanger: "#ee8b82" };
function render(data: WorkStatus): string {
  const props = { item: { type: "plugin", kind: "pi-work-status", version: 1, data }, theme: { colors } } as unknown as PluginTimelineItemProps<WorkStatus>;
  return renderToStaticMarkup(createElement(WorkCard, props));
}

test("cards render task, execution state, failure reason and budget with the host theme", () => {
  const data: WorkStatus = { kind: "Subagent", id: "sa-review", title: "检查工具调用的并发行为", status: "failed", description: "Review source files", activity: "Child timed out while reading sources", metric: "3 tools completed" };
  const html = render(data);
  expect(html).toContain("Subagent failed");
  expect(html).toContain(data.title);
  expect(html).toContain(data.activity);
  expect(html).toContain("#ee8b82");
  const goal = render({ ...data, kind: "Goal", status: "budget_limited", metric: "100/100 tokens" });
  expect(goal).toContain("budget limited");
  expect(goal).toContain("100/100 tokens");
});

test("optional preview renders the same cards at mobile and desktop widths", () => {
  const rows: WorkStatus[] = [
    { kind: "Subagent", id: "sa-review", title: "检查 RPC 传输和状态上报", status: "running", description: "Review transport and progress handling", activity: "using read plugins/subagent/src/index.ts", metric: "3 tools completed" },
    { kind: "Workflow", id: "wf-review", title: "Repository review", status: "running", description: "Run independent checks", activity: "review", metric: "2/4 agents · 1,520 tokens" },
    { kind: "Bash", id: "bg001", title: "bun run typecheck", status: "exited", description: "Background command", activity: "exit 0", metric: "pid 21480" },
    { kind: "Goal", id: "goal-1", title: "Complete Paseo display support", status: "budget_limited", description: "Token budget exhausted", activity: "4 work runs", metric: "20,000/20,000 tokens" },
  ];
  const cards = rows.map(render).join("");
  expect(cards).toContain("2/4 agents");
  if (process.env.PI_WORK_CARD_PREVIEW) {
    const path = process.env.PI_WORK_CARD_PREVIEW;
    mkdirSync(path.slice(0, Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"))), { recursive: true });
    writeFileSync(path, `<!doctype html><meta charset="utf-8"><style>body{background:#101216;color:#edf0f4;font-family:Segoe UI,Arial,sans-serif;margin:24px}main{display:flex;align-items:flex-start;gap:24px;flex-wrap:wrap}.column{display:flex;flex-direction:column;gap:12px;width:360px}h2{font-size:14px;font-weight:400;color:#a9b1bd;margin:0}</style><main><section class="column"><h2>Mobile · 360px</h2>${cards}</section><section class="column" style="width:600px"><h2>Desktop · 600px</h2>${cards}</section></main>`);
  }
});
