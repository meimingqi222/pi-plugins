import { expect, test } from "bun:test";
import { runNpm } from "../../../scripts/npm-command.mjs";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test.skipIf(process.platform !== "win32")("npm invocation preserves spaces and shell metacharacters", () => {
  const root = mkdtempSync(join(tmpdir(), "npm command "));
  const previousPath = process.env.PATH;
  try {
    const bin = join(root, "node_modules", "npm", "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "npm-cli.js"), "console.log(JSON.stringify(process.argv.slice(2)))");
    writeFileSync(join(root, "npm.cmd"), `@"${process.execPath}" "${join(bin, "npm-cli.js")}" %*\r\n`);
    process.env.PATH = root;
    const args = ["install", "--prefix", join(root, "installed folder"), join(root, "a & b.tgz")];
    expect(JSON.parse(runNpm(args, { encoding: "utf8" }).trim())).toEqual(args);
  } finally {
    process.env.PATH = previousPath;
    rmSync(root, { recursive: true, force: true });
  }
});
