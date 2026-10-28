import { expect, mock, test } from "bun:test";
import { createElement, type ReactNode, type CSSProperties } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const surface = (tag: string) => ({ children, accessibilityLabel, accessibilityState, numberOfLines, style }: { children?: ReactNode; accessibilityLabel?: string; accessibilityState?: { expanded?: boolean }; numberOfLines?: number; style?: CSSProperties & { paddingVertical?: number; paddingHorizontal?: number; marginHorizontal?: number } }) => { const { paddingVertical, paddingHorizontal, marginHorizontal, ...css } = style ?? {}; return createElement(tag, { style: { ...css, paddingTop: paddingVertical, paddingBottom: paddingVertical, paddingLeft: paddingHorizontal, paddingRight: paddingHorizontal, marginLeft: marginHorizontal, marginRight: marginHorizontal }, "aria-label": accessibilityLabel, "aria-expanded": accessibilityState?.expanded, "data-lines": numberOfLines }, children); };
mock.module("react-native", () => ({ View: surface("div"), Text: surface("span"), Pressable: surface("button"), ScrollView: surface("div"), Switch: surface("span") }));
mock.module("@getpaseo/plugin/client/react-native", () => ({ Icon: ({ name, size }: { name: string; size: number }) => createElement("i", { "data-icon": name, "data-size": size }) }));
const { LiveTimeline } = await import("../client/live-timeline.tsx");
const { HistoryControls, LiveScreen } = await import("../client/live-screen.tsx");
const colors = { foreground: "#222", foregroundMuted: "#777", surface1: "#fff", border: "#ddd", statusDanger: "#b00" };
const render = (blocks: Parameters<typeof LiveTimeline>[0]["blocks"]) => renderToStaticMarkup(createElement(LiveTimeline, { blocks, colors }));

test("the output header describes the connection without guessing task completion", () => {
  const html = renderToStaticMarkup(createElement(LiveScreen, {
    theme: { colors }, params: { log: "session-sa001.jsonl", title: "Review" }, layout: { compact: false },
    read: async () => ({ state: "waiting", revision: "", earlierDataOmitted: false, blocks: [] }),
  } as never));
  expect(html).toContain("Following output");
  expect(html).not.toContain("Completed");
});

test("thinking and finished tools are compact disclosure rows instead of expanded logs", () => {
  const html = render([
    { id: "fixture-1788", kind: "thinking", text: "private reasoning body", live: true },
    { id: "fixture-1858", kind: "tool", name: "bash", text: 'bash {"command":"pwd && ls"}', result: "completed output body" },
    { id: "fixture-1965", kind: "assistant", text: "The answer is ready." },
  ]);
  expect(html).toContain("Thinking");
  expect(html).toContain("Shell");
  expect(html).toContain("pwd &amp;&amp; ls");
  expect(html).toContain('aria-expanded="false"');
  expect(html).not.toContain("private reasoning body");
  expect(html).not.toContain("completed output body");
  expect(html).not.toContain("Streaming");
  expect(html).not.toContain("Completed");
  expect(html).toContain("The answer is ready.");
});

test("unfinished tool output remains visible and failed calls retain their details", () => {
  const html = render([
    { id: "fixture-2568", kind: "tool", name: "bash", text: 'bash {"command":"bun test"}', live: true, result: "partial output" },
    { id: "fixture-2679", kind: "tool", name: "read", text: 'read {"path":"missing.ts"}', result: "file missing", isError: true },
  ]);
  expect(html).toContain('aria-expanded="true"');
  expect(html).toContain("partial output");
  expect(html).toContain("file missing");
  expect(html).toContain("missing.ts");
});

test("native column, row density and tool icons match the host timeline", () => {
  const html = render([
    { id: "fixture-3083", kind: "thinking", text: "reasoning" },
    { id: "fixture-3128", kind: "tool", name: "read", text: 'read {"path":"file.ts"}', result: "done" },
    { id: "fixture-3213", kind: "tool", name: "write", text: 'write {"path":"file.ts"}', result: "done" },
    { id: "fixture-3300", kind: "tool", name: "ls", text: 'ls {"path":"."}', result: "done" },
  ]);
  expect(html).toContain("max-width:820px");
  expect(html).toContain("align-self:center");
  expect(html).toContain("padding-left:8px");
  expect(html).toContain("padding-top:4px");
  expect(html).not.toContain("gap:8px");
  expect(html).toContain('data-icon="Eye"');
  expect(html).toContain('data-icon="Pencil"');
  expect(html).toContain('data-icon="Wrench"');
  expect(html).toContain('data-size="12"');
  expect(html).not.toContain('data-size="16"');
});


test("disclosure keys stay with the same activity when the window advances", () => {
  const a = { id: "tool:first", kind: "tool" as const, name: "bash", text: "bash", result: "done" };
  const b = { ...a, id: "tool:second" };
  const c = { ...a, id: "tool:third" };
  const rows = (blocks: typeof a[]) => (LiveTimeline({ blocks, colors }).props.children as any[]);
  const oldRows = rows([a, b]);
  const newRows = rows([b, c]);
  expect(newRows[0].key).toBe(oldRows[1].key);
  expect(newRows[1].key).not.toBe(oldRows[1].key);
});

test("thinking row renders with native Info icon", () => {
  const html = render([{ id: "thinking-1", kind: "thinking", text: "private reasoning" }]);
  expect(html).toContain('data-icon="Info"');
  expect(html).toContain("Thinking");
});

test("truncated expanded history remains escapable instead of offering a no-op show-all action", () => {
  const output = { state: "available" as const, revision: "fixture:all", earlierDataOmitted: true, totalBlocks: 2001, blocks: [{ id: "last", kind: "assistant" as const, text: "latest" }] };
  const changes: boolean[] = [];
  const element = HistoryControls({ output, expanded: true, onExpandedChange: value => changes.push(value), colors });
  const html = renderToStaticMarkup(element);
  expect(html).toContain("Show recent only");
  expect(html).toContain("older output is still omitted");
  expect(html).not.toContain("Show all output");
  const children = element!.props.children as any[];
  children.find(child => child?.props?.accessibilityLabel === "Show recent only").props.onPress();
  expect(changes).toEqual([false]);
});

test("history controls expand recent output and can return even from a short expanded response", () => {
  const changes: boolean[] = [];
  const output = { state: "available" as const, revision: "fixture", earlierDataOmitted: true, blocks: [] };
  const recent = HistoryControls({ output, expanded: false, onExpandedChange: value => changes.push(value), colors });
  expect(renderToStaticMarkup(recent)).toContain("Show more history");
  (recent!.props.children as any[]).find(child => child?.props?.accessibilityLabel === "Show more history").props.onPress();
  const expanded = HistoryControls({ output: { ...output, earlierDataOmitted: false }, expanded: true, onExpandedChange: value => changes.push(value), colors });
  expect(renderToStaticMarkup(expanded)).toContain("Show recent only");
  (expanded!.props.children as any[]).find(child => child?.props?.accessibilityLabel === "Show recent only").props.onPress();
  expect(changes).toEqual([true, false]);
  expect(HistoryControls({ output: { ...output, earlierDataOmitted: false }, expanded: false, onExpandedChange: () => {}, colors })).toBeNull();
});
