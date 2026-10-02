import { expect, test } from "bun:test";
import {
  childModelSpec,
  formatModelIdentity,
  lastPhysicalModel,
  parseModelIdentity,
  resolveHelperModel,
} from "../src/model-identity.ts";

/** A registry stub shaped like the one these plugins already fake. */
function registry(catalog: Record<string, unknown> = {}, authed: string[] = []) {
  return {
    hasConfiguredAuth: (model: any) => authed.length === 0 || authed.includes(`${model?.provider}/${model?.id}`),
    find: (_provider: string, id: string) => (catalog[id] as any) ?? undefined,
  };
}

/** A ctx whose session selection may be a virtual model. */
function ctx(options: {
  model?: { provider: string; id: string };
  physical?: { provider: string; id: string };
  catalog?: Record<string, unknown>;
  authed?: string[];
  throws?: boolean;
}) {
  const branch: unknown[] = options.physical
    ? [{ type: "message", message: { role: "assistant", provider: options.physical.provider, model: options.physical.id } }]
    : [];
  return {
    model: options.model,
    modelRegistry: registry(options.catalog ?? {}, options.authed),
    sessionManager: {
      getBranch: () => {
        if (options.throws) throw new Error("context torn down");
        return branch;
      },
    },
  } as any;
}

test("parse accepts provider/id and rejects every shape that is not one", () => {
  expect(parseModelIdentity("anthropic/claude-sonnet-4-5")).toEqual({ provider: "anthropic", id: "claude-sonnet-4-5" });
  expect(parseModelIdentity(" router/auto ")).toEqual({ provider: "router", id: "auto" });
  for (const bad of ["", "claude-sonnet-4-5", "/auto", "router/", "/", "router"]) {
    expect(parseModelIdentity(bad)).toBeUndefined();
  }
});

test("format renders an unknown identity without throwing", () => {
  expect(formatModelIdentity({ provider: "anthropic", id: "x" })).toBe("anthropic/x");
  expect(formatModelIdentity(undefined)).toBe("unknown");
});

test("lastPhysicalModel reads the newest assistant message, not a stale tail", () => {
  const entries = [
    { type: "compaction", retainedTail: [{ role: "assistant", provider: "old", model: "stale" }] },
    { type: "message", message: { role: "user", content: "hi" } },
    { type: "message", message: { role: "assistant", provider: "first", model: "m1" } },
    // Newest wins even though an older assistant message also names a model.
    { type: "message", message: { role: "assistant", provider: "anthropic", model: "claude-sonnet-4-5" } },
  ];
  expect(lastPhysicalModel(entries)).toEqual({ provider: "anthropic", id: "claude-sonnet-4-5" });
  expect(lastPhysicalModel([])).toBeUndefined();
  expect(lastPhysicalModel([{ type: "message", message: { role: "user" } }])).toBeUndefined();
});

// pi 1.0's own findLatestResponse skips `error` and `aborted` responses, and this
// must agree with it: an aborted turn leaves a partial message whose model is not
// the one the session should hand a judge or a child.
test("lastPhysicalModel skips responses that ended in error or aborted", () => {
  const answered = { type: "message", message: { role: "assistant", provider: "anthropic", model: "claude-sonnet-4-5", stopReason: "stop" } };
  for (const stopReason of ["error", "aborted"]) {
    const dead = { type: "message", message: { role: "assistant", provider: "broken", model: "nope", stopReason } };
    expect(lastPhysicalModel([answered, dead])).toEqual({ provider: "anthropic", id: "claude-sonnet-4-5" });
  }
  // Every response failed, so nothing answered: no model to offer.
  const dead = { type: "message", message: { role: "assistant", provider: "broken", model: "nope", stopReason: "error" } };
  expect(lastPhysicalModel([dead])).toBeUndefined();
});

test("physical selection is preferred over a virtual session selection", () => {
  const context = ctx({
    model: { provider: "jev", id: "auto" },
    physical: { provider: "openai-codex", id: "gpt-5.6-luna" },
    catalog: { "gpt-5.6-luna": { provider: "openai-codex", id: "gpt-5.6-luna" } },
  });
  const resolved = resolveHelperModel(context, { purpose: "verification" });
  expect(resolved.source).toBe("physical");
  expect(resolved.identity).toEqual({ provider: "openai-codex", id: "gpt-5.6-luna" });
  expect(resolved.reason).toBeUndefined();
});

test("an explicit spec wins and is reported as the source", () => {
  const context = ctx({
    model: { provider: "jev", id: "auto" },
    physical: { provider: "openai-codex", id: "gpt-5.6-luna" },
    catalog: {
      "gpt-5.6-luna": { provider: "openai-codex", id: "gpt-5.6-luna" },
      "claude-haiku-4-5": { provider: "anthropic", id: "claude-haiku-4-5" },
    },
  });
  const resolved = resolveHelperModel(context, { spec: "anthropic/claude-haiku-4-5" });
  expect(resolved.source).toBe("spec");
  expect(resolved.identity).toEqual({ provider: "anthropic", id: "claude-haiku-4-5" });
  expect(resolved.reason).toBeUndefined();
});

test("an unshaped spec falls back to the selection with a reason, never a guess", () => {
  const context = ctx({ model: { provider: "anthropic", id: "claude-sonnet-4-5" } });
  const resolved = resolveHelperModel(context, { spec: "claude-sonnet-4-5" });
  expect(resolved.source).toBe("selection");
  expect(resolved.reason).toContain("not provider/id");
  expect(resolved.identity).toEqual({ provider: "anthropic", id: "claude-sonnet-4-5" });
});

test("an unknown spec falls back rather than throwing", () => {
  const context = ctx({
    model: { provider: "anthropic", id: "claude-sonnet-4-5" },
    catalog: { "claude-sonnet-4-5": { provider: "anthropic", id: "claude-sonnet-4-5" } },
  });
  const resolved = resolveHelperModel(context, { spec: "anthropic/nope" });
  expect(resolved.identity).toEqual({ provider: "anthropic", id: "claude-sonnet-4-5" });
  expect(resolved.reason).toContain("Unknown model");
});

test("a spec whose provider has no credentials falls back rather than throwing", () => {
  const context = ctx({
    model: { provider: "anthropic", id: "claude-sonnet-4-5" },
    catalog: { "gpt-5.6": { provider: "openai", id: "gpt-5.6" } },
    authed: ["anthropic/claude-sonnet-4-5"],
  });
  const resolved = resolveHelperModel(context, { spec: "openai/gpt-5.6" });
  expect(resolved.identity).toEqual({ provider: "anthropic", id: "claude-sonnet-4-5" });
  expect(resolved.reason).toContain("No configured authentication");
});

test("with nothing physical known the selection is used and says it may be virtual", () => {
  const context = ctx({
    model: { provider: "jev", id: "auto" },
    catalog: { auto: { provider: "jev", id: "auto" } },
  });
  const resolved = resolveHelperModel(context, { purpose: "verification" });
  expect(resolved.source).toBe("selection");
  expect(resolved.identity).toEqual({ provider: "jev", id: "auto" });
  expect(resolved.reason).toContain("may be a virtual model");
});

test("a physical model whose credentials are gone falls back to the selection", () => {
  const context = ctx({
    model: { provider: "anthropic", id: "claude-sonnet-4-5" },
    physical: { provider: "openai", id: "gpt-5.6" },
    catalog: { "claude-sonnet-4-5": { provider: "anthropic", id: "claude-sonnet-4-5" } },
    authed: ["anthropic/claude-sonnet-4-5"],
  });
  const resolved = resolveHelperModel(context);
  expect(resolved.source).toBe("selection");
  expect(resolved.identity).toEqual({ provider: "anthropic", id: "claude-sonnet-4-5" });
  expect(resolved.reason).toContain("no longer available");
});

test("a torn-down context degrades to the selection instead of throwing", () => {
  const context = ctx({ model: { provider: "anthropic", id: "x" }, throws: true });
  const resolved = resolveHelperModel(context);
  expect(resolved.identity).toEqual({ provider: "anthropic", id: "x" });
  expect(resolved.reason).toContain("No physical model has answered yet");
});

test("a session with no model at all resolves to undefined without a model object", () => {
  const resolved = resolveHelperModel(ctx({}));
  expect(resolved.model).toBeUndefined();
  expect(resolved.identity).toBeUndefined();
  expect(resolved.source).toBe("selection");
});

test("child spec defaults to the physical model a child can resolve", () => {
  const context = ctx({
    model: { provider: "jev", id: "auto" },
    physical: { provider: "openai-codex", id: "gpt-5.6-luna" },
    catalog: { "gpt-5.6-luna": { provider: "openai-codex", id: "gpt-5.6-luna" } },
  });
  const child = childModelSpec(context);
  expect(child.spec).toBe("openai-codex/gpt-5.6-luna");
  expect(child.reason).toBeUndefined();
});

test("child spec with no physical answer inherits the selection and warns", () => {
  const context = ctx({ model: { provider: "jev", id: "auto" } });
  const child = childModelSpec(context);
  expect(child.spec).toBe("jev/auto");
  expect(child.reason).toContain("inherits the session selection");
});

test("child policy selection passes the virtual selection verbatim", () => {
  const context = ctx({
    model: { provider: "jev", id: "auto" },
    physical: { provider: "openai-codex", id: "gpt-5.6-luna" },
  });
  const child = childModelSpec(context, { policy: "selection" });
  expect(child.spec).toBe("jev/auto");
  expect(child.reason).toBeUndefined();
});

test("a purely physical session keeps today's child spec exactly", () => {
  const context = ctx({
    model: { provider: "anthropic", id: "claude-sonnet-4-5" },
    physical: { provider: "anthropic", id: "claude-sonnet-4-5" },
    catalog: { "claude-sonnet-4-5": { provider: "anthropic", id: "claude-sonnet-4-5" } },
  });
  expect(childModelSpec(context).spec).toBe("anthropic/claude-sonnet-4-5");
  // A child spawned before the first response still gets the selection, as today.
  expect(childModelSpec(ctx({ model: { provider: "anthropic", id: "claude-sonnet-4-5" } })).spec).toBe(
    "anthropic/claude-sonnet-4-5",
  );
});

// A headless context has no model, and the pre-1.0 code passed no `--model` and
// said nothing. Emitting a fallback warning here would be reporting a decision
// the user never faced, and it displaces the notices a caller surfaces.
test("a context with no session model yields no spec and no warning", () => {
  const child = childModelSpec(ctx({}));
  expect(child.spec).toBeUndefined();
  expect(child.reason).toBeUndefined();
});
