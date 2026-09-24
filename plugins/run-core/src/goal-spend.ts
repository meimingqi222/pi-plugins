import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export const GOAL_SPEND_SERVICE = "pi-goal:spend-service:v1";
export const GOAL_SPEND_REQUEST = "pi-goal:spend-request:v1";

/** One delegated call belongs to the goal active when it was launched. */
export interface GoalSpendLease {
  finish(tokens: number): void;
}

export interface GoalSpendService {
  begin(ctx: ExtensionContext, callId: string): GoalSpendLease | undefined;
}

/** Load-order independent discovery; the provider also announces on registration. */
export function connectGoalSpend(pi: ExtensionAPI): () => GoalSpendService | undefined {
  let service: GoalSpendService | undefined;
  pi.events?.on(GOAL_SPEND_SERVICE, (value) => {
    if (value && typeof value === "object" && typeof (value as GoalSpendService).begin === "function") {
      service = value as GoalSpendService;
    }
  });
  pi.events?.emit(GOAL_SPEND_REQUEST, undefined);
  return () => service;
}
