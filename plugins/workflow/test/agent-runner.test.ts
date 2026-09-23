import { describe, expect, test } from "bun:test";
import { buildAgentPrompt, parseStructuredReply, runAgent, transportRetryBudget } from "../src/runner/agent-runner.ts";
import type { AgentExecutor } from "../src/runner/agent-runner.ts";
import type { WorkflowAgentRunInput } from "../src/core/types.ts";

const base: WorkflowAgentRunInput = { prompt: "do it", options: {}, cwd: "/tmp", runId: "r", agentId: "a" };

/** An executor that returns a fixed sequence of results, then repeats the last. */
function sequence(results: Array<Partial<{ value: unknown; text: string; status: "completed" | "failed"; errorMessage: string }>>): {
  executor: AgentExecutor;
  prompts: string[];
} {
  const prompts: string[] = [];
  let index = 0;
  const executor: AgentExecutor = async (input) => {
    prompts.push(input.prompt);
    const result = results[Math.min(index, results.length - 1)]!;
    index += 1;
    return {
      status: result.status ?? "completed",
      usage: { input: 1, output: 1 },
      value: result.value,
      text: result.text,
      errorMessage: result.errorMessage,
    } as never;
  };
  return { executor, prompts };
}

describe("buildAgentPrompt", () => {
  test("no schema leaves the prompt untouched", () => {
    expect(buildAgentPrompt("hello", undefined)).toBe("hello");
  });
  test("a schema is appended as an explicit output contract", () => {
    const prompt = buildAgentPrompt("hello", { type: "object" });
    expect(prompt).toContain("hello");
    expect(prompt).toContain("workflow-structured-output");
    expect(prompt).toContain('{"type":"object"}');
  });
});

describe("parseStructuredReply", () => {
  test("unwraps a fenced block, which is formatting rather than a different answer", () => {
    expect(parseStructuredReply('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });
  test("parses bare JSON", () => {
    expect(parseStructuredReply('{"a":1}')).toEqual({ a: 1 });
  });
  test("throws on prose, so the retry loop sees a failure instead of raw text", () => {
    // Passing text through where a schema was requested would make agent()'s
    // contract depend on the model's mood.
    expect(() => parseStructuredReply("I think the answer is 42")).toThrow();
  });
});

describe("runAgent without a schema", () => {
  test("returns the executor's value", async () => {
    const { executor } = sequence([{ value: "done" }]);
    const outcome = await runAgent({ executor, input: base });
    expect(outcome.value).toBe("done");
    expect(outcome.attempts).toBe(1);
  });
  test("falls back to text when there is no value", async () => {
    const { executor } = sequence([{ text: "plain answer" }]);
    expect((await runAgent({ executor, input: base })).value).toBe("plain answer");
  });
  test("a failed agent throws with its message", async () => {
    const { executor } = sequence([{ status: "failed", errorMessage: "provider exploded" }]);
    await expect(runAgent({ executor, input: base })).rejects.toThrow("provider exploded");
  });
});

describe("runAgent with a schema", () => {
  const schema = {
    type: "object",
    properties: { ok: { type: "boolean" } },
    required: ["ok"],
    additionalProperties: false,
  };

  test("accepts a valid structured reply", async () => {
    const { executor } = sequence([{ text: '{"ok":true}' }]);
    const outcome = await runAgent({ executor, input: { ...base, options: { schema } } });
    expect(outcome.value).toEqual({ ok: true });
  });

  test("retries a schema mismatch and feeds the error back", async () => {
    const { executor, prompts } = sequence([{ text: '{"ok":"yes"}' }, { text: '{"ok":true}' }]);
    const outcome = await runAgent({ executor, input: { ...base, options: { schema } } });
    expect(outcome.value).toEqual({ ok: true });
    expect(outcome.attempts).toBe(2);
    // The retry must explain what was wrong, or the model repeats the mistake.
    expect(prompts[1]).toContain("workflow-schema-repair");
    expect(prompts[1]).toContain("ok");
  });

  test("exhausting the attempts throws instead of returning a bad value", async () => {
    const { executor } = sequence([{ text: '{"ok":"nope"}' }]);
    await expect(
      runAgent({ executor, input: { ...base, options: { schema, retries: 2 } } }),
    ).rejects.toThrow(/did not satisfy its schema after 2 attempts/);
  });

  test("strips undeclared keys rather than failing on a stray field", async () => {
    const { executor } = sequence([{ text: '{"ok":true,"extra":1}' }]);
    const outcome = await runAgent({ executor, input: { ...base, options: { schema } } });
    expect(outcome.value).toEqual({ ok: true });
  });

  test("a non-JSON reply is treated as a mismatch and retried", async () => {
    const { executor } = sequence([{ text: "not json" }, { text: '{"ok":true}' }]);
    const outcome = await runAgent({ executor, input: { ...base, options: { schema } } });
    expect(outcome.value).toEqual({ ok: true });
    expect(outcome.attempts).toBe(2);
  });
});

describe("transport failures", () => {
  const readOnly: WorkflowAgentRunInput = { ...base, options: { toolProfile: "researcher" } };

  test("a read-only child that died of a lost connection is re-run once", async () => {
    // The child produced nothing, so the run is missing one result through no
    // fault of the script. One more child is cheaper than a degraded run.
    const { executor, prompts } = sequence([
      { status: "failed", errorMessage: "Upstream stream ended before terminal chunk" },
      { text: "pong" },
    ]);
    const outcome = await runAgent({ executor, input: readOnly, transportRetries: 1 });
    expect(outcome.value).toBe("pong");
    expect(outcome.attempts).toBe(2);
    // The retry re-asks the original question: a schema-repair block would ask
    // the model to fix a reply it never made.
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).not.toContain("workflow-schema-repair");
    expect(prompts[1]).toBe(prompts[0]);
    // Both attempts are billed, which is why the retry has to be bounded.
    expect(outcome.usage.input).toBe(2);
  });

  test("a child that can write is never re-run blind", async () => {
    // A duplicate edit or a second `git commit` is worse than a missing answer,
    // so a role that may have written before it died gets no second chance.
    const { executor, prompts } = sequence([
      { status: "failed", errorMessage: "Connection error." },
      { text: "pong" },
    ]);
    await expect(
      runAgent({
        executor,
        input: { ...base, options: { toolProfile: "developer" } },
        transportRetries: 1,
      }),
    ).rejects.toThrow(/Connection error/);
    expect(prompts).toHaveLength(1);
  });

  test("an unprofiled child is unrestricted, so it is not re-run either", async () => {
    const { executor, prompts } = sequence([
      { status: "failed", errorMessage: "Connection error." },
      { text: "pong" },
    ]);
    await expect(runAgent({ executor, input: base, transportRetries: 1 })).rejects.toThrow(/Connection error/);
    expect(prompts).toHaveLength(1);
  });

  test("repeating the failure would only reproduce it, so those are not retried", async () => {
    const messages = [
      // The run's own cap: a re-run hits it again with the same bill.
      "The agent timed out after 600000ms; its event stream is at /tmp/x.jsonl",
      // Routing and quota: the user has to change something, not the runner.
      '429:{"message":"No available route for model \\"step-5-preview\\""}',
      // Saturation: retrying makes it worse.
      "concurrency reached, current: 6, limit: 5",
    ];
    for (const errorMessage of messages) {
      const { executor, prompts } = sequence([{ status: "failed", errorMessage }, { text: "pong" }]);
      await expect(runAgent({ executor, input: readOnly, transportRetries: 1 })).rejects.toThrow();
      expect(prompts, errorMessage).toHaveLength(1);
    }
  });

  test("an abort is the user's decision, not a lost connection", async () => {
    const { executor, prompts } = sequence([{ status: "failed", errorMessage: "The agent was aborted" }]);
    const aborted: WorkflowAgentRunInput = { ...base, options: { toolProfile: "researcher" } };
    const result = await runAgent({
      executor: async (input) => {
        prompts.push(input.prompt);
        return { status: "aborted", errorMessage: "The agent was aborted", usage: { input: 1, output: 1 } } as never;
      },
      input: aborted,
      transportRetries: 1,
    }).catch((error: Error) => error);
    expect(result).toBeInstanceOf(Error);
    expect(prompts).toHaveLength(1);
  });

  test("the retry budget is configurable and zero disables it", () => {
    expect(transportRetryBudget({} as NodeJS.ProcessEnv)).toBe(1);
    expect(transportRetryBudget({ PI_WORKFLOW_TRANSPORT_RETRIES: "0" } as NodeJS.ProcessEnv)).toBe(0);
    expect(transportRetryBudget({ PI_WORKFLOW_TRANSPORT_RETRIES: "2" } as NodeJS.ProcessEnv)).toBe(2);
    // A malformed value falls back rather than disabling or unbounded-retrying.
    expect(transportRetryBudget({ PI_WORKFLOW_TRANSPORT_RETRIES: "soon" } as NodeJS.ProcessEnv)).toBe(1);
  });
});

describe("runAgent accounting and admission", () => {
  test("usage accumulates across attempts", async () => {
    const schema = { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] };
    const { executor } = sequence([{ text: "bad" }, { text: '{"ok":true}' }]);
    const outcome = await runAgent({ executor, input: { ...base, options: { schema } } });
    expect(outcome.usage.input).toBe(2);
    expect(outcome.usage.output).toBe(2);
  });

  test("admit is called before each attempt, so a refusal prevents the call", async () => {
    const seen: number[] = [];
    const { executor, prompts } = sequence([{ value: "x" }]);
    await runAgent({ executor, input: base, admit: (attempt) => seen.push(attempt) });
    expect(seen).toEqual([1]);
    expect(prompts).toHaveLength(1);
  });

  test("a throwing admit stops the attempt before the executor runs", async () => {
    const { executor, prompts } = sequence([{ value: "x" }]);
    await expect(
      runAgent({ executor, input: base, admit: () => { throw new Error("budget exhausted"); } }),
    ).rejects.toThrow("budget exhausted");
    expect(prompts).toHaveLength(0);
  });
});

describe("runAgent failure accounting", () => {
  test("a failed or aborted agent still reports the tokens it spent", async () => {
    // The schema-repair path already carries usage through RunAgentError; the
    // failed/aborted path must too, because a timed-out agent is real spend.
    const { executor } = sequence([{ status: "failed", errorMessage: "timed out" }]);
    let caught: unknown;
    try {
      await runAgent({ executor, input: base });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as { usage?: { input?: number } }).usage?.input).toBe(1);
  });
});
