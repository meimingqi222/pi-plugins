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
 * The script runs inside a `node:vm` context created in the worker rather than
 * as an `AsyncFunction` in the worker's own realm: the context's global holds
 * only the exposed helpers, and — the point — its `import()` has no callback
 * wired, so `await import("node:fs")` inside a script throws instead of
 * reaching the filesystem past the guards. Top-level `await` and `return`
 * still work: a script is the body of an async function, not a module.
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
const vm = require("node:vm");
const payload = workerData.payload;
// The guards run inside the script's vm context, not the worker realm; this is
// only a deferred flush so a terminal postMessage is never written in the same
// tick the worker exits.
const scheduleFlush = setImmediate;

// Emitted, not invoked: its *source* is re-run inside the vm context below so
// the script's global — not the worker's — loses clocks, randomness, timers,
// process, require and fetch. The worker realm keeps its intrinsics for its
// own bridge code.
const installGuards = ${installDeterminismGuards.toString()};

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

(async function () {
  try {
    await syncBudget();
    // The script's whole world: a fresh vm context whose global carries the
    // exposed helpers and nothing else. With no importModuleDynamically
    // callback, a dynamic import -- from the script body or through a nested
    // Function -- throws in both Node and Bun, so a script can no longer reach
    // node:fs, node:os or the network behind the guards' back.
    const context = vm.createContext({});
    vm.runInContext("(" + installGuards.toString() + ")(globalThis)", context);
    vm.runInContext(
      "(function (exposed) { for (const key of Object.keys(exposed)) Object.defineProperty(globalThis, key, { value: exposed[key], writable: false, configurable: false, enumerable: true }); Object.defineProperty(globalThis, 'meta', { value: null, writable: true, configurable: false, enumerable: true }); })",
      context,
    )(exposed);
    // Strict mode, so a script that assigns to a guarded global fails loudly
    // instead of silently keeping the guard: the assignment is what the author
    // wrote, and a silent no-op hides that it did nothing.
    const main = vm.runInContext('(async function(){"use strict";\\n' + payload.script + '\\n})', context, { filename: "workflow-script.js" });
    const value = await main();
    const meta = vm.runInContext("globalThis.meta", context) || {};
    // Give every queued postMessage a turn to flush before the worker ends:
    // a terminal message written in the same tick as exit can be dropped.
    scheduleFlush(function () {
      parentPort.postMessage({ kind: "complete", value: value === undefined ? null : value, meta: meta });
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
