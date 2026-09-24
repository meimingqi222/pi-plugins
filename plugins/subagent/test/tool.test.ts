import { describe, expect, test } from "bun:test";
import type { AgentExecutor, AgentRunInput, AgentUsage } from "pi-agent-runner";
import type { SubagentDefinition } from "../src/agents.ts";
import { executeSubagent, truncate } from "../src/tool.ts";

const agents: SubagentDefinition[] = [
  { name: "scout", description: "recon", systemPrompt: "You are a scout.", filePath: "/agents/scout.md" },
  { name: "worker", description: "writes", systemPrompt: "", filePath: "/agents/worker.md" },
];

const usage: AgentUsage = { input: 11, output: 7, cacheRead: 0, cacheWrite: 0, cost: 0, totalTokens: 18 };

function text(result: { content: Array<{ type: string; text?: string }> }): string {
  const first = result.content[0];
  return first && first.type === "text" ? (first.text ?? "") : "";
}

const completed: AgentExecutor = async () => ({ status: "completed", text: "found it", usage, model: "fixture/model" });

describe("executeSubagent", () => {
  test("returns the reply, its usage, and the agent in details", async () => {
    const result = await executeSubagent({ agent: "scout", task: "find auth" }, { cwd: "/repo" }, {
      executor: completed,
      discover: () => agents,
    });
    expect(text(result)).toBe("found it");
    expect(result.details.agent).toBe("scout");
    expect(result.details.status).toBe("completed");
    expect(result.usage?.totalTokens).toBe(18);
  });

  test("forwards the Task-framed prompt, the agent's system prompt, tools, and model", async () => {
    // The runner owns the process; this tool owns what the child is told. A wrong
    // framing (a missing `Task:` prefix, a dropped system prompt) is silent
    // otherwise, so it is pinned against a spy executor.
    let seen: AgentRunInput | undefined;
    const spy: AgentExecutor = async (input) => {
      seen = input;
      return { status: "completed", text: "", usage };
    };
    const rich: SubagentDefinition = { ...agents[0]!, tools: ["read", "grep"], model: "from/file" };
    await executeSubagent({ agent: "scout", task: "find auth" }, { cwd: "/repo" }, {
      executor: spy,
      discover: () => [rich],
    });
    expect(seen?.prompt).toBe("Task: find auth");
    expect(seen?.systemPrompt).toBe("You are a scout.");
    expect(seen?.tools).toEqual(["read", "grep"]);
    expect(seen?.model).toBe("from/file");
  });

  test("an unknown agent lists the available ones instead of spawning", async () => {
    let spawned = false;
    const result = await executeSubagent({ agent: "nope", task: "x" }, { cwd: "/repo" }, {
      executor: async () => {
        spawned = true;
        return { status: "completed", text: "", usage };
      },
      discover: () => agents,
    });
    expect(spawned).toBe(false);
    expect(text(result)).toContain('Unknown agent "nope"');
    expect(text(result)).toContain('"scout"');
    expect(result.details.status).toBe("failed");
  });

  test("a failed agent is reported as failed with its reason", async () => {
    const failing: AgentExecutor = async () => ({ status: "failed", text: "", usage, errorMessage: "timed out" });
    const result = await executeSubagent({ agent: "scout", task: "x" }, { cwd: "/repo" }, {
      executor: failing,
      discover: () => agents,
    });
    expect(text(result)).toContain("failed: timed out");
    expect(result.details.errorMessage).toBe("timed out");
  });

  test("an explicit model overrides the agent file's model", async () => {
    let seen: string | undefined;
    const spy: AgentExecutor = async (input) => {
      seen = input.model;
      return { status: "completed", text: "", usage };
    };
    const withModel: SubagentDefinition = { ...agents[0]!, model: "from/file" };
    await executeSubagent({ agent: "scout", task: "x", model: "from/param" }, { cwd: "/repo" }, {
      executor: spy,
      discover: () => [withModel],
    });
    expect(seen).toBe("from/param");
  });

  test("inherits the parent session model and thinking level without an override", async () => {
    let seen: AgentRunInput | undefined;
    const parentContext = { cwd: "/repo", model: "parent/model", effort: "high" };
    await executeSubagent({ agent: "scout", task: "x" }, parentContext, {
      executor: async (input) => { seen = input; return { status: "completed", text: "ok", usage }; },
      discover: () => agents,
    });
    expect(seen?.model).toBe("parent/model");
    expect(seen?.effort).toBe("high");
  });
});

describe("truncate", () => {
  test("leaves a short reply untouched and bounds a long one", () => {
    expect(truncate("short", 100)).toBe("short");
    const long = "x".repeat(200);
    const result = truncate(long, 50);
    expect(result.startsWith("x".repeat(50))).toBe(true);
    expect(result).toContain("Output truncated");
  });
});
