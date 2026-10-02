import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";

export function runNpm(args, options = {}) {
  if (process.platform !== "win32") return execFileSync("npm", args, options);
  // npm.cmd cannot be spawned directly, and a shell destroys argv boundaries.
  // The npm distribution places its CLI beside the shim in node_modules/npm.
  const env = options.env ?? process.env;
  const pathKey = Object.keys(env).find((key) => key.toUpperCase() === "PATH");
  const directories = (env[pathKey] ?? "").split(delimiter).filter(Boolean);
  directories.push(dirname(process.execPath));
  for (const directory of directories) {
    const cli = join(directory.replace(/^"|"$/g, ""), "node_modules", "npm", "bin", "npm-cli.js");
    if (existsSync(cli)) return execFileSync(process.execPath, [cli, ...args], options);
  }
  throw new Error("Cannot find npm-cli.js on PATH or beside the Node executable.");
}
