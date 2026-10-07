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
