import { createBashTool, runPrintMode } from "@earendil-works/pi-coding-agent";
import { fileURLToPath } from "node:url";

const { pidPath, heartbeatPath, background = false } = JSON.parse(process.argv.at(-1));
const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
const command = "exec " + [process.execPath, fileURLToPath(new URL("./heartbeat.mjs", import.meta.url)), pidPath, heartbeatPath].map(quote).join(" ");
const shutdown = [];
let tool = createBashTool(process.cwd());
const ctx = { cwd: process.cwd(), isIdle: () => false, sessionManager: { getSessionId: () => "fixture" } };
if (background) {
  process.env.PI_BG_BASH_LOG_DIR = process.cwd();
  const { default: bgBash } = await import("../../../bg-bash/src/index.ts");
  bgBash({
    on(name, handler) { if (name === "session_shutdown") shutdown.push(handler); },
    registerTool(value) { if (value.name === "bash") tool = value; },
    registerMessageRenderer() {}, registerEntryRenderer() {}, appendEntry() {}, sendMessage() {},
  });
}
// Run the real print-mode signal lifecycle and built-in bash, without a model.
const session = {
  sessionManager: { getHeader: () => undefined },
  bindExtensions: async () => {},
  subscribe: () => () => {},
  agent: { subscribe: () => () => {} },
  prompt: async () => {
    if (background) await tool.execute("shell", { command, background: true }, undefined, undefined, ctx);
    else await tool.execute("shell", { command });
    // A detached tool has returned but the delegated agent still has work.
    if (background) await new Promise(() => {});
  },
};
await runPrintMode({ session, setRebindSession() {}, async dispose() {
  for (const handler of shutdown) await handler({ type: "session_shutdown" }, ctx);
} }, { mode: "json", initialMessage: "run shell" });
