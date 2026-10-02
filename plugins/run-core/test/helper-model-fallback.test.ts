import { expect, test } from "bun:test";
import { childModelSpec, resolveHelperModel } from "../src/model-identity.ts";
import type { RegisteredModel } from "../src/isolated.ts";

const physical: RegisteredModel = {
  provider: "openai", id: "physical", api: "openai-completions", name: "physical",
  baseUrl: "http://localhost.invalid", reasoning: false, input: ["text"],
  contextWindow: 100_000, maxTokens: 1_000,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const virtual = { provider: "router", id: "auto", api: "pi-virtual" };
function context(model: any = virtual): any {
  return {
    model,
    modelRegistry: {
      find: (provider: string, id: string) => provider === physical.provider && id === physical.id
        ? physical : id === "unauthenticated" ? { provider, id } : undefined,
      hasConfiguredAuth: (candidate: any) => candidate.id !== "unauthenticated",
    },
    sessionManager: { getBranch: () => [
      { type: "message", message: { role: "assistant", provider: physical.provider, model: physical.id, stopReason: "stop" } },
      { type: "model_change", provider: model.provider, modelId: model.id },
    ] },
  };
}

test("invalid helper specs fall back to the physical answer of a virtual selection", () => {
  for (const spec of ["bare-id", "openai/missing", "openai/unauthenticated"]) {
    const result = resolveHelperModel(context(), { spec });
    expect(result.model).toBe(physical);
    expect(result.source).toBe("physical");
    expect(result.reason).toContain("using openai/physical");
  }
});

test("a newly selected physical model overrides historical answers for helpers and children", () => {
  const selected: RegisteredModel = { ...physical, provider: "anthropic", id: "new-selection", api: "anthropic-messages" };
  const ctx = context(selected);
  expect(resolveHelperModel(ctx).model).toBe(selected);
  expect(childModelSpec(ctx)).toEqual({ spec: "anthropic/new-selection" });
});
