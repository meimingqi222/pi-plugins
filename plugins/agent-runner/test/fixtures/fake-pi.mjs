#!/usr/bin/env node
/**
 * A stand-in for `pi --mode json`, used to exercise the executor's *process*
 * handling without a provider, a network, or a model.
 *
 * `applyEvent` is already unit-tested in isolation. What this fixture exists for
 * is everything around it — spawn, a closed stdin, draining stdout line by line,
 * the timeout kill, and the abort path. Those are the parts that hung a real
 * session three times, and no direct call to the parser can check them.
 *
 * Behaviour is driven by the prompt, not by this script's own flags, because the
 * executor appends its own fixed arguments (`--mode json -p --no-session --`)
 * and the prompt is the only input a caller controls:
 *
 *   contains "HANG"        never exit, so only the timeout kill can end it
 *   contains "STALL_TOOL:<name>" emit a tool call that never ends and then
 *                                hang, so only the stall bound can end it
 *   contains "DECLARED_TIMEOUT:<s>" the stalled tool call declares its own
 *                                timeout in seconds, which must outrank the
 *                                silence bound while it is in flight
 *   contains "SPLIT_BATCH"  a parallel sibling `read` starts and finishes right
 *                                after the stalled call starts, which must not
 *                                drop the stalled call's declared budget
 *   contains "ERROR:<t>"   emit an assistant error <t>, then exit non-zero
 *   contains "RECOVER"     emit a failed reply and then a successful one: the
 *                          run recovered after a terminal error
 *   contains "SILENTFAIL:<n>" exit with code <n> and no output at all
 *   contains "CHATTER:<n>" emit <n> progress events before the final message
 *   contains "JSONREPLY:<json>" reply with exactly that JSON (structured reply)
 *   contains "FENCED:<json>"     reply with that JSON inside a Markdown fence
 *   contains "BROKEN:<json>"     reply with that JSON and one quote misplaced,
 *                                which is how a model hand-writes bad JSON
 *   otherwise              emit a normal completed run whose text is the prompt
 */

const argv = process.argv.slice(2);
const prompt = argv[argv.length - 1] ?? "";

// A child that fails without emitting an event: the exit code is the only
// signal, which is what the executor's "non-zero exit is a failure" rule reads.
const silentFail = /SILENTFAIL:(\d+)/u.exec(prompt)?.[1];
if (silentFail !== undefined) {
  process.exit(Number(silentFail));
}

function emit(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

emit({ type: "session", version: 3, id: "fixture", cwd: process.cwd() });
emit({ type: "agent_start" });

// A tool call in flight and then nothing: the wall clock would eventually fail
// this run too, so only the *stall* bound can end it promptly — and only the
// stall bound can name the tool that went quiet. The `setInterval` is what keeps
// the process alive; the never-settling await is what stops the rest of this
// script from emitting the events that would move the liveness clock.
const stallTool = /STALL_TOOL:(\S+)/u.exec(prompt)?.[1];
if (stallTool !== undefined) {
  const declaredSeconds = Number(/DECLARED_TIMEOUT:([\d.]+)/u.exec(prompt)?.[1]);
  emit({
    type: "tool_execution_start",
    toolCallId: "t9",
    toolName: stallTool,
    args: {
      path: "/home/someone",
      ...(Number.isFinite(declaredSeconds) ? { timeout: declaredSeconds } : {}),
    },
  });
  setInterval(() => {}, 1_000);

  // A tool batch runs in parallel by default (`agent-loop.ts` picks the parallel
  // path unless a tool declares `executionMode: "sequential"`, and no builtin
  // does). So a fast sibling can start and finish while this call is still in
  // flight — and its end must not drop this call's budget.
  if (prompt.includes("SPLIT_BATCH")) {
    emit({ type: "tool_execution_start", toolCallId: "t8", toolName: "read", args: { path: "/tmp/x" } });
    emit({ type: "tool_execution_end", toolCallId: "t8", toolName: "read", result: { content: [] } });
  }

  await new Promise(() => {});
}

if (prompt.includes("TOOLS")) {
  emit({ type: "tool_execution_start", toolCallId: "t1", toolName: "grep", args: { pattern: "secret", path: "src/workflow.ts" } });
  emit({ type: "tool_execution_end", toolCallId: "t1", toolName: "grep", result: { content: [] } });
}

const chatter = Number(/CHATTER:(\d+)/u.exec(prompt)?.[1] ?? 0);
for (let index = 0; index < chatter; index += 1) {
  emit({ type: "message_update", usage: { input: index, output: 1, totalTokens: index + 1 } });
}

const errorText = /ERROR:([^\n]*)/u.exec(prompt)?.[1];
const reply = structuredReply(prompt);
if (prompt.includes("RECOVER")) {
  // A terminal error the run came back from: the outcome must follow the *last*
  // reply, not the worst one. Both messages carry usage so the accounting path
  // is exercised too.
  emit({
    type: "message_end",
    message: { role: "assistant", content: [], stopReason: "error", errorMessage: "429: rate limited", usage: { input: 4, output: 0, totalTokens: 4 } },
  });
  emit({
    type: "message_end",
    message: {
      role: "assistant",
      model: "fixture/model",
      stopReason: "stop",
      content: [{ type: "text", text: "recovered answer" }],
      usage: { input: 6, output: 2, totalTokens: 8 },
    },
  });
  emit({ type: "agent_end", messages: [] });
  emit({ type: "agent_settled" });
  process.exit(0);
}
if (errorText !== undefined) {
  emit({
    type: "message_end",
    message: { role: "assistant", content: [], stopReason: "error", errorMessage: errorText.trim() },
  });
  // Non-zero exit, so a caller reading the exit code instead of the stream still
  // sees the failure.
  process.exitCode = 1;
} else {
  if (prompt.includes("FINAL_IN_AGENT_END")) {
    const first = { role: "assistant", content: [{ type: "text", text: "first reply" }], usage: { input: 11, output: 7, totalTokens: 18 } };
    const last = { role: "assistant", content: [{ type: "text", text: "final reply" }], usage: { input: 8, output: 4, totalTokens: 12 } };
    emit({ type: "message_end", message: first });
    emit({ type: "agent_end", messages: [first, last] });
    emit({ type: "agent_settled" });
    process.exit(0);
  }
  emit({
    type: "message_end",
    message: {
      role: "assistant",
      model: "fixture/model",
      stopReason: "stop",
      content: [{ type: "text", text: reply ?? `reply:${prompt}` }],
      usage: { input: 11, output: 7, totalTokens: 18 },
    },
  });
  emit({ type: "agent_end", messages: [] });
  emit({ type: "agent_settled" });
}

function structuredReply(prompt) {
  // The payload stays on one line so the executor's appended schema block is
  // never captured, and so `BROKEN` can misplace exactly one quote in it — the
  // failure a real model produced. Everything is driven by the prompt because
  // that is the only input a caller controls.
  const payload = /JSONREPLY:(\{[^\n]*\})/u.exec(prompt)?.[1];
  if (payload !== undefined) return payload;
  const fenced = /FENCED:(\{[^\n]*\})/u.exec(prompt)?.[1];
  if (fenced !== undefined) return `\`\`\`json\n${fenced}\n\`\`\``;
  const broken = /BROKEN:(\{[^\n]*\})/u.exec(prompt)?.[1];
  if (broken !== undefined) return broken.replace(",", '" ');
  return null;
}

if (prompt.includes("HANG")) {
  // A live handle and no exit: the only way out is the executor killing us.
  setInterval(() => {}, 1_000);
}
