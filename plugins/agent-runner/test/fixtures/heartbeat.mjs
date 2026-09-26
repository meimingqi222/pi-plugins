import { appendFileSync, writeFileSync } from "node:fs";

const [pidPath, heartbeatPath] = process.argv.slice(2);
writeFileSync(pidPath, String(process.pid));
setInterval(() => appendFileSync(heartbeatPath, "."), 25);
// Bound fixture lifetime even if both the executor and test cleanup fail.
setTimeout(() => process.exit(0), 10000);
