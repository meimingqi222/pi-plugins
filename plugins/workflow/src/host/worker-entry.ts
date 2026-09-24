/**
 * The script host worker's source, plus the code that runs it.
 *
 * The worker body is emitted as source text for the same reason the subprocess
 * entry was: it must run in a fresh context with no module graph and no `pi`, and
 * the guards have to be installed before the user script is compiled.
 *
 * The guards are not restated here. They are embedded by calling
 * `installDeterminismGuards.toString()`, so `sandbox.ts` stays the single source
 * of truth — a hand-copied second copy is exactly the drift this avoids.
 *
 * The script is compiled with `new AsyncFunction(body)` rather than `eval`, so
 * top-level `await` and `return` work; a script is the body of an async
 * function, not a module.
 */

import { installDeterminismGuards } from "./sandbox.ts";

export interface WorkerPayload {
  /** The workflow script, run as an async function body. */
  script: string;
  /** JSON args exposed as the script's `args` global. */
  args: unknown;
  /** Run name, for error messages. */
  name: string;
}

/**
 * Render the worker source.
 *
 * The payload arrives via `workerData`, never by template interpolation: a script
 * containing a backtick or `${` must not be able to break out of this template
 * and run as host code before the guards exist.
 */
export function renderWorkerSource(): string {
  return `"use strict";
const { parentPort, workerData } = require("node:worker_threads");
const payload = workerData.payload;
// Captured before the guards run: they remove setImmediate from the global, and
// the worker's own terminal flush needs a real scheduler to survive that.
const scheduleFlush = setImmediate;

(${installDeterminismGuards.toString()})(globalThis);

let sequence = 0;
const pending = new Map();
const budgetState = { total: null, spent: 0 };

function send(message) {
  parentPort.postMessage(message);
}

parentPort.on("message", function (reply) {
  if (!reply || typeof reply !== "object" || !reply.id) return;
  const entry = pending.get(reply.id);
  if (!entry) return;
  pending.delete(reply.id);
  if (reply.kind === "agent-result") {
    if (typeof reply.spent === "number") budgetState.spent = reply.spent;
    if (reply.ok) entry.resolve({ value: reply.value, tokens: reply.tokens || 0 });
    else entry.reject(new Error(reply.error || "agent call failed"));
  } else if (reply.kind === "budget-result") {
    budgetState.total = reply.total;
    budgetState.spent = reply.spent;
    entry.resolve(reply);
  } else if (reply.kind === "admit-result") {
    if (reply.ok) entry.resolve(reply);
    else entry.reject(new Error(reply.error || "the run budget refuses this panel"));
  }
});

function request(message) {
  return new Promise(function (resolve, reject) {
    pending.set(message.id, { resolve: resolve, reject: reject });
    send(message);
  });
}

// The budget is a synchronous global but the real counter lives in the parent,
// so the initial value is fetched before the script runs. Without this the
// script reads budget.total as null even when the run has a limit.
async function syncBudget() {
  try {
    await request({ kind: "budget", id: "budget-init" });
  } catch (error) {
    // A run with no budget still executes; the globals just stay unbounded.
  }
}

async function agent(prompt, options) {
  const id = "c" + (sequence++);
  const result = await request({ kind: "agent", id: id, prompt: String(prompt), options: options || {} });
  return result.value;
}

// A panel's preview, sent before any of its tasks runs so that a panel which
// would cross the agent limit is refused whole instead of half-run. It does not
// reserve: each task's agent() still admits its own call, and reserving here
// would count them twice.
async function admitPanel(calls) {
  await request({ kind: "admit", id: "p" + (sequence++), calls: calls });
}

// A barrier: awaits every task, and a throwing task becomes null rather than
// rejecting the whole panel, so one failure does not discard its siblings' work.
async function parallel(tasks) {
  if (!Array.isArray(tasks)) throw new TypeError("parallel() requires an array of task functions");
  if (tasks.length > 4096) throw new RangeError("parallel() accepts at most 4096 tasks");
  await admitPanel(tasks.length);
  return Promise.all(tasks.map(async function (task) {
    if (typeof task !== "function") throw new TypeError("parallel() entries must be functions");
    try { return await task(); } catch (error) { return null; }
  }));
}

// No barrier between stages: item A can be in stage 3 while item B is in stage 1,
// and a stage sees only its own item. A throwing stage drops that item to null.
async function pipeline(items) {
  const stages = Array.prototype.slice.call(arguments, 1);
  if (!Array.isArray(items)) throw new TypeError("pipeline() requires an array of items");
  if (items.length > 4096) throw new RangeError("pipeline() accepts at most 4096 items");
  for (let i = 0; i < stages.length; i += 1) {
    if (typeof stages[i] !== "function") throw new TypeError("pipeline() stages must be functions");
  }
  // A stage is arbitrary code, not one agent call per item. Only agent() can
  // know how many calls actually occur; its admission remains the hard bound.
  return Promise.all(items.map(async function (item, index) {
    let value = item;
    for (let i = 0; i < stages.length; i += 1) {
      try { value = await stages[i](value, item, index); } catch (error) { return null; }
    }
    return value;
  }));
}

function phase(title) { send({ kind: "phase", title: String(title) }); }
function log(message) { send({ kind: "log", message: String(message) }); }

const budget = Object.freeze({
  get total() { return budgetState.total; },
  get spent() { return budgetState.spent; },
  remaining: function () {
    return budgetState.total === null ? null : Math.max(0, budgetState.total - budgetState.spent);
  },
});

const exposed = { agent: agent, parallel: parallel, pipeline: pipeline, phase: phase, log: log, budget: budget, args: payload.args };
for (const key of Object.keys(exposed)) {
  Object.defineProperty(globalThis, key, { value: exposed[key], writable: false, configurable: false, enumerable: true });
}
Object.defineProperty(globalThis, "meta", { value: null, writable: true, configurable: false, enumerable: true });

(async function () {
  try {
    await syncBudget();
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    // Strict mode, so a script that assigns to a guarded global fails loudly
    // instead of silently keeping the guard: the assignment is what the author
    // wrote, and a silent no-op hides that it did nothing. The directive is a
    // single-quoted literal here so it survives this template unchanged.
    const main = new AsyncFunction('"use strict";\\n' + payload.script);
    const value = await main();
    // Give every queued postMessage a turn to flush before the worker ends:
    // a terminal message written in the same tick as exit can be dropped.
    scheduleFlush(function () {
      parentPort.postMessage({ kind: "complete", value: value === undefined ? null : value, meta: globalThis.meta || {} });
    });
  } catch (error) {
    scheduleFlush(function () {
      parentPort.postMessage({
        kind: "error",
        message: error && error.message ? String(error.message) : String(error),
        stack: error && error.stack ? String(error.stack) : undefined,
      });
    });
  }
})();
`;
}

export type { WorkerPayload as ChildPayload };
