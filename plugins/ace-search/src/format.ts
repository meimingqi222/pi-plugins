/**
 * Rendering helpers shared by the CLI and the pi tool.
 *
 * Keeping this separate means the CLI (the accuracy harness) and the extension
 * produce identical output, so a regression seen in one is reproducible in the
 * other.
 */

import type { AceSearchResult } from "./search.ts";

export function formatPhaseSummary(result: AceSearchResult): string {
  const parts = result.phases.map(
    (phase) => `${phase.phase} ${(phase.durationMs / 1000).toFixed(2)}s`,
  );
  return `${parts.join("  ")}  total ${(result.totalDurationMs / 1000).toFixed(2)}s`;
}

export function formatAceStats(result: AceSearchResult): string {
  return [
    `project:      ${result.projectRoot}`,
    `blobs:        ${result.blobCount} (from ${result.includedFiles} files, ${result.skippedFiles} skipped)`,
    `index:        ${result.indexFormat}, ${result.indexEntryCount} entries`,
    `uploaded:     ${result.uploadedChunks} chunks`,
    `index wait:   ${result.indexWaitMs}ms`,
    `phases:       ${formatPhaseSummary(result)}`,
  ].join("\n");
}

/** Rewrite `Path: <blob>#chunkNofM` headers to a plain file path. */
export function normalizeRetrievalPaths(text: string): string {
  return text.replace(/^(Path: )(.*?)#chunk\d+of\d+$/gm, (_match, prefix: string, path: string) => {
    return `${prefix}${path}`;
  });
}
