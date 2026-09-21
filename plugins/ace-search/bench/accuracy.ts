#!/usr/bin/env bun
/**
 * Accuracy benchmark: pi-ace-search (ACE) vs warpgrep-style local search.
 *
 * Exists because retrieval is **not deterministic**: three identical ACE runs
 * for query 2 returned different path sets. A single-run diff is therefore
 * meaningless, and the earlier "ace is more accurate" claim needed repeat
 * sampling before it could be believed.
 *
 * Methodology:
 *   - a fixture of judged-relevant files per query (the ground truth),
 *   - N repetitions per engine, reporting best/mean/worst recall,
 *   - precision as a function of how many results are read, because both
 *     engines return a ranked list and only the top K is ever looked at.
 *
 * Usage:
 *   bun bench/accuracy.ts [--project <path>] [--runs 3] [--k 5]
 *
 * The project root defaults to the current working directory. It is not
 * hard-coded, so this file carries no information about any particular
 * machine's checkout layout.
 */

import { loadAceSearchConfig, toPosixAbsolutePath } from "../src/config.ts";
import { citedPaths } from "../src/cli.ts";
import { runAceSearch } from "../src/search.ts";

interface Fixture {
  readonly id: string;
  readonly query: string;
  /** Root-relative paths a correct answer must surface. */
  readonly relevant: readonly string[];
  /**
   * Recorded output of the local `warpgrep_codebase_search` tool for the same
   * query, captured by hand.
   *
   * n=1 and not reproducible from this script — warpgrep is a tool exposed to
   * the agent, not a CLI. Treated as an anecdote with a number attached, not as
   * a benchmark row. ACE's row, by contrast, is sampled.
   */
  readonly warpgrepObserved: readonly string[];
}

/**
 * Ground truth is what a manual read of the repository established, not what
 * any engine returned — otherwise the benchmark would only measure agreement
 * with itself.
 *
 * The paths are relative to the project root passed on the command line, so the
 * fixtures are only meaningful for the repository they were judged against; the
 * script prints the resolved root it used.
 */
const FIXTURES: readonly Fixture[] = [
  {
    id: "q1-byok-metadata",
    query: "BYOK model metadata matching, provider api key custom model",
    relevant: [
      "packages/provider/src/config/rule-data-schema.ts",
      "packages/provider/src/config/model-config.ts",
      "packages/provider/src/config/schema.ts",
      "packages/provider/src/resolver.ts",
      "packages/provider/src/config/manual-model-config.ts",
      "packages/provider/src/config/provider-data-schema.ts",
    ],
    warpgrepObserved: [
      "packages/services/src/model-provider/accountProviderCredentialService.ts",
      "packages/services/src/model-provider/accountProviderCredentialKey.ts",
    ],
  },
  {
    id: "q2-metadata-resolution",
    query:
      "how are model metadata (context window, capabilities) matched/resolved for models, model catalog resolution by model id",
    relevant: [
      "packages/provider/src/config/model-config.ts",
      "packages/shared/src/model-config.ts",
      "packages/provider/src/resolver.ts",
      "packages/provider/src/facades.ts",
      "packages/provider/src/config/rule-data-schema.ts",
      // `registry.ts` holds `getModel(providerId, modelId)`, i.e. lookup by id.
      "packages/provider/src/registry.ts",
    ],
    warpgrepObserved: [
      "packages/provider/src/registry.ts",
      "packages/provider/src/model-selection-config.ts",
      "packages/provider/src/effective-model-selection.ts",
    ],
  },
];

interface RunOutcome {
  readonly paths: readonly string[];
  readonly durationMs: number;
}

function recallAt(paths: readonly string[], relevant: readonly string[], k: number): number {
  if (relevant.length === 0) return 0;
  const top = new Set(paths.slice(0, k));
  return relevant.filter((path) => top.has(path)).length / relevant.length;
}

const CUTOFFS = [1, 3, 5, 10] as const;

function report(
  name: string,
  outcomes: readonly RunOutcome[],
  fixture: Fixture,
  cutoffs: readonly number[],
): void {
  const meanCount = outcomes.reduce((sum, outcome) => sum + outcome.paths.length, 0) / outcomes.length;
  const meanMs = outcomes.reduce((sum, outcome) => sum + outcome.durationMs, 0) / outcomes.length;

  const cells = cutoffs.map((k) => {
    const recalls = outcomes.map((outcome) => recallAt(outcome.paths, fixture.relevant, k));
    const mean = recalls.reduce((sum, value) => sum + value, 0) / recalls.length;
    const worst = Math.min(...recalls);
    // `mean==worst` means every run agreed, which is the signal that mattered
    // here: three identical earlier runs disagreed on query 2.
    const stability = mean === worst ? "" : ` (worst ${(worst * 100).toFixed(0)}%)`;
    return `@${k} ${(mean * 100).toFixed(0)}%${stability}`;
  });

  // A file surfaced by *any* run is reachable; separates ranking noise from a
  // genuine miss.
  const union = new Set(outcomes.flatMap((outcome) => outcome.paths));
  const unionRecall = fixture.relevant.filter((path) => union.has(path)).length / fixture.relevant.length;

  console.log(
    `  ${name.padEnd(10)} ${cells.join("  ")}  union ${(unionRecall * 100).toFixed(0)}%  n=${meanCount.toFixed(0)}  ${(meanMs / 1000).toFixed(1)}s`,
  );
}

async function runAce(
  fixture: Fixture & { readonly projectRoot: string },
  runs: number,
): Promise<RunOutcome[]> {
  const config = loadAceSearchConfig();
  const outcomes: RunOutcome[] = [];
  for (let index = 0; index < runs; index += 1) {
    const controller = new AbortController();
    const startedAt = Date.now();
    const result = await runAceSearch({
      projectRoot: fixture.projectRoot,
      query: fixture.query,
      config,
      signal: controller.signal,
    });
    outcomes.push({ paths: citedPaths(result.text), durationMs: Date.now() - startedAt });
  }
  return outcomes;
}

const runsFlagIndex = process.argv.indexOf("--runs");
const runs = runsFlagIndex >= 0 ? Number(process.argv[runsFlagIndex + 1]) : 3;
const kFlagIndex = process.argv.indexOf("--k");
const cutoffs = kFlagIndex >= 0 ? [Number(process.argv[kFlagIndex + 1])] : [...CUTOFFS];
const projectFlagIndex = process.argv.indexOf("--project");
const projectRoot = toPosixAbsolutePath(
  projectFlagIndex >= 0 ? process.argv[projectFlagIndex + 1]! : process.cwd(),
  process.cwd(),
);

console.log(`ACE retrieval accuracy — ${projectRoot}`);
console.log(`repetitions: ${runs}; recall at k = ${cutoffs.join(", ")}\n`);

for (const fixture of FIXTURES) {
  console.log(`${fixture.id}\n  "${fixture.query}"`);
  const ace = await runAce({ ...fixture, projectRoot }, runs);
  report("ACE", ace, fixture, cutoffs);

  const warpgrepOutcome: RunOutcome = {
    paths: fixture.warpgrepObserved,
    durationMs: 0,
  };
  report("warpgrep*", [warpgrepOutcome], fixture, cutoffs);

  const union = new Set(ace.flatMap((outcome) => outcome.paths));
  const missed = fixture.relevant.filter((path) => !union.has(path));
  if (missed.length > 0) console.log(`  ACE never returned: ${missed.join(", ")}`);
  console.log();
}

console.log("* warpgrep n=1, recorded by hand earlier; not reproducible from this script.");
