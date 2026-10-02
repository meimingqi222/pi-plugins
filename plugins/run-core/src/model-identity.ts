/**
 * Resolving which model a helper call should run on.
 *
 * Until pi 1.0 a session had one model, so `ctx.model` was both the selection
 * the user made and the model that answered. pi 1.0 splits the two: a virtual
 * model is selectable and a router inside it picks a *physical* model per
 * request. `ctx.model`, `PI_MODEL` and `--model` all name the selection; only
 * each assistant message names the physical model that produced it.
 *
 * Helper calls break that assumption, and they break it silently:
 *
 * - `ctx.modelRegistry.complete(ctx.model, …)` with a virtual selection asks a
 *   provider named `router` for work. There are no credentials for it, so the
 *   call fails with an authentication error that names no model the user chose.
 * - `provider/id` handed to a child `pi --model` needs a model the child's own
 *   catalog can resolve. A virtual id resolves only when the extension that
 *   registered it is loaded in the child too.
 *
 * Both failures look like "the model stopped working" rather than "the wrong
 * identity was used", which is the worst kind of bug to ship to a user who just
 * installed a router extension.
 *
 * Concrete session selections are used directly. For a virtual selection, use
 * the physical model that answered the last response, falling back to the
 * selection only when nothing runnable is known.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { RegisteredModel } from "./isolated.ts";

/** A model named the way pi names it: a provider and an id inside it. */
export interface ModelIdentity {
  provider: string;
  id: string;
}

/** Where a resolved model came from, for the message a user reads. */
export type ModelSource = "spec" | "physical" | "selection";

export interface ResolvedModel {
  model: RegisteredModel | undefined;
  /** Set when the model in use is not the one the caller named. */
  reason?: string;
  /**
   * Which identity was used. `selection` means a virtual model may be in play,
   * because nothing physical was known to prefer — the caller gets to say so.
   */
  source: ModelSource;
  /** The physical identity chosen, or the selection when none was known. */
  identity: ModelIdentity | undefined;
}

/**
 * Parse `provider/id`, or `undefined` when it is not that shape.
 *
 * A bare id is rejected rather than guessed: the same id exists on several
 * providers, and picking one arbitrarily would run the call on a model the user
 * did not name. Both slash positions at the edges are rejected too — `"x/"` and
 * `"/x"` name a missing half, not a model.
 */
export function parseModelIdentity(spec: string): ModelIdentity | undefined {
  const trimmed = spec.trim();
  const slash = trimmed.indexOf("/");
  if (slash <= 0 || slash === trimmed.length - 1) return undefined;
  return { provider: trimmed.slice(0, slash), id: trimmed.slice(slash + 1) };
}

/** Render an identity the way settings and errors name one. */
export function formatModelIdentity(identity: ModelIdentity | undefined): string {
  return identity ? `${identity.provider}/${identity.id}` : "unknown";
}

/**
 * The physical model that answered the newest assistant message on the branch.
 *
 * This is the seam pi 1.0 gives an extension for "what actually ran": it records
 * the physical provider and id on every assistant message, and never a virtual
 * one. Reading it needs no new API, so it works against 0.85 as well as 1.x.
 *
 * A response that ended in `error` or `aborted` is skipped, matching pi's own
 * `findLatestResponse`: a failed or interrupted request is not a model that
 * answered, and an aborted turn can leave a partial message whose model is not
 * the one to continue on.
 *
 * Entries are read newest-first and the first qualifying assistant message wins.
 * A compaction entry's `retainedTail` holds assistant messages too, but those are
 * stale by construction — the turn that just finished is what matters.
 */
export function lastPhysicalModel(entries: readonly unknown[]): ModelIdentity | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index] as {
      type?: unknown;
      message?: {
        role?: unknown;
        provider?: unknown;
        model?: unknown;
        stopReason?: unknown;
      };
    };
    if (entry?.type !== "message") continue;
    const message = entry.message;
    if (message?.role !== "assistant") continue;
    const stopped = message.stopReason;
    if (stopped === "error" || stopped === "aborted") continue;
    if (typeof message.provider !== "string" || typeof message.model !== "string") continue;
    return { provider: message.provider, id: message.model };
  }
  return undefined;
}

/**
 * The session branch, or an empty branch when the context cannot supply one.
 *
 * A context being torn down mid-call is normal here: a background job starting
 * while the session closes must not turn into a thrown error that loses the job.
 */
function readBranch(ctx: ModelContext): readonly unknown[] {
  try {
    return ctx.sessionManager.getBranch();
  } catch {
    return [];
  }
}

/** The slice of an extension context this module reads. */
export type ModelContext = Pick<ExtensionContext, "model" | "modelRegistry" | "sessionManager">;

/**
 * Resolve the model for a helper call that must not inherit a router.
 *
 * `spec` is an explicit configuration the user wrote, and it always wins — a
 * user who names a model meant that model. An unset spec resolves in this order:
 *
 * 1. The current session selection, when it is a concrete model.
 * 2. The physical model that answered the last response, when the registry still
 *    has it and it still has credentials. This is the pre-1.0 behaviour applied
 *    to the model that actually ran.
 * 3. The session selection, with a `reason` saying a virtual model may be in
 *    play. Nothing physical is known yet, so this is today's behaviour, not a
 *    new one.
 *
 * An unknown or unauthenticated spec falls back rather than throwing: the
 * caller is usually a background job, and a typo in a model name should cost the
 * run a warning, not the run.
 */
export function resolveHelperModel(
  ctx: ModelContext,
  options: { spec?: string | ModelIdentity; purpose?: string } = {},
): ResolvedModel {
  const purpose = options.purpose ?? "helper call";
  // A raw string is the untrusted shape; a parsed identity was already checked
  // by whoever parsed it. Normalizing here keeps both callers honest.
  const raw = typeof options.spec === "string" ? options.spec.trim() : "";
  const spec =
    typeof options.spec === "object" && options.spec
      ? options.spec
      : raw
        ? parseModelIdentity(raw)
        : undefined;
  if (raw && !spec) {
    return fallbackModel(ctx, purpose, `Model "${raw}" is not provider/id`);
  }
  if (spec) {
    const found = findIdentity(ctx, spec);
    if (!found) {
      return fallbackModel(ctx, purpose, `Unknown model ${formatModelIdentity(spec)}`);
    }
    if (!ctx.modelRegistry.hasConfiguredAuth(found)) {
      return fallbackModel(ctx, purpose, `No configured authentication for ${formatModelIdentity(spec)}`);
    }
    return { model: found, source: "spec", identity: spec };
  }

  // A concrete selection is already runnable. In particular, switching models
  // must take effect before that model has produced its first response.
  const active = selectionOf(ctx);
  if (ctx.model?.api && ctx.model.api !== "pi-virtual") {
    return fromIdentity(ctx, active);
  }
  const physical = lastPhysicalModel(readBranch(ctx));
  if (physical) {
    const found = findIdentity(ctx, physical);
    if (found && ctx.modelRegistry.hasConfiguredAuth(found)) {
      return { model: found, source: "physical", identity: physical };
    }
  }

  const resolved = fromIdentity(ctx, active);
  return {
    ...resolved,
    reason: physical
      ? `${formatModelIdentity(physical)} is no longer available; using ${formatModelIdentity(active)}.`
      : `No physical model has answered yet, so this ${purpose} uses the session selection ${formatModelIdentity(active)}, which may be a virtual model.`,
    source: "selection",
  };
}

function fallbackModel(ctx: ModelContext, purpose: string, problem: string): ResolvedModel {
  const resolved = resolveHelperModel(ctx, { purpose });
  const warning = resolved.reason ? ` ${resolved.reason}` : "";
  return {
    ...resolved,
    reason: `${problem}; using ${formatModelIdentity(resolved.identity)}.${warning}`,
  };
}

/** The session's current selection, which may be a virtual model. */
function selectionOf(ctx: ModelContext): ModelIdentity | undefined {
  const model = ctx.model;
  if (!model || typeof model.provider !== "string" || typeof model.id !== "string") return undefined;
  return { provider: model.provider, id: model.id };
}

function findIdentity(ctx: ModelContext, identity: ModelIdentity): RegisteredModel | undefined {
  try {
    return ctx.modelRegistry.find(identity.provider, identity.id) ?? undefined;
  } catch {
    return undefined;
  }
}

function fromIdentity(ctx: ModelContext, identity: ModelIdentity | undefined): Omit<ResolvedModel, "reason"> {
  // The session selection is used as-is rather than looked up again: `ctx.model`
  // already *is* that model object, and a registry round-trip would only add a
  // way for a model the session is running on to resolve to nothing.
  const found =
    identity && ctx.model && ctx.model.provider === identity.provider && ctx.model.id === identity.id
      ? ctx.model
      : identity
        ? findIdentity(ctx, identity)
        : undefined;
  return { model: found, source: "selection", identity };
}

/**
 * The model spec to hand a child process, as `provider/id`.
 *
 * Defaults to the current concrete selection, or the last physical answer for
 * a virtual selection, for the same reason a judge does: a child pi
 * resolves `--model` against its own catalog, and a virtual id only resolves
 * when the router extension is loaded in the child as well. Whether it is depends
 * on where the user installed it, not on anything the parent can see, so the safe
 * default is the identity both worlds resolve.
 *
 * `policy: "selection"` opts into passing the selection instead, for a user who
 * has the router installed where children load it too and wants them routed.
 */
export function childModelSpec(
  ctx: ModelContext,
  options: { policy?: "physical" | "selection" } = {},
): { spec: string | undefined; reason?: string } {
  const policy = options.policy ?? "physical";
  const active = selectionOf(ctx);
  if (policy === "selection") {
    return { spec: active ? formatModelIdentity(active) : undefined };
  }
  const resolved = resolveHelperModel(ctx, { purpose: "child run" });
  if (resolved.source === "physical" || !resolved.reason) {
    return { spec: formatModelIdentity(resolved.identity) };
  }
  // No session model at all — a headless context, or one torn down mid-call.
  // There is nothing to inherit and nothing to warn about, so this stays silent
  // rather than reporting a fallback the user did not make.
  if (!active) return { spec: undefined };
  return {
    spec: formatModelIdentity(active),
    reason: `No physical model has answered yet, so the child inherits the session selection ${formatModelIdentity(active)}, which it can resolve only if the same extensions are loaded there.`,
  };
}
