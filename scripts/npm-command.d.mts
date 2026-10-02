import type { ExecFileSyncOptionsWithStringEncoding } from "node:child_process";

export function runNpm(
  args: string[],
  options: ExecFileSyncOptionsWithStringEncoding,
): string;
