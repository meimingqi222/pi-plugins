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
 *   contains "ERROR:<t>"   emit an assistant error <t>, then exit non-zero
 *   contains "CHATTER:<n>" emit <n> progress events before the final message
 *   contains "JSONREPLY:<json>" reply with exactly that JSON (structured reply)
 *   contains "FENCED:<json>"     reply with that JSON inside a Markdown fence
 *   contains "BROKEN:<json>"     reply with that JSON and one quote misplaced,
 *                                which is how a model hand-writes bad JSON
 *   otherwise              emit a normal completed run whose text is the prompt
 */

const argv = process.argv.slice(2);
const prompt = argv[argv.length - 1] ?? "";

function emit(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

emit({ type: "session", version: 3, id: "fixture", cwd: process.cwd() });
emit({ type: "agent_start" });

const chatter = Number(/CHATTER:(\d+)/u.exec(prompt)?.[1] ?? 0);
for (let index = 0; index < chatter; index += 1) {
  emit({ type: "message_update", usage: { input: index, output: 1, totalTokens: index + 1 } });
}

const errorText = /ERROR:([^\n]*)/u.exec(prompt)?.[1];
const reply = structuredReply(prompt);
if (errorText !== undefined) {
  emit({
    type: "message_end",
    message: { role: "assistant", content: [], stopReason: "error", errorMessage: errorText.trim() },
  });
  // Non-zero exit, so a caller reading the exit code instead of the stream still
  // sees the failure.
  process.exitCode = 1;
} else {
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
