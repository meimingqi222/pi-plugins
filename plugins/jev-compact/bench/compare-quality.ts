/**
 * Head-to-head compaction quality: **Jev decisions vs Morph's line filtering**,
 * scored against planted facts rather than a vibe.
 *
 * The question is not "which compresses more" — anyone can delete text. It is:
 * at a comparable reduction, **which one keeps the things that matter?** So
 * every strategy is scored on:
 *
 *   - critical recall   — constraints, root cause, decisions (must not be lost)
 *   - important recall  — file paths and config (nice to keep)
 *   - reduction         — how much smaller the result got
 *
 * Baselines frame the result so a number is interpretable: the identity, a
 * naive head-keep, a spread-out proportional sampler, and "drop the largest
 * tool results". Morph is additionally swept across compression ratios, because
 * a single ratio hides the trade-off curve — the interesting question is where
 * fact loss begins.
 *
 * Morph is fed **per-role messages**, exactly as `pi-morph-plugin` does
 * (serialize, split on role markers, send one message per role), so it is
 * tested as deployed rather than as a straw man.
 *
 * Usage:
 *   TYPESAFE_API_KEY=... MORPH_API_KEY=... bun bench/compare-quality.ts
 *   # either key may be omitted; that strategy is skipped with a notice.
 */

import { buildFixture, roughTokens, scoreFacts, type Fact, type Fixture } from './fixture.ts';
import { morphCompact, type MorphMessage } from './morph-client.ts';
import { compact } from '../src/jev/compact.ts';
import { JevClient } from '../src/jev/client.ts';
import { serializeEngineMessages, serializedChars } from '../src/pi-adapter.ts';
import type { Message } from '../src/jev/types.ts';

// ---------------------------------------------------------------------------
// Presentation
// ---------------------------------------------------------------------------

const useColor = process.stdout.isTTY === true;
const c = {
  bold: (s: string) => (useColor ? `\x1b[1m${s}\x1b[0m` : s),
  dim: (s: string) => (useColor ? `\x1b[2m${s}\x1b[0m` : s),
  green: (s: string) => (useColor ? `\x1b[32m${s}\x1b[0m` : s),
  red: (s: string) => (useColor ? `\x1b[31m${s}\x1b[0m` : s),
  yellow: (s: string) => (useColor ? `\x1b[33m${s}\x1b[0m` : s),
};

interface Score {
  strategy: string;
  chars: number;
  reduction: number;
  criticalKept: number;
  criticalTotal: number;
  importantKept: number;
  importantTotal: number;
  lost: Fact[];
  note?: string;
}

function pct(kept: number, total: number): string {
  return total === 0 ? 'n/a' : `${Math.round((kept / total) * 100)}%`;
}

function renderRow(s: Score): string {
  const crit = `${s.criticalKept}/${s.criticalTotal}`;
  const imp = `${s.importantKept}/${s.importantTotal}`;
  const critRatio = s.criticalKept / Math.max(1, s.criticalTotal);
  const cell = critRatio === 1 ? c.green(crit) : critRatio >= 0.75 ? c.yellow(crit) : c.red(crit);
  return (
    `  ${s.strategy.padEnd(26)}` +
    `${s.chars.toLocaleString('en-US').padStart(9)}` +
    `${`~${roughTokens('x'.repeat(s.chars)).toLocaleString('en-US')}`.padStart(9)}` +
    `${`${Math.round(s.reduction * 100)}%`.padStart(7)}   ` +
    `${cell.padEnd(14)} ${imp.padEnd(12)} ${s.note ?? ''}`
  );
}

function header(): void {
  console.log(
    c.bold(
      `  ${'strategy'.padEnd(26)}${'chars'.padStart(9)}${'~tokens'.padStart(9)}${'reduc'.padStart(7)}   ${'critical'.padEnd(14)} ${'important'.padEnd(12)}`,
    ),
  );
}

// ---------------------------------------------------------------------------
// Scoring + baselines
// ---------------------------------------------------------------------------

function makeScore(
  strategy: string,
  fixture: Fixture,
  text: string,
  note?: string,
): Score {
  const s = scoreFacts(fixture.facts, text);
  return {
    strategy,
    chars: text.length,
    reduction: 1 - text.length / Math.max(1, fixture.chars),
    criticalKept: s.byKind.critical.kept,
    criticalTotal: s.byKind.critical.total,
    importantKept: s.byKind.important.kept,
    importantTotal: s.byKind.important.total,
    lost: s.lost,
    note,
  };
}

/**
 * The serialized size of a transcript, measured by the renderer itself. The
 * per-message `messageChars` omits the joins between messages, so summing it
 * understates an aggregate; this is the figure the reduction ratio uses.
 */
function totalChars(messages: readonly Message[]): number {
  return serializedChars(messages);
}

/** Keeps the first `ratio` of lines, drops the tail — the naive truncation. */
function headKeep(text: string, ratio: number): string {
  const lines = text.split('\n');
  return lines.slice(0, Math.max(1, Math.floor(lines.length * ratio))).join('\n');
}

/** Keeps every Nth line, spread across the whole transcript. */
function proportional(text: string, ratio: number): string {
  const lines = text.split('\n');
  const step = Math.max(1, Math.round(1 / Math.max(0.0001, ratio)));
  return lines.filter((_, i) => i % step === 0).join('\n');
}

/**
 * A fair non-LLM baseline: blank the largest tool results until the target
 * reduction is met. This is the "just drop big outputs" heuristic, and it is
 * the main competitor to any smart strategy.
 */
function dropLargestResults(messages: readonly Message[], targetReduction: number): Message[] {
  const out: Message[] = messages.map((m) => ({
    ...m,
    toolUses: m.toolUses.map((u) => ({ ...u })),
    toolResults: m.toolResults ? m.toolResults.map((r) => ({ ...r })) : undefined,
  }));
  const refs: Array<{ use: Message['toolUses'][number]; result?: Message['toolResults'] extends (infer R)[] | undefined ? R : never }> = [];
  const resultById = new Map<string, { text: string }>();
  for (const m of out) for (const r of m.toolResults ?? []) resultById.set(r.tool_use_id, r);
  for (const m of out) {
    for (const u of m.toolUses) refs.push({ use: u, result: resultById.get(u.tool_use_id) as never });
  }
  refs.sort((a, b) => (b.use.text?.length ?? 0) - (a.use.text?.length ?? 0));
  const before = totalChars(out);
  let chars = before;
  for (const { use, result } of refs) {
    if (chars <= before * (1 - targetReduction)) break;
    const len = (use.text ?? '').length;
    if (len === 0) continue;
    use.text = '';
    if (result) result.text = '';
    chars -= len;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Morph
// ---------------------------------------------------------------------------

/**
 * Splits the serialized transcript into per-role messages the way
 * `pi-morph-plugin` does, so Morph sees the same shape it does in production.
 */
function toMorphMessages(engine: readonly Message[]): MorphMessage[] {
  const out: MorphMessage[] = [];
  for (const m of engine) {
    if (m.role === 'user') {
      if (m.text.trim()) out.push({ role: 'user', content: m.text });
      continue;
    }
    if (m.text.trim()) out.push({ role: 'assistant', content: m.text });
    for (const use of m.toolUses) {
      if (use.text) out.push({ role: 'assistant', content: use.text });
    }
  }
  return out;
}

async function runMorphAt(fixture: Fixture, ratio: number, apiKey: string): Promise<Score> {
  const started = Date.now();
  const result = await morphCompact(toMorphMessages(fixture.engine), {
    apiKey,
    compressionRatio: ratio,
    preserveRecent: Number(process.env.MORPH_COMPACT_PRESERVE_RECENT ?? 1),
  });
  const score = makeScore(`morph (ratio ${ratio})`, fixture, result.output);
  score.note = c.dim(`${Date.now() - started}ms`);
  return score;
}

// ---------------------------------------------------------------------------
// Jev
// ---------------------------------------------------------------------------

async function runJev(fixture: Fixture): Promise<Score | undefined> {
  const apiKey = process.env.TYPESAFE_API_KEY;
  if (!apiKey) return undefined;

  const client = new JevClient({
    apiKey,
    model: process.env.JEV_COMPACT_MODEL,
    baseUrl: process.env.JEV_COMPACT_BASE_URL,
  });
  const started = Date.now();
  const result = await compact(fixture.engine, client, {
    preserveRecentMessages: Number(process.env.JEV_COMPACT_PRESERVE_RECENT ?? 6),
    keepThreshold: Number(process.env.JEV_COMPACT_THRESHOLD ?? 0.5),
    truncateHeadChars: Number(process.env.JEV_COMPACT_TRUNCATE_HEAD ?? 300),
  });
  const score = makeScore('jev-compact', fixture, serializeEngineMessages(result.messages));
  score.note = c.dim(
    `${result.stats.callsDropped} dropped, ${result.stats.resultsDropped} truncated, ${result.stats.requests} req, ${Date.now() - started}ms`,
  );
  return score;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const fixture = buildFixture();
  const baseText = serializeEngineMessages(fixture.engine);
  const criticalTotal = fixture.facts.filter((f) => f.kind === 'critical').length;
  const importantTotal = fixture.facts.filter((f) => f.kind === 'important').length;

  console.log();
  console.log(c.bold('  compaction quality: Jev decisions vs Morph line filtering'));
  console.log(
    c.dim(
      `  transcript: ${fixture.engine.length} messages, ${fixture.chars.toLocaleString('en-US')} chars (~${roughTokens(baseText).toLocaleString('en-US')} tokens)`,
    ),
  );
  console.log(c.dim(`  planted: ${criticalTotal} critical, ${importantTotal} important (facts buried mid-prose)`));
  console.log();

  const scores: Score[] = [];

  // --- reference points ---------------------------------------------------------
  scores.push(makeScore('identity', fixture, baseText));
  scores.push(makeScore('head-keep 30%', fixture, headKeep(baseText, 0.3)));
  scores.push(makeScore('proportional 30%', fixture, proportional(baseText, 0.3)));
  {
    const dropped = dropLargestResults(fixture.engine, 0.3);
    scores.push(makeScore('drop-largest 30%', fixture, serializeEngineMessages(dropped)));
  }

  // --- Jev ----------------------------------------------------------------------
  const jev = await runJev(fixture);
  if (jev) scores.push(jev);

  // --- Morph ratio sweep --------------------------------------------------------
  const morphKey = process.env.MORPH_API_KEY;
  if (morphKey) {
    const ratios = (process.env.MORPH_SWEEP ?? '0.9,0.7,0.5,0.3')
      .split(',')
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isFinite(n) && n > 0);
    for (const r of ratios) {
      try {
        scores.push(await runMorphAt(fixture, r, morphKey));
      } catch (err) {
        console.log(c.red(`  morph ratio ${r} failed: ${(err as Error).message}`));
      }
    }
  }

  header();
  for (const s of scores) console.log(renderRow(s));
  console.log();

  // --- what was lost ------------------------------------------------------------
  for (const s of scores) {
    if (s.strategy === 'identity') continue;
    if (s.lost.length === 0) continue;
    const ids = s.lost.map((f) => `${f.id}(${f.kind[0]})`).join(', ');
    console.log(`  ${c.bold(s.strategy)} ${c.red('lost')}: ${ids}`);
  }
  if (!scores.some((s) => s.lost.length > 0)) {
    console.log(c.green('  no strategy lost a planted fact'));
  }
  console.log();

  // --- verdict ------------------------------------------------------------------
  const morphScores = scores.filter((s) => s.strategy.startsWith('morph'));
  if (jev && morphScores.length > 0) {
    console.log(c.bold('  verdict'));

    // Comparing against Morph's *best-recall* ratio is misleading: the ratio
    // that keeps everything also barely compacts. The honest comparison is at
    // matched reduction — interpolate Morph's recall to Jev's reduction.
    const pts = morphScores
      .map((s) => ({ r: s.reduction, c: s.criticalKept / Math.max(1, s.criticalTotal), raw: s }))
      .sort((a, b) => a.r - b.r);

    const bestMorph = morphScores.reduce((a, b) =>
      b.criticalKept / Math.max(1, b.criticalTotal) > a.criticalKept / Math.max(1, a.criticalTotal)
        ? b
        : a,
    );

    const jevRatio = jev.criticalKept / Math.max(1, jev.criticalTotal);
    const jr = jev.reduction;

    let atMatched: { c: number; from: string } | undefined;
    const exact = pts.find((p) => Math.abs(p.r - jr) < 0.005);
    if (exact) {
      atMatched = { c: exact.c, from: exact.raw.strategy };
    } else {
      // Find the bracketing pair and interpolate.
      for (let i = 0; i < pts.length - 1; i += 1) {
        const a = pts[i]!;
        const b = pts[i + 1]!;
        if (a.r <= jr && jr <= b.r) {
          const t = (jr - a.r) / Math.max(1e-9, b.r - a.r);
          atMatched = {
            c: a.c + t * (b.c - a.c),
            from: `interpolated ${a.raw.strategy}..${b.raw.strategy}`,
          };
          break;
        }
      }
      // Jev compressed harder than any Morph ratio tried.
      if (!atMatched && pts.length > 0 && jr > pts[pts.length - 1]!.r) {
        const last = pts[pts.length - 1]!;
        atMatched = { c: last.c, from: `${last.raw.strategy} (best available)` };
      }
      if (!atMatched && pts.length > 0 && jr < pts[0]!.r) {
        const first = pts[0]!;
        atMatched = { c: first.c, from: `${first.raw.strategy} (best available)` };
      }
    }

    console.log(
      `    jev:   ${pct(jev.criticalKept, jev.criticalTotal)} critical at ${Math.round(jr * 100)}% reduced`,
    );
    console.log(
      `    morph: ${pct(bestMorph.criticalKept, bestMorph.criticalTotal)} critical at ${Math.round(bestMorph.reduction * 100)}% (best recall, ${morphScores.length} ratios tried)`,
    );
    if (atMatched) {
      console.log(
        c.dim(
          `    morph at matched ${Math.round(jr * 100)}% reduction: ${Math.round(atMatched.c * 100)}% critical [${atMatched.from}]`,
        ),
      );
      console.log();
      if (jevRatio > atMatched.c + 1e-9) {
        console.log(
          c.green(
            `    → at equal compression, Jev kept ${pct(jev.criticalKept, jev.criticalTotal)} of critical facts vs Morph's ~${Math.round(atMatched.c * 100)}%`,
          ),
        );
      } else if (jevRatio < atMatched.c - 1e-9) {
        console.log(
          c.red(
            `    → at equal compression, Morph kept ~${Math.round(atMatched.c * 100)}% vs Jev's ${pct(jev.criticalKept, jev.criticalTotal)}`,
          ),
        );
      } else {
        console.log(c.yellow('    → tied on critical recall at matched reduction'));
      }
    }
    console.log();
  } else if (!jev) {
    console.log(c.yellow('  TYPESAFE_API_KEY not set — Jev not measured'));
    console.log();
  }
}

main().catch((err) => {
  console.error(c.red(`bench failed: ${(err as Error).message}`));
  process.exit(1);
});
