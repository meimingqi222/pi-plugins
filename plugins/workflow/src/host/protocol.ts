/**
 * Messages between the script host's worker and its parent.
 *
 * Transport-neutral: the worker communicates over `postMessage` with structured
 * clone, so there is no line framing to parse and a value that is not
 * serializable is a bug rather than a truncated wire. The message set is still
 * JSON-shaped, which keeps the journal and any future transport consistent.
 *
 * Direction:
 *   worker → parent: `agent` and `budget` are requests needing a reply; `phase`,
 *                    `log`, and the terminal `complete`/`error` are notifications.
 *   parent → worker: `agent-result` and `budget-result` answer a request by id.
 *
 * Every request carries an id so replies cannot be matched positionally. A
 * terminated worker leaves requests unanswered, which the parent resolves when
 * the worker exits rather than waiting for a reply that cannot come.
 */

import type { WorkflowAgentOptions } from "../core/types.ts";

export interface WorkerAgentRequest {
  kind: "agent";
  id: string;
  prompt: string;
  options: WorkflowAgentOptions;
}

/** A child asking for its budget. Cross-thread state cannot be read synchronously. */
export interface WorkerBudgetRequest {
  kind: "budget";
  id: string;
}

/**
 * A panel's preview: may `calls` more agents be admitted?
 *
 * Sent by `parallel()` before its tasks start, so a panel that would cross the
 * agent limit is refused whole rather than half-run. Arbitrary pipeline stages
 * cannot predict their agent call count and rely on per-call admission instead.
 * It deliberately does not reserve — each task still admits its own call, and
 * reserving here would count them twice.
 */
export interface WorkerAdmitRequest {
  kind: "admit";
  id: string;
  calls: number;
}

export interface WorkerPhaseEvent {
  kind: "phase";
  title: string;
}

export interface WorkerLogEvent {
  kind: "log";
  message: string;
}

export interface WorkerCompleteEvent {
  kind: "complete";
  value: unknown;
  meta: unknown;
}

export interface WorkerErrorEvent {
  kind: "error";
  message: string;
  stack?: string;
}

export type WorkerMessage =
  | WorkerAgentRequest
  | WorkerBudgetRequest
  | WorkerAdmitRequest
  | WorkerPhaseEvent
  | WorkerLogEvent
  | WorkerCompleteEvent
  | WorkerErrorEvent;

export interface HostAgentResult {
  kind: "agent-result";
  id: string;
  ok: boolean;
  value?: unknown;
  error?: string;
  /** Input+output tokens, for run accounting. */
  tokens?: number;
  /**
   * The run's total token spend after this call. The worker's `budget.spent`
   * global is refreshed from it, since the real counter lives in the parent
   * and the script cannot read it synchronously.
   */
  spent?: number;
}

export interface HostBudgetResult {
  kind: "budget-result";
  id: string;
  total: number | null;
  spent: number;
  remaining: number | null;
}

/** The answer to a panel's preview. `ok: false` carries why it was refused. */
export interface HostAdmitResult {
  kind: "admit-result";
  id: string;
  ok: boolean;
  error?: string;
}

export type HostMessage = HostAgentResult | HostBudgetResult | HostAdmitResult;

/** Runtime guard for a message arriving from the worker, which is untrusted. */
export function isWorkerMessage(value: unknown): value is WorkerMessage {
  if (!value || typeof value !== "object") return false;
  const kind = (value as { kind?: unknown }).kind;
  return (
    kind === "agent" ||
    kind === "budget" ||
    kind === "admit" ||
    kind === "phase" ||
    kind === "log" ||
    kind === "complete" ||
    kind === "error"
  );
}
