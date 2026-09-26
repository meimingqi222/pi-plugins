import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const { pidPath, mode } = JSON.parse(process.argv.at(-1));
if (mode === "ignore-term") process.on("SIGTERM", () => {});
// A descendant keeps the parent's stdout/stderr open after the parent dies.
const descendant = spawn(process.execPath, ["-e", "setTimeout(() => {}, 4000)"], {
  stdio: ["ignore", "inherit", "inherit"],
});
writeFileSync(pidPath, String(descendant.pid));
if (mode === "exit") process.exit(0);
setInterval(() => {}, 1000);
