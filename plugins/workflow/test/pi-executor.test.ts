import { describe, expect, test } from "bun:test";
import { applyEvent, emptyStreamState } from "../src/runner/pi-executor.ts";
import { forwardedExecArgs, jsonRunArgs, resolvePiInvocation } from "../src/runner/spawn.ts";

describe("applyEvent", () => {
  test("message_end is authoritative for the final text", () => {
    const state = emptyStreamState();
    applyEvent(state, {
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "partial" },
    });
    applyEvent(state, {
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: "complete answer" }] },
    });
    expect(state.finalText).toBe("complete answer");
  });

  test("usage is cumulative, so a zeroed later event does not erase a total", () => {
    const state = emptyStreamState();
    applyEvent(state, {
      type: "message_update",
      usage: { input: 100, output: 20, totalTokens: 120 },
    });
    applyEvent(state, { type: "message_update", usage: { input: 0, output: 0, totalTokens: 0 } });
    expect(state.usage.input).toBe(100);
    expect(state.usage.totalTokens).toBe(120);
  });

  test("reads cost from both the nested object and a scalar", () => {
    const nested = emptyStreamState();
    applyEvent(nested, { type: "message_update", usage: { cost: { total: 0.5 } } });
    expect(nested.usage.cost).toBe(0.5);
    const scalar = emptyStreamState();
    applyEvent(scalar, { type: "message_update", usage: { cost: 0.25 } });
    expect(scalar.usage.cost).toBe(0.25);
  });

  test("an assistant error message is captured", () => {
    const state = emptyStreamState();
    applyEvent(state, {
      type: "message_end",
      message: { role: "assistant", content: [], stopReason: "error", errorMessage: "rate limited" },
    });
    expect(state.errorMessage).toBe("rate limited");
    expect(state.stopReason).toBe("error");
  });

  test("agent_end replays its messages, so a failed run still yields text", () => {
    const state = emptyStreamState();
    applyEvent(state, {
      type: "agent_end",
      messages: [{ role: "assistant", content: [{ type: "text", text: "last words" }] }],
    });
    expect(state.finalText).toBe("last words");
  });

  test("non-assistant messages are ignored", () => {
    const state = emptyStreamState();
    applyEvent(state, { type: "message_end", message: { role: "user", content: "hi" } });
    expect(state.finalText).toBe("");
  });

  test("the model is recorded when reported", () => {
    const state = emptyStreamState();
    applyEvent(state, { type: "message_end", message: { role: "assistant", content: [], model: "test/model" } });
    expect(state.model).toBe("test/model");
  });

  test("malformed events are ignored rather than throwing", () => {
    const state = emptyStreamState();
    for (const event of [null, undefined, 42, "text", [], {}, { type: 5 }]) {
      expect(() => applyEvent(state, event)).not.toThrow();
    }
    expect(state.finalText).toBe("");
  });
});

describe("resolvePiInvocation", () => {
  test("a virtual script path is never forwarded", () => {
    // A compiled binary's argv[1] is a path inside the executable; passing it to
    // a child would hand it a file that does not exist.
    const invocation = resolvePiInvocation("/usr/bin/pi", "/$bunfs/root/stepcode.js");
    expect(invocation.args).toEqual([]);
    expect(invocation.command).toBe("/usr/bin/pi");
  });

  test("a plain interpreter with no forwarding script falls back to PATH", () => {
    // An empty string, not `undefined`: `undefined` would trigger the default
    // parameter and silently pick up the real `process.argv[1]`.
    const invocation = resolvePiInvocation("/usr/local/bin/node", "");
    expect(invocation).toEqual({ command: "pi", args: [] });
  });

  test("a source launch forwards the script and its loader flags", () => {
    // argv[1] must be a real file: the resolver checks, because a compiled
    // binary's argv[1] is a virtual path that does not exist.
    const script = import.meta.path;
    const invocation = resolvePiInvocation(
      "/usr/local/bin/node",
      script,
      ["--require", "tsx/preload", "--inspect=9229", "--import=tsx"],
    );
    expect(invocation.command).toBe("/usr/local/bin/node");
    expect(invocation.args).toEqual(["--require", "tsx/preload", "--import=tsx", script]);
  });
});

describe("forwardedExecArgs", () => {
  test("drops debugger ports, which a second process cannot bind", () => {
    expect(forwardedExecArgs(["--inspect=9229", "--require", "x"])).toEqual(["--require", "x"]);
  });
  test("keeps inline loader flags", () => {
    expect(forwardedExecArgs(["--import=tsx", "-rfoo"])).toEqual(["--import=tsx", "-rfoo"]);
  });
  test("drops a loader flag with no value", () => {
    expect(forwardedExecArgs(["--require"])).toEqual([]);
  });
});

describe("jsonRunArgs", () => {
  test("is non-interactive and does not persist a session per agent", () => {
    // A fan-out of hundreds of agents must not fill the session store.
    expect(jsonRunArgs()).toEqual(["--mode", "json", "-p", "--no-session"]);
  });
});
