/**
 * Running one workflow agent.
 *
 * The runner is injected rather than called directly, for two reasons:
 *
 * 1. **Testability.** The orchestration (budget, journal, schema retry, fan-out)
 *    is where the logic lives, and it can be tested completely with a fake
 *    runner. Spawning a real pi process in a test would make the suite depend on
 *    provider auth and a network, and would be the slowest possible way to check
 *    a retry loop.
 * 2. **Reuse.** `pi-goal`'s verifier and a future caller need the same
 *    "structured reply with bounded repair" behaviour without a subprocess.
 *
 * The real runner lives in `pi/runner.ts` and spawns pi; it is the last thing
 * wired, once everything it depends on is already tested.
 */

import { validateWorkflowSchema } from "../core/schema.ts";
import { isReadOnlyRole } from "./roles.ts";
import { mergeWorkflowUsage, type WorkflowAgentOptions, type WorkflowAgentRunInput, type WorkflowAgentRunResult, type WorkflowUsage } from "../core/types.ts";

/** Executes one agent and returns its raw result. Injected by the caller. */
export type AgentExecutor = (input: WorkflowAgentRunInput) => Promise<WorkflowAgentRunResult>;

export interface RunAgentOptions {
  executor: AgentExecutor;
  input: WorkflowAgentRunInput;
  /** Attempts allowed when a structured reply does not satisfy its schema. */
  maxAttempts?: number;
  /** Re-runs allowed when the child died of a transport failure. Defaults to the env budget for a read-only role, 0 otherwise. */
  transportRetries?: number;
  /** Called before each attempt, so the caller can enforce admission. */
  admit?(attempt: number): void;
  signal?: AbortSignal;
}

export interface RunAgentOutcome {
  value: unknown;
  usage: WorkflowUsage;
  attempts: number;
  /** The model that answered, when the executor reports one. */
  model?: string;
}

const DEFAULT_MAX_ATTEMPTS = 3;

const DEFAULT_TRANSPORT_RETRIES = 1;

/**
 * Transport failures: the child produced no answer because the connection did.
 *
 * Matched on the provider's own wording, and deliberately narrower than pi's
 * internal retryable classes — this is a second chance at the *workflow* level,
 * and it must not fire on a failure that repeating would reproduce.
 *
 * Excluded on purpose, each for a reason:
 * - **The run's own cap** (`The agent timed out after…`): the child hit
 *   `agentTimeoutMs`, and a re-run hits it again with the same bill.
 * - **Quota and routing** (`429`, `no available route`, `out of budget`): not
 *   transient within one run, and the user has to change something.
 * - **Saturation** (`concurrency reached`): retrying makes it worse, not better.
 * - **Schema and policy failures**: those are answers, not transport losses.
 *
 * `Connection error.` is included even though pi retries it internally: pi's
 * budget can be spent on a flaky-attempt streak, and one whole-child re-run has
 * a different failure mode from three re-requests of the same stream.
 */
export const TRANSPORT_FAILURE_PATTERN = new RegExp(
  [
    "upstream stream ended",
    "stream ended before",
    "ended without",
    "connection error",
    "connection refused",
    "connection lost",
    "connection reset",
    "socket hang up",
    "other side closed",
    "fetch failed",
    "network error",
    "http2 request did not get a response",
  ].join("|"),
  "i",
);

/** Whether a child's failure looks like a lost connection rather than an answer. */
export function isTransportFailure(message: string): boolean {
  return TRANSPORT_FAILURE_PATTERN.test(message);
}

/**
 * Re-runs allowed for a transport failure, per call.
 *
 * `PI_WORKFLOW_TRANSPORT_RETRIES` overrides it; `0` disables. This is separate
 * from the schema budget because the two buy different things: schema repair
 * buys a correct shape, this buys back a call that produced nothing at all.
 *
 * It applies only to a provably read-only role (see `isReadOnlyRole`). A child
 * that may have written before it died cannot be re-run blind — a duplicated
 * edit or a second `git commit` is worse than a missing answer — so the default
 * is one re-run where it is safe and none where it is not.
 */
export function transportRetryBudget(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.PI_WORKFLOW_TRANSPORT_RETRIES;
  if (raw === undefined || raw.trim() === "") return DEFAULT_TRANSPORT_RETRIES;
  const value = Number(raw.trim());
  if (!Number.isFinite(value) || value < 0) return DEFAULT_TRANSPORT_RETRIES;
  return Math.floor(value);
}

/**
 * A `runAgent` failure that carries the tokens its attempts already spent.
 *
 * A schema-repair attempt is a real model call, often the most expensive one,
 * and it is the one that fails. Throwing a bare Error drops that usage, so a run
 * where every call failed reports zero tokens — the token budget then cannot see
 * money it has already lost, and the caller cannot tell a cheap failure from an
 * expensive one.
 */
export class RunAgentError extends Error {
	readonly usage: WorkflowUsage;

	constructor(message: string, usage: WorkflowUsage) {
		super(message);
		this.name = "RunAgentError";
		this.usage = usage;
	}
}

/**
 * Bound the transcript excerpt appended to a schema-repair retry.
 *
 * A model that returned a huge wrong answer must not make the next attempt
 * larger than the first; the excerpt names the mistake, it does not reproduce it.
 */
const MAX_REPAIR_EXCERPT = 2_000;

/**
 * Append the structured-output contract to a prompt.
 *
 * The schema is serialized into the prompt because the child is a plain pi
 * session with no knowledge of workflows — it has to be told what shape to
 * return. The output is treated as a contract the harness enforces afterwards,
 * not as a suggestion.
 */
export function buildAgentPrompt(prompt: string, schema: unknown): string {
  if (!schema || typeof schema !== "object") return prompt;
  let serialized: string;
  try {
    serialized = JSON.stringify(schema);
  } catch {
    return prompt;
  }
  return [
    prompt,
    "",
    "<workflow-structured-output>",
    "Return exactly one JSON value matching this JSON Schema. Do not wrap it in Markdown fences or add commentary.",
    serialized.slice(0, 32_000),
    "</workflow-structured-output>",
  ].join("\n");
}

/**
 * Parse a model reply into a structured value.
 *
 * A fenced block is unwrapped because producing one is a formatting habit rather
 * than a different answer. A reply that is not JSON at all is a failure the retry
 * loop should see, so it throws rather than returning the raw text — silently
 * passing text through where a schema was requested would make `agent()`'s
 * contract depend on the model's mood.
 */
export function parseStructuredReply(text: string): unknown {
  const trimmed = text.trim();
  const unwrapped = trimmed.replace(/^```(?:json)?\s*/iu, "").replace(/\s*```$/u, "").trim();
  return JSON.parse(unwrapped);
}

/**
 * Run one agent, enforcing a declared schema with bounded repair.
 *
 * A schema mismatch is retried with the validation errors appended, because a
 * model that returned the wrong shape usually can fix it when told exactly what
 * was wrong. The attempt is capped: a model that cannot satisfy the schema after
 * a few tries is not going to, and each attempt is billed.
 */
export async function runAgent(options: RunAgentOptions): Promise<RunAgentOutcome> {
  const { executor, input } = options;
  const schema = input.options.schema;
  const maxAttempts = Math.max(1, input.options.retries ?? options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
  const base = buildAgentPrompt(input.prompt, schema);
  // The read-only gate is not overridable: a caller can raise the budget, but
  // only for a role where re-running cannot duplicate an effect.
  const transportBudget = isReadOnlyRole(input.options.toolProfile)
    ? (options.transportRetries ?? transportRetryBudget())
    : 0;

  let usage: WorkflowUsage | undefined;
  let lastError = "The agent returned no result";
  let lastText = "";
  let model: string | undefined;
  // What the previous attempt died of decides the next prompt: a schema repair
  // block is an answer to a wrong shape, and appending it after a transport loss
  // would ask the model to fix a reply it never made.
  let repair = false;
  let transportUsed = 0;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    options.admit?.(attempt);
    const prompt = !repair
      ? base
      : [
          base,
          "",
          "<workflow-schema-repair>",
          `Your previous reply did not satisfy the schema. Error: ${lastError}`,
          "Previous reply (truncated):",
          lastText.slice(0, MAX_REPAIR_EXCERPT),
          "Return a corrected JSON value only.",
          "</workflow-schema-repair>",
        ].join("\n");

    const result = await executor({ ...input, prompt });
    usage = mergeWorkflowUsage(usage ?? emptyUsage(), result.usage);
    if (result.model) model = result.model;

    // A timed-out or aborted agent is real spend too — often the most expensive
    // call, because it ran until the cap. Carrying its usage is what keeps the
    // run's accounting honest on the failure path, not only on a schema retry.
    if (result.status === "failed" || result.status === "aborted") {
      const message = result.errorMessage ?? `The agent ${result.status}`;
      // An abort is the user's decision, and a transport loss is nobody's: only
      // the second is worth a second child, and only where re-running cannot
      // duplicate an effect.
      if (
        result.status === "failed" &&
        transportUsed < transportBudget &&
        attempt < maxAttempts &&
        isTransportFailure(message)
      ) {
        transportUsed += 1;
        lastError = message;
        repair = false;
        continue;
      }
      throw new RunAgentError(message, usage ?? emptyUsage());
    }

    // No schema: the reply text is the value.
    if (!schema || typeof schema !== "object") {
      return { value: result.value ?? result.text ?? "", usage: usage ?? emptyUsage(), attempts: attempt, model };
    }

    // An executor that already parsed a structured value is trusted, but still
    // validated: the contract belongs to the script, not to the executor.
    const candidate = result.value !== undefined ? result.value : tryParse(result.text);
    if (candidate === undefined) {
      lastError = "The reply was not JSON";
      lastText = result.text ?? "";
      repair = true;
      continue;
    }
    const validation = validateWorkflowSchema(schema, candidate, true);
    if (validation.valid) {
      return { value: validation.value, usage: usage ?? emptyUsage(), attempts: attempt, model };
    }
    lastError = validation.errors.join("; ");
    lastText = typeof result.text === "string" ? result.text : safeStringify(candidate);
    repair = true;
  }

  throw new RunAgentError(
    `The agent did not satisfy its schema after ${maxAttempts} attempt${maxAttempts === 1 ? "" : "s"}: ${lastError}`,
    usage ?? emptyUsage(),
  );
}

function tryParse(text: string | undefined): unknown {
  if (text === undefined) return undefined;
  try {
    return parseStructuredReply(text);
  } catch {
    return undefined;
  }
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}

function emptyUsage(): WorkflowUsage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
}

export type { WorkflowAgentOptions };
