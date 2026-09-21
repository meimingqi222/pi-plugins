#!/usr/bin/env bun
/**
 * pi-ace-search CLI — the accuracy harness before this becomes a pi tool.
 *
 * Why a CLI first: the two questions this was built to answer are "is ACE's
 * retrieval actually better than the local search tool" and "why does it feel
 * like it hangs". Both are easier to answer by running the same query from a
 * shell, diffing the cited file paths, and reading per-phase timings than by
 * driving a TUI.
 *
 * Usage:
 *   pi-ace-search search <project> <query> [--json] [--wait] [--stats]
 *   pi-ace-search paths  <project> <query>          # cited paths, one per line
 *   pi-ace-search --help
 *
 * Configuration comes from `~/.acemcp/settings.toml` (BASE_URL, TOKEN, data
 * dir) so the warm index acemcp built is reused; see config.ts for overrides.
 */

import { basename } from "node:path";
import { loadAceSearchConfig, toPosixAbsolutePath } from "./config.ts";
import { formatAceStats, formatPhaseSummary, normalizeRetrievalPaths } from "./format.ts";
import { runAceSearch } from "./search.ts";

interface CliOptions {
  readonly command: "search" | "paths" | "help";
  readonly projectRoot?: string;
  readonly query?: string;
  readonly json: boolean;
  readonly stats: boolean;
  readonly wait: boolean;
  readonly dataDir?: string;
  readonly baseUrl?: string;
  readonly token?: string;
  readonly index?: string;
  readonly timeoutSeconds: number;
}

const HELP = `pi-ace-search — semantic code search over an ACE (Augment) index

Usage:
  pi-ace-search search <project> <query> [options]
  pi-ace-search paths  <project> <query>
  pi-ace-search --help

Commands:
  search   Retrieve code context and print it.
  paths    Print only the cited file paths, one per line (for diffing).
  --help   Show this message.

Options:
  --json                 Emit a JSON result object instead of text.
  --wait                 Poll /find-missing before retrieving. Off by default
                         because it blocks the retrieve on the server's index
                         queue; retrieval works against a partial index.
  --stats                Print phase timings to stderr (default: on for search).
  --no-stats             Suppress the stderr timing summary.
  --timeout <seconds>    Overall deadline, default 300.
  --data <dir>           Index/data dir, default ~/.acemcp/data.
  --base-url <url>       ACE endpoint, default from settings.toml.
  --token <token>        Bearer token, default from settings.toml.
  --index <path>         Explicit blob-hash index file.

Environment: PI_ACE_BASE_URL, PI_ACE_TOKEN, PI_ACE_DATA_DIR, PI_ACE_INDEX,
             PI_ACE_SETTINGS, PI_ACE_BATCH_SIZE, PI_ACE_CONCURRENCY,
             PI_ACE_LOG_LEVEL.

Note on --token: a value on the command line is visible to other local users
via ps. Prefer PI_ACE_TOKEN or settings.toml on a shared machine.\n
Examples:
  pi-ace-search search ~/code/ZCode "How does authentication work?"
  pi-ace-search paths  ~/code/ZCode "How is model metadata resolved?" | sort
`;

export function parseArgs(argv: readonly string[]): CliOptions {
  let command: CliOptions["command"] = "help";
  const positional: string[] = [];
  let json = false;
  let stats = true;
  let wait = false;
  let dataDir: string | undefined;
  let baseUrl: string | undefined;
  let token: string | undefined;
  let index: string | undefined;
  let timeoutSeconds = 300;

  for (let index0 = 0; index0 < argv.length; index0 += 1) {
    const argument = argv[index0]!;
    switch (argument) {
      case "search":
      case "paths":
        command = argument;
        break;
      case "help":
      case "--help":
      case "-h":
        command = "help";
        break;
      case "--json":
        json = true;
        break;
      case "--wait":
        wait = true;
        break;
      case "--stats":
        stats = true;
        break;
      case "--no-stats":
        stats = false;
        break;
      case "--data":
        dataDir = argv[++index0];
        break;
      case "--base-url":
        baseUrl = argv[++index0];
        break;
      case "--token":
        token = argv[++index0];
        break;
      case "--index":
        index = argv[++index0];
        break;
      case "--timeout": {
        const value = Number(argv[++index0]);
        if (!Number.isFinite(value) || value <= 0) throw new Error("--timeout must be a positive number");
        timeoutSeconds = value;
        break;
      }
      default:
        if (argument.startsWith("-")) throw new Error(`unknown option: ${argument}`);
        positional.push(argument);
    }
  }

  return {
    command,
    projectRoot: positional[0],
    query: positional.slice(1).join(" "),
    json,
    // `paths` is a machine-readable mode, so a timing banner on stderr is fine
    // but a JSON consumer should not have to filter it out of stdout.
    stats: stats && !json,
    wait,
    dataDir,
    baseUrl,
    token,
    index,
    timeoutSeconds,
  };
}

/** Extract cited paths from a retrieval payload, for accuracy comparison. */
export function citedPaths(text: string): string[] {
  const paths = new Set<string>();
  for (const match of text.matchAll(/^Path: (.+)$/gm)) {
    paths.add(match[1]!.replace(/#chunk\d+of\d+$/, ""));
  }
  return [...paths];
}

async function main(argv: readonly string[]): Promise<number> {
  let options: CliOptions;
  try {
    options = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n\n${HELP}`);
    return 2;
  }

  if (options.command === "help") {
    process.stdout.write(HELP);
    return 0;
  }
  if (!options.projectRoot || !options.query) {
    process.stderr.write(`usage: pi-ace-search ${options.command} <project> <query>\n`);
    return 2;
  }

  const config = loadAceSearchConfig({
    dataDir: options.dataDir,
    baseUrl: options.baseUrl,
    token: options.token,
    indexPath: options.index,
  });
  if (!config.token) {
    process.stderr.write(
      `No ACE token. Set TOKEN in ${config.settingsPath} or PI_ACE_TOKEN.\n`,
    );
    return 2;
  }

  const projectRoot = toPosixAbsolutePath(options.projectRoot, process.cwd());
  const controller = new AbortController();
  const deadline = setTimeout(
    () => controller.abort(new Error(`timed out after ${options.timeoutSeconds}s`)),
    options.timeoutSeconds * 1_000,
  );
  const onInterrupt = () => controller.abort(new Error("interrupted"));
  process.on("SIGINT", onInterrupt);
  process.on("SIGTERM", onInterrupt);

  try {
    const result = await runAceSearch({
      projectRoot,
      query: options.query,
      config,
      signal: controller.signal,
      waitForIndex: options.wait,
      onProgress: (event) => {
        if (!options.stats) return;
        process.stderr.write(`[ace] ${event.phase}: ${event.message}\n`);
      },
    });

    if (options.command === "paths") {
      for (const path of citedPaths(result.text)) process.stdout.write(`${path}\n`);
    } else if (options.json) {
      process.stdout.write(
        `${JSON.stringify(
          {
            text: result.text,
            paths: citedPaths(result.text),
            projectRoot: result.projectRoot,
            query: result.query,
            phases: result.phases,
            totalDurationMs: result.totalDurationMs,
            uploadedChunks: result.uploadedChunks,
            blobCount: result.blobCount,
            indexFormat: result.indexFormat,
            indexEntryCount: result.indexEntryCount,
            includedFiles: result.includedFiles,
          },
          null,
          2,
        )}\n`,
      );
    } else {
      const body = normalizeRetrievalPaths(result.text);
      process.stdout.write(body.endsWith("\n") ? body : `${body}\n`);
    }

    if (options.stats) {
      process.stderr.write(`\n${formatAceStats(result)}\n${formatPhaseSummary(result)}\n`);
    }
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`pi-ace-search: ${message}\n`);
    if (options.json) {
      process.stdout.write(`${JSON.stringify({ error: message, query: options.query }, null, 2)}\n`);
    }
    return 1;
  } finally {
    clearTimeout(deadline);
    process.off("SIGINT", onInterrupt);
    process.off("SIGTERM", onInterrupt);
  }
}

// Only run when executed directly, so tests can import parseArgs/citedPaths.
if (process.argv[1] && basename(process.argv[1]).startsWith("cli.")) {
  const code = await main(process.argv.slice(2));
  process.exitCode = code;
}
