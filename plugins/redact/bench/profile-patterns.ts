/**
 * Per-pattern cost profiler.
 *
 * Run: bun bench/profile-patterns.ts
 *
 * Finds patterns whose keyword pre-filter is too broad, forcing a full-string
 * regex scan on every request.
 */

import { SECRET_PATTERNS } from "../src/patterns.ts";

const CODE_LINE =
  "const result = items.filter((item) => item.enabled).map((item) => item.value * 2);";
const PROSE =
  "The quick brown fox jumps over the lazy dog while reviewing the authentication middleware implementation.";

// 1 MB of realistic agent-ish context: code plus prose, no secrets.
const BODY = (CODE_LINE + "\n" + PROSE + "\n").repeat(
  (1024 * 1024) / (CODE_LINE.length + PROSE.length + 2),
);

console.log(`corpus: ${(BODY.length / 1024).toFixed(0)} KB\n`);

interface Row {
  id: string;
  keywords: string;
  keywordHit: boolean;
  ms: number;
}

const rows: Row[] = [];

for (const pattern of SECRET_PATTERNS) {
  const keywords = pattern.keywords ?? [];
  const lower = pattern.caseInsensitive ? BODY.toLowerCase() : BODY;
  const keywordHit = keywords.length === 0
    ? true
    : keywords.some((kw) =>
        lower.includes(pattern.caseInsensitive ? kw.toLowerCase() : kw),
      );

  let regex: RegExp;
  try {
    regex = new RegExp(pattern.pattern, pattern.caseInsensitive ? "gi" : "g");
  } catch {
    continue;
  }

  // Time the regex scan over the full corpus (this is what happens on a
  // keyword hit inside applyPatterns).
  const iterations = 5;
  const t0 = performance.now();
  for (let i = 0; i < iterations; i++) {
    regex.lastIndex = 0;
    regex.test(BODY);
  }
  const ms = (performance.now() - t0) / iterations;

  rows.push({
    id: pattern.id,
    keywords: keywords.join(",") || "(none)",
    keywordHit,
    ms,
  });
}

rows.sort((a, b) => b.ms - a.ms);

const hitRows = rows.filter((r) => r.keywordHit);
const totalIfAllHit = rows.reduce((sum, r) => sum + r.ms, 0);
const totalHits = hitRows.reduce((sum, r) => sum + r.ms, 0);

console.log("Patterns whose keyword pre-filter PASSES on plain code/prose");
console.log("(each one costs a full-string regex scan):\n");
console.log("  cost ms   pattern                       keywords");
console.log("  " + "-".repeat(72));
for (const r of hitRows) {
  console.log(
    `  ${r.ms.toFixed(2).padStart(7)}   ${r.id.padEnd(30)}  ${r.keywords.slice(0, 28)}`,
  );
}

console.log(`\n  keyword filters passing: ${hitRows.length} / ${rows.length}`);
console.log(`  cost if all patterns scanned:  ${totalIfAllHit.toFixed(1)} ms`);
console.log(`  cost with keyword pre-filter:  ${totalHits.toFixed(1)} ms`);
console.log(
  `  saved by pre-filter:           ${(totalIfAllHit - totalHits).toFixed(1)} ms`,
);
