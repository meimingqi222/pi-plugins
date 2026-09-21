/**
 * pi-ace-search — semantic codebase retrieval as a pi tool, backed by ACE.
 *
 * Registered as `ace_codebase_search`. It is deliberately a plain tool, not a
 * replacement for the built-in `warpgrep_codebase_search`: the two disagree
 * often enough (see `bench/accuracy.ts`) that having both available and letting
 * the model cross-check is more useful than picking a winner up front.
 *
 * Differences that matter versus acemcp-go, the client this was derived from:
 *
 *   - The hash pass reuses acemcp's cache, so a project acemcp already indexed
 *     uploads nothing. A full re-hash of a 4.4k-file repo costs ~1s.
 *   - Uploads honour the tool's AbortSignal. acemcp's `http.NewRequest` uploads
 *     keep running after a cancel.
 *   - The blocking `/find-missing` poll is off by default; retrieval against a
 *     partially indexed project already works, and the poll was what made a
 *     cold run look hung for up to 60s.
 *   - Per-phase timings are returned to the model, so "it is slow" becomes
 *     attributable instead of a guess.
 *
 * Configuration: see config.ts. Defaults read `~/.acemcp/settings.toml` so the
 * same endpoint, token and chunking are used. Set PI_ACE_ENABLED=false to load
 * the extension without exposing the tool.
 */

import { Type } from "typebox";
import { Text } from "@earendil-works/pi-tui";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadAceSearchConfig, toPosixAbsolutePath, type AceSearchConfig } from "./config.ts";
import { formatAceStats, formatPhaseSummary, normalizeRetrievalPaths } from "./format.ts";
import { runAceSearch, type AceSearchResult } from "./search.ts";

const DEFAULT_TIMEOUT_MS = 180_000;

export default function aceSearchExtension(pi: ExtensionAPI): void {
  if (process.env.PI_ACE_ENABLED === "false") return;

  let config: AceSearchConfig | null = null;
  let configError: string | null = null;
  try {
    config = loadAceSearchConfig();
  } catch (error) {
    // Deferred: a missing token should surface when the tool is used, not as a
    // startup crash that disables every other extension in the session.
    configError = error instanceof Error ? error.message : String(error);
  }

  pi.registerTool({
    name: "ace_codebase_search",
    label: "ACE Codebase Search",
    description:
      "Semantic codebase retrieval over the current project, served by the Augment ACE index. " +
      "Takes a full natural-language question (not keywords) and returns the most relevant code " +
      "sections with file paths. Best for questions about behaviour, intent or cross-file control " +
      "flow where an identifier to grep for is not yet known. Prefer `grep`/`rg` once a symbol " +
      "name is known, and treat results as ranked suggestions: retrieval is not deterministic, so " +
      "two runs of the same query can cite different files.",
    promptSnippet: "Semantic codebase search over an ACE index (natural-language question, not keywords)",
    promptGuidelines: [
      "Use ace_codebase_search when you are looking for code by intent and do not yet know an identifier to search for.",
      "Use ace_codebase_search alongside grep: results are ranked and non-deterministic, so confirm a hit by reading the file rather than trusting the ranking.",
    ],
    parameters: Type.Object({
      query: Type.String({
        description:
          "A complete natural-language question. Good: 'How is a provider's model metadata resolved when a custom model id is added?'. Bad: 'model metadata'.",
      }),
      projectRoot: Type.Optional(
        Type.String({
          description:
            "Project root to search. Defaults to the session working directory. Pass an absolute path to search a different project.",
        }),
      ),
      waitForIndex: Type.Optional(
        Type.Boolean({
          description:
            "Poll until newly uploaded files are indexed before retrieving. Slower but more complete on a first run in a large repository. Defaults to false.",
        }),
      ),
    }),

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      if (configError) throw new Error(configError);
      const activeConfig = config!;

      if (!activeConfig.token) {
        throw new Error(
          `ACE token is not configured. Set TOKEN in ${activeConfig.settingsPath} or PI_ACE_TOKEN.`,
        );
      }

      const projectRoot = toPosixAbsolutePath(params.projectRoot ?? ctx.cwd, ctx.cwd);
      const timeoutController = new AbortController();
      const timeout = setTimeout(
        () => timeoutController.abort(new Error("ACE search timed out")),
        DEFAULT_TIMEOUT_MS,
      );
      // A tool call can be cancelled from the TUI; forward that so the upload
      // stops instead of running to completion in the background.
      const onAbort = () => timeoutController.abort(signal?.reason ?? new Error("aborted"));
      if (signal?.aborted) onAbort();
      else signal?.addEventListener("abort", onAbort, { once: true });

      let lastMessage = "";
      try {
        const result = await runAceSearch({
          projectRoot,
          query: params.query,
          config: activeConfig,
          signal: timeoutController.signal,
          waitForIndex: params.waitForIndex === true,
          onProgress: (event) => {
            // `onUpdate` streams into the TUI, which is what keeps a long
            // first-run upload from looking like a hang.
            lastMessage = `${event.phase}: ${event.message}`;
            onUpdate?.({
              content: [{ type: "text", text: `ace: ${lastMessage}` }],
              details: { phase: event.phase, message: event.message },
            });
          },
        });
        return {
          content: [{ type: "text", text: renderResult(result) }],
          details: {
            projectRoot: result.projectRoot,
            blobCount: result.blobCount,
            uploadedChunks: result.uploadedChunks,
            totalDurationMs: result.totalDurationMs,
            phases: result.phases,
          },
        };
      } finally {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", onAbort);
      }
    },

    renderCall(args, theme) {
      const query = typeof args.query === "string" ? args.query : "";
      return new Text(
        `${theme.fg("toolTitle", "ace_codebase_search")} ${theme.fg("dim", query)}`,
        0,
        0,
      );
    },

    renderResult(result, options, theme) {
      if (options.isPartial) return new Text(theme.fg("dim", "ace: searching…"), 0, 0);
      const details = result.details as { blobCount?: number; totalDurationMs?: number } | undefined;
      const summary =
        details?.blobCount !== undefined
          ? `ace_codebase_search · ${details.blobCount} blobs · ${((details.totalDurationMs ?? 0) / 1000).toFixed(1)}s`
          : "ace_codebase_search";
      return new Text(theme.fg("dim", summary), 0, 0);
    },
  });
}

function renderResult(result: AceSearchResult): string {
  const body = normalizeRetrievalPaths(result.text).trimEnd();
  const stats = formatAceStats(result);
  // The stats block is part of the tool result on purpose: a model that can see
  // "uploaded 6031 chunks in 69s" can explain a slow first search, and a human
  // reading the transcript can tell a warm run from a cold one.
  return `${body}\n\n---\n${stats}\n${formatPhaseSummary(result)}`;
}

// Keep the type import used in a way bundlers cannot drop.
export type { AceSearchResult };
