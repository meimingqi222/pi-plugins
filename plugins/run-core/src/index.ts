/**
 * Shared run primitives for pi extensions that own a run rather than a turn.
 *
 * A "run" here is an execution with its own identity, budget, and snapshot:
 * `pi-goal`'s goal work run and a future `pi-workflow` run are the two intended
 * consumers. The pieces live in one package because they are small, subtle, and
 * have each already been the site of a real bug — copied, they would drift, and
 * the drift would be silent.
 *
 * The package is a library, not an extension: it declares no `pi` manifest and
 * registers nothing. A plugin depends on it in one direction, which keeps every
 * plugin independently installable.
 */

export { ActiveTimer, readTokenUsage } from "./usage.ts";
export { RunGuard, type RunToken } from "./guard.ts";
export {
  RunBudget,
  RunBudgetExceeded,
  type RunBudgetLimits,
  type RunBudgetState,
} from "./budget.ts";
export { appendRunSnapshot, restoreLatestRun, type RunSnapshotBase, type SnapshotValidator } from "./snapshot.ts";
export {
  ContinuationChannel,
  type ContinuationContent,
  type ContinuationDelivery,
  type ContinuationMode,
} from "./deliver.ts";
export {
  DEFAULT_JUDGE_TIMEOUT_MS,
  isolatedComplete,
  parseJsonReply,
  withDeadline,
  type IsolatedCallInput,
  type IsolatedCallResult,
  type RegisteredModel,
} from "./isolated.ts";
