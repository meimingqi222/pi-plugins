/**
 * An isolated, tool-free model call.
 *
 * Used for judgment rather than work: verifying a claim, checking completion,
 * planning. Isolation is the point. The call gets its own `messages` array, so
 * the implementer's reasoning never reaches the judge, and `tools: []` so the
 * judge cannot investigate and cannot accidentally act. A judge that shares the
 * implementer's transcript is the weakest possible judge — the mistake just made
 * is the one it will fail to see.
 *
 * The deadline is part of the contract rather than the caller's problem. A
 * provider may ignore an abort signal, so this races the request against a timer
 * and a cancellation promise, and observes the losing rejection so an
 * uncooperative provider cannot surface an unhandled error. A late result is
 * discarded, never applied.
 *
 * Redaction is applied by the caller, not here. Deciding what is safe to send is
 * a policy the caller owns; this module's job is to make the call and honour the
 * deadline.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/** Default deadline for a judgment call. Long enough for a real read, short enough to be noticed. */
export const DEFAULT_JUDGE_TIMEOUT_MS = 45_000;

/**
 * The model type the registry hands out, derived rather than imported.
 *
 * `@earendil-works/pi-ai` is a transitive dependency of the coding agent, not a
 * dependency of these plugins, so naming `Model` directly would mean adding one
 * just for a type. `find` returns exactly this and `ctx.model` is the same type,
 * so deriving it keeps both sides in sync with the API automatically.
 */
export type RegisteredModel = NonNullable<ReturnType<ExtensionContext["modelRegistry"]["find"]>>;

export interface IsolatedCallInput {
  /** System prompt stating the judge's contract. */
  systemPrompt: string;
  /** Untrusted payload. Serialized into a single user message; never interpolated into the prompt. */
  payload: unknown;
  model: RegisteredModel | undefined;
  signal: AbortSignal;
  timeoutMs?: number;
}

export interface IsolatedCallResult {
  stopReason: string;
  /** Concatenated text parts, joined with a newline. */
  text: string;
  /** True when the call ended with `stop` and returned no tool call. */
  clean: boolean;
  /** Input+output tokens billed for this call, for run accounting. */
  usage: number;
}

function natural(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** Tokens billed for one assistant message, or 0 when it carries no usage. */
export function readTokenUsage(message: unknown): number {
  if (!message || typeof message !== "object") return 0;
  const value = (message as { usage?: Record<string, unknown> }).usage;
  if (!value) return 0;
  if (natural(value.totalTokens)) return value.totalTokens;
  return ["input", "output", "cacheRead", "cacheWrite"].reduce(
    (sum, key) => sum + (natural(value[key]) ? value[key] : 0),
    0,
  );
}

/**
 * Race a start function against its deadline.
 *
 * Exported because a caller's planner needs the same semantics, and a second
 * implementation would be the place the timeout quietly differs.
 */
export interface DeadlineOptions {
  /** Milliseconds before the controller is aborted. */
  timeoutMs?: number;
  /**
   * Name used in the cancellation and timeout messages.
   *
   * A shared primitive still has to produce a message its caller's user can act
   * on: "Call timed out" is useless where "Verification timed out" is not.
   */
  label?: string;
}

/**
 * Race a start function against its deadline.
 *
 * Exported because a caller's planner needs the same semantics, and a second
 * implementation would be the place the timeout quietly differs.
 */
export async function withDeadline<T>(
  start: () => Promise<T>,
  controller: AbortController,
  timeoutMs = DEFAULT_JUDGE_TIMEOUT_MS,
  label = "Call",
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort = (): void => {};
  const cancelled = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(controller.signal.reason ?? new Error(`${label} cancelled`));
    controller.signal.addEventListener("abort", onAbort, { once: true });
    if (controller.signal.aborted) onAbort();
    else timer = setTimeout(() => controller.abort(new Error(`${label} timed out`)), timeoutMs);
  });
  try {
    controller.signal.throwIfAborted();
    return await Promise.race([start(), cancelled]);
  } finally {
    if (timer) clearTimeout(timer);
    controller.signal.removeEventListener("abort", onAbort);
    // The losing promise is still observed, so a provider that ignores the
    // signal cannot raise an unhandled rejection after the race has settled.
    void cancelled.catch(() => {});
  }
}

/**
 * Run one isolated judgment call.
 *
 * Throws when the model has no configured authentication, and when the provider
 * itself fails — the caller decides whether that pauses a run. A result with
 * `clean: false` is returned rather than thrown, because "the model answered
 * with prose instead of the required shape" is a verdict the caller can
 * sometimes repair, while a provider error never is.
 */
export async function isolatedComplete(
  ctx: Pick<ExtensionContext, "modelRegistry">,
  input: IsolatedCallInput,
): Promise<IsolatedCallResult> {
  const { model, signal, systemPrompt, payload } = input;
  if (!model || !ctx.modelRegistry.hasConfiguredAuth(model)) {
    throw new Error("The judge model has no configured authentication");
  }
  const controller = new AbortController();
  if (signal.aborted) controller.abort(signal.reason);
  else if (typeof signal.addEventListener === "function") {
    signal.addEventListener("abort", () => controller.abort(signal.reason), { once: true });
  }
  const message = await withDeadline(
    () =>
      ctx.modelRegistry.complete(model, {
        systemPrompt,
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: JSON.stringify(payload) }],
            timestamp: Date.now(),
          },
        ],
        // No tools: the judge reads evidence, it does not gather it.
        tools: [],
      // `complete` is pi's provider-neutral nested-call helper. It is typed for
      // a specific api; the registry narrows it, so the cast keeps the call
      // site honest about the model it was resolved from.
      } as never, { signal: controller.signal } as never),
    controller,
    input.timeoutMs,
  );
  const result = message as { stopReason?: unknown; content?: unknown; usage?: unknown };
  const parts = Array.isArray(result.content) ? result.content : [];
  const text = parts
    .filter((part): part is { type: string; text: string } =>
      !!part && typeof part === "object" && (part as { type?: unknown }).type === "text" &&
      typeof (part as { text?: unknown }).text === "string")
    .map((part) => part.text)
    .join("\n");
  const stopReason = typeof result.stopReason === "string" ? result.stopReason : "error";
  const hasToolCall = parts.some(
    (part) => !!part && typeof part === "object" && (part as { type?: unknown }).type === "toolCall",
  );
  return {
    stopReason,
    text,
    clean: stopReason === "stop" && !hasToolCall,
    usage: readTokenUsage(message),
  };
}

/**
 * Parse one JSON object out of a judgment reply, rejecting anything else.
 *
 * The reply is model output and is treated as untrusted: a fenced block is
 * unwrapped because that is a formatting habit rather than a different answer,
 * but a reply that is not a single object is an error the caller must handle
 * rather than something to search for a substring in.
 */
export function parseJsonReply<T>(raw: string, validate: (value: unknown) => value is T): T {
  const text = raw.trim().replace(/^```(?:json)?\s*/iu, "").replace(/\s*```$/u, "").trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("The reply was not a single JSON value");
  }
  if (!validate(parsed)) throw new Error("The reply did not match the required shape");
  return parsed;
}
