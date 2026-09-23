/**
 * Shell resolution.
 *
 * pi already owns the cross-platform question "which shell do we speak to":
 * `getShellConfig()` prefers Git Bash on Windows, `/bin/bash` then `sh` on
 * Unix, and reports when a command must be written to stdin (legacy WSL
 * `bash.exe`). Reusing it is what keeps this plugin from hard-coding `bash -lc`
 * the way the upstream background extension does.
 */

import { getShellConfig } from "@earendil-works/pi-coding-agent";

export interface ShellSpec {
	/** Absolute path or PATH name of the shell executable. */
	shell: string;
	/** Arguments that precede the command (argv transport only). */
	args: string[];
	/** True when the command goes to stdin instead of argv (legacy WSL bash). */
	commandFromStdin: boolean;
}

export function resolveShell(shellPath?: string): ShellSpec {
	const config = getShellConfig(shellPath);
	return {
		shell: config.shell,
		args: [...config.args],
		commandFromStdin: config.commandTransport === "stdin",
	};
}
