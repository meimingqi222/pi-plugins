import { expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { HostSubagentState } from "../src/host-protocol.ts";
import type { Lane } from "../src/lane.ts";

function harness(interval = 20) {
  const messages: Array<{ content: string; display: boolean; details: { id: string; status: string; description: string }; options: { triggerTurn: boolean } }> = [];
  const state = new HostSubagentState({
    sendMessage(message, options) {
      messages.push({ ...message, options } as (typeof messages)[number]);
    },
  } as Pick<ExtensionAPI, "sendMessage">, () => undefined, interval);
  const lane: Lane = {
    id: "lane", agent: "review", alias: "review sources", task: "inspect sources",
    sessionId: "session", kind: "background", status: "running", startedAt: Date.now(),
    progress: { phase: "starting", completedTools: 0, recentTools: [], lastActivityAt: Date.now(), lastEvent: "spawned", recentActivity: [] },
  };
  return { state, lane, messages };
}

test("RPC progress is visible, correlated, coalesced and does not start a parent turn", async () => {
  const { state, lane, messages } = harness();
  try {
    state.progress(lane, { visible: true, hostId: "spawn-call" });
    expect(messages[0]).toMatchObject({ content: expect.stringContaining("starting"), display: true, details: { id: "spawn-call", status: "running" }, options: { triggerTurn: false } });
    for (let i = 0; i < 100; i++) {
      lane.progress = { ...lane.progress!, phase: "tool", activeTool: `read src/${i}.ts`, completedTools: i };
      state.progress(lane, { visible: true, hostId: "spawn-call" });
    }
    expect(messages).toHaveLength(1);
    await new Promise((resolve) => setTimeout(resolve, 35));
    expect(messages).toHaveLength(2);
    expect(messages[1]!.details.description).toContain("using read src/99.ts");
    expect(messages[1]!.content).toContain("99 tools completed");
    state.progress(lane, { visible: true, hostId: "spawn-call" });
    await new Promise((resolve) => setTimeout(resolve, 35));
    expect(messages).toHaveLength(2);
    lane.status = "failed";
    state.publish(lane, "spawn-call");
    expect(messages.at(-1)!.details.status).toBe("error");
  } finally { state.clear(); }
});

test("settlement and session cleanup cancel queued running updates", async () => {
  for (const clear of [false, true]) {
    const { state, lane, messages } = harness();
    state.progress(lane, { visible: true });
    lane.progress = { ...lane.progress!, phase: "model" };
    state.progress(lane, { visible: true });
    if (clear) state.clear();
    else { lane.status = "aborted"; state.publish(lane); }
    const count = messages.length;
    await new Promise((resolve) => setTimeout(resolve, 35));
    expect(messages).toHaveLength(count);
    if (!clear) expect(messages.at(-1)!.details.status).toBe("aborted");
    state.clear();
  }
});

test("TUI progress stays out of chat and RPC partial results use the same progress summary", () => {
  const { state, lane, messages } = harness(0);
  const updates: unknown[] = [];
  try {
    state.progress(lane, { onUpdate: (update) => updates.push(update) });
    expect(messages[0]).toMatchObject({ content: "", display: false });
    expect(updates[0]).toMatchObject({ content: [{ type: "text", text: expect.stringContaining("starting") }], details: { status: "running", agent: "review" } });
    lane.progress = { ...lane.progress!, phase: "model", activeTool: undefined };
    state.progress(lane);
    expect(messages.at(-1)!.details.description).toContain("thinking");
  } finally { state.clear(); }
});

test("foreground progress updates the live tool without appending visible running messages", () => {
  const { state, lane, messages } = harness(0);
  const updates: unknown[] = [];
  lane.kind = "foreground";
  try {
    const options = { visible: true, hostId: "spawn-call", onUpdate: (update: unknown) => updates.push(update) };
    state.progress(lane, options);
    lane.progress = { ...lane.progress!, phase: "tool", activeTool: "read src.ts", completedTools: 3 };
    state.progress(lane, options);
    expect(updates).toHaveLength(2);
    expect(updates[1]).toMatchObject({ content: [{ type: "text", text: expect.stringContaining("3 tools completed") }] });
    expect(messages).toHaveLength(2);
    expect(messages.every(message => !message.display && message.content === "")).toBe(true);
    expect(messages[1]!.details.description).toContain("read src.ts");
    lane.status = "completed";
    state.publish(lane, "spawn-call");
    expect(messages.at(-1)).toMatchObject({ display: true, content: expect.stringContaining("completed"), details: { status: "completed" } });
  } finally { state.clear(); }
});

test("foreground partial results expose only the raw log basename for the plugin output panel", () => {
  const { lane } = harness(0);
  const messages: unknown[] = [];
  const updates: unknown[] = [];
  const state = new HostSubagentState({ sendMessage: message => { messages.push(message); } } as Pick<ExtensionAPI, "sendMessage">, () => "/private/logs/session-sa001.jsonl", 0);
  lane.kind = "foreground";
  try {
    state.progress(lane, { visible: true, hostId: "spawn-call", onUpdate: update => updates.push(update) });
    expect(updates[0]).toMatchObject({ content: [{ type: "text", text: expect.stringContaining("[Pi transcript: session-sa001.jsonl]") }] });
    expect(JSON.stringify(updates)).not.toContain("/private/logs");
    expect(messages[0]).toMatchObject({ display: false, content: "" });
  } finally { state.clear(); }
});

test("Paseo notifications require an explicit RPC client opt-in", () => {
  const previous = process.env.PI_RPC_CLIENT;
  try {
    for (const client of [undefined, 'paseo']) {
      if (client === undefined) delete process.env.PI_RPC_CLIENT;
      else process.env.PI_RPC_CLIENT = client;
      const { state, lane } = harness(0);
      const notes: string[] = [];
      state.liveFile = () => '/tmp/live-transcript.jsonl';
      state.progress(lane, { ctx: { mode: 'rpc', ui: { notify(text: string) { notes.push(text); } } } as any });
      expect(notes.filter((text) => text.startsWith('PASEO_GOTGENES_CHILD_SESSION'))).toHaveLength(client ? 1 : 0);
      state.clear();
    }
  } finally {
    if (previous === undefined) delete process.env.PI_RPC_CLIENT;
    else process.env.PI_RPC_CLIENT = previous;
  }
});
