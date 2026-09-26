/**
 * Shared subprocess agent runner for pi extensions.
 *
 * A library, not an extension: it declares no `pi` manifest and registers
 * nothing. `pi-workflow` and `pi-subagent` both spawn authenticated pi children
 * in JSON mode, and the process handling — a closed stdin, a wall-clock kill, a
 * continuous stdout drain, the one-level fan-out environment — is subtle enough
 * that two copies had already drifted. It lives here once.
 *
 * Policy stays in the plugins: role→tool mapping, schema repair, transport retry,
 * the child shell guard, and what a result means all belong to the caller.
 */

export {
  forwardedExecArgs,
  isVirtualScript,
  jsonRunArgs,
  resolvePiInvocation,
  whichPi,
  type PiInvocation,
} from "./spawn.ts";
export {
  DEFAULT_AGENT_TIMEOUT_MS,
  SCHEDULER_DISABLE_FLAGS,
  agentChildEnv,
  applyEvent,
  buildAgentArgs,
  createAgentExecutor,
  emptyAgentUsage,
  emptyStreamState,
  readAgentActivity,
  readAgentProgress,
  readText,
  type AgentExecutor,
  type AgentExecutorOptions,
  type AgentActivity,
  type AgentActivityPhase,
  type AgentRunInput,
  type AgentRunResult,
  type AgentProgress,
  type AgentUsage,
  type StreamState,
} from "./executor.ts";
