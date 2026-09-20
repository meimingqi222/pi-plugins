/**
 * Replays a **real pi session** through both compaction strategies and measures
 * what each one preserved.
 *
 * Why this exists: the synthetic `fixture.ts` scores facts by "does this string
 * survive somewhere in the output". That cannot tell "kept because the text was
 * preserved" from "kept because an unrelated tool result happened to contain the
 * same string". On a real transcript — where 97% of the bytes are tool output —
 * that ambiguity dominates, and it flatters whichever strategy keeps bulk.
 *
 * This script therefore scores two things that cannot be confused:
 *
 *   - **text preservation** — for every user/assistant text message, is a 60-char
 *     probe of it still present? Text carries the constraints and decisions, and
 *     is the only thing a compaction may not legitimately discard.
 *   - **bulk reduction** — how much smaller the result got.
 *
 * It also replays the *exact* input the original compaction saw, including the
 * cut point, so the comparison is against the same bytes.
 *
 * Usage:
 *   TYPESAFE_API_KEY=... MORPH_API_KEY=... \
 *     bun bench/replay-session.ts <session.jsonl> [--limit N]
 */

import { readFileSync } from 'node:fs';

import { morphCompact, type MorphMessage } from './morph-client.ts';
import { compact, reductionRatio } from '../src/jev/compact.ts';
import { JevClient } from '../src/jev/client.ts';
import { withRetry } from '../src/retry.ts';
import { serializeEngineMessages, toEngineMessages, type PiMessage } from '../src/pi-adapter.ts';
import type { Message } from '../src/jev/types.ts';

// ---------------------------------------------------------------------------
// Session loading
// ---------------------------------------------------------------------------

interface SessionEntry {
  type: string;
  id?: string;
  message?: PiMessage;
  firstKeptEntryId?: string;
  summary?: string;
  details?: { provider?: string; [k: string]: unknown };
}

function readSession(path: string): SessionEntry[] {
  return readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as SessionEntry);
}

function lastCompaction(entries: readonly SessionEntry[]): SessionEntry | undefined {
  return [...entries].reverse().find((e) => e.type === 'compaction');
}

// ---------------------------------------------------------------------------
// Measurement
// ---------------------------------------------------------------------------

interface TextProbe {
  role: 'user' | 'assistant';
  probe: string;
  chars: number;
}

/**
 * Every user/assistant text message becomes a probe. `firstKeptEntryId` and the
 * pinned tail are part of the input pi gives the summarizer, so they are probed
 * too — a strategy is not credited for text that was never its responsibility.
 */
function textProbes(engine: readonly Message[]): TextProbe[] {
  return engine
    .filter((m) => m.text.trim().length > 0)
    .map((m) => ({ role: m.role as 'user' | 'assistant', probe: m.text.trim().slice(0, 60), chars: m.text.length }));
}

function measureText(probes: readonly TextProbe[], text: string): { kept: number; total: number; userKept: number; userTotal: number; lost: TextProbe[] } {
  const keptList = probes.filter((p) => text.includes(p.probe));
  const lost = probes.filter((p) => !text.includes(p.probe));
  return {
    kept: keptList.length,
    total: probes.length,
    userKept: keptList.filter((p) => p.role === 'user').length,
    userTotal: probes.filter((p) => p.role === 'user').length,
    lost,
  };
}

interface Row {
  strategy: string;
  chars: number;
  reduction: number;
  textKept: number;
  textTotal: number;
  userKept: number;
  userTotal: number;
  ms: number;
  /** The rendered output, so the lost-text detail can name what vanished. */
  output: string;
  note?: string;
}

const useColor = process.stdout.isTTY === true;
const c = {
  bold: (s: string) => (useColor ? `\x1b[1m${s}\x1b[0m` : s),
  dim: (s: string) => (useColor ? `\x1b[2m${s}\x1b[0m` : s),
  green: (s: string) => (useColor ? `\x1b[32m${s}\x1b[0m` : s),
  red: (s: string) => (useColor ? `\x1b[31m${s}\x1b[0m` : s),
  yellow: (s: string) => (useColor ? `\x1b[33m${s}\x1b[0m` : s),
};

function renderRow(r: Row): string {
  const ratio = r.textKept / Math.max(1, r.textTotal);
  const cell = ratio === 1 ? c.green(`${r.textKept}/${r.textTotal}`) : ratio >= 0.8 ? c.yellow(`${r.textKept}/${r.textTotal}`) : c.red(`${r.textKept}/${r.textTotal}`);
  return (
    `  ${r.strategy.padEnd(24)}` +
    `${r.chars.toLocaleString('en-US').padStart(10)}` +
    `${`${Math.round(r.reduction * 100)}%`.padStart(7)}   ` +
    `${cell.padEnd(14)} ${`${r.userKept}/${r.userTotal}`.padEnd(10)} ` +
    `${`${r.ms}ms`.padStart(7)} ${r.note ?? ''}`
  );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith('--'));
  if (!file) {
    console.error('usage: bun bench/replay-session.ts <session.jsonl> [--limit N]');
    process.exit(1);
  }
  const limitIdx = args.indexOf('--limit');
  const limit = limitIdx >= 0 ? Number(args[limitIdx + 1]) : undefined;

  const entries = readSession(file);
  const comp = lastCompaction(entries);
  if (!comp) {
    console.error('no compaction entry in this session — nothing to replay');
    process.exit(1);
  }

  const fkIdx = entries.findIndex((e) => e.id === comp.firstKeptEntryId);
  if (fkIdx < 0) {
    console.error(`firstKeptEntryId ${comp.firstKeptEntryId} not found`);
    process.exit(1);
  }

  // The exact messages pi handed the summarizer.
  let summarize = entries.slice(0, fkIdx).filter((e) => e.type === 'message').map((e) => e.message!);
  if (limit !== undefined && Number.isFinite(limit)) summarize = summarize.slice(0, limit);

  const engine = toEngineMessages(summarize);
  const probes = textProbes(engine);
  const baseText = serializeEngineMessages(engine);

  const toolChars = engine.reduce(
    (s, m) =>
      s +
      (m.toolResults ?? []).reduce((a, r) => a + r.text.length, 0) +
      m.toolUses.reduce((a, u) => a + JSON.stringify(u.input).length, 0),
    0,
  );
  const textChars = engine.reduce((s, m) => s + m.text.length, 0);
  const calls = engine.reduce((s, m) => s + m.toolUses.length, 0);

  console.log();
  console.log(c.bold('  replay of a real pi session'));
  console.log(c.dim(`  ${file.split(/[/\\]/).pop()}`));
  console.log(
    c.dim(
      `  summarizer input: ${summarize.length} messages → ${engine.length} engine messages; ` +
        `${calls} tool calls`,
    ),
  );
  console.log(
    c.dim(
      `  composition: ${textChars.toLocaleString()} text chars (${((textChars / (textChars + toolChars)) * 100).toFixed(1)}%), ` +
        `${toolChars.toLocaleString()} tool chars (${((toolChars / (textChars + toolChars)) * 100).toFixed(1)}%)`,
    ),
  );
  if (comp.details?.provider) {
    console.log(
      c.dim(
        `  recorded in-session: provider=${comp.details.provider}, summary=${comp.summary!.length.toLocaleString()} chars`,
      ),
    );
  }
  console.log();

  const rows: Row[] = [];
  rows.push({
    strategy: 'identity',
    chars: baseText.length,
    reduction: 0,
    ...flatten(measureText(probes, baseText)),
    ms: 0,
    output: baseText,
  });

  // --- Jev threshold sweep ---------------------------------------------------
  if (process.env.TYPESAFE_API_KEY) {
    const client = withRetry(new JevClient({ apiKey: process.env.TYPESAFE_API_KEY }), {
      maxAttempts: 4,
      baseDelayMs: 300,
    });
    for (const th of (process.env.JEV_THRESHOLDS ?? '0.2,0.5').split(',').map(Number)) {
      const t0 = Date.now();
      try {
        const r = await compact(engine, client, {
          preserveRecentMessages: 6,
          keepThreshold: th,
          truncateHeadChars: 300,
        });
        const text = serializeEngineMessages(r.messages);
        const m = measureText(probes, text);
        rows.push({
          strategy: `jev (threshold ${th})`,
          chars: text.length,
          reduction: reductionRatio(r),
          ...flatten(m),
          ms: Date.now() - t0,
          output: text,
          note: c.dim(`${r.stats.callsDropped}/${r.stats.calls} calls dropped, ${r.stats.resultsDropped} truncated`),
        });
      } catch (err) {
        console.log(c.red(`  jev threshold ${th} failed: ${(err as Error).message}`));
      }
    }
  } else {
    console.log(c.yellow('  TYPESAFE_API_KEY not set — Jev skipped'));
  }

  // --- Morph ratio sweep -----------------------------------------------------
  if (process.env.MORPH_API_KEY) {
    const morphInput: MorphMessage[] = [{ role: 'user', content: baseText }];
    for (const ratio of (process.env.MORPH_RATIOS ?? '0.9,0.5,0.3').split(',').map(Number)) {
      const t0 = Date.now();
      try {
        const mo = await morphCompact(morphInput, {
          apiKey: process.env.MORPH_API_KEY,
          compressionRatio: ratio,
          preserveRecent: 1,
        });
        const m = measureText(probes, mo.output);
        rows.push({
          strategy: `morph (ratio ${ratio})`,
          chars: mo.output.length,
          reduction: 1 - mo.output.length / baseText.length,
          ...flatten(m),
          ms: Date.now() - t0,
          output: mo.output,
        });
      } catch (err) {
        console.log(c.red(`  morph ratio ${ratio} failed: ${(err as Error).message}`));
      }
    }
  } else {
    console.log(c.yellow('  MORPH_API_KEY not set — Morph skipped'));
  }

  console.log(
    c.bold(
      `  ${'strategy'.padEnd(24)}${'chars'.padStart(10)}${'reduc'.padStart(7)}   ${'text kept'.padEnd(14)} ${'user'.padEnd(10)} ${''.padStart(7)}`,
    ),
  );
  for (const r of rows) console.log(renderRow(r));
  console.log();

  // --- what text each real strategy lost -------------------------------------
  for (const r of rows) {
    if (r.strategy === 'identity') continue;
    const m = measureText(probes, r.output);
    if (m.lost.length === 0) continue;
    const users = m.lost.filter((p) => p.role === 'user').length;
    const asst = m.lost.length - users;
    console.log(
      `  ${c.bold(r.strategy)} ${c.red('dropped text')}: ${m.lost.length} messages (${users} user, ${asst} assistant, ${m.lost.reduce((s, p) => s + p.chars, 0).toLocaleString()} chars)`,
    );
    for (const p of m.lost.slice(0, 3)) {
      console.log(c.dim(`      [${p.role}] ${p.probe.replace(/\s+/g, ' ').slice(0, 70)}…`));
    }
    if (m.lost.length > 3) console.log(c.dim(`      … and ${m.lost.length - 3} more`));
  }
  console.log();
  // --- matched-reduction comparison ------------------------------------------
  const jevRows = rows.filter((r) => r.strategy.startsWith('jev'));
  const morphRows = rows.filter((r) => r.strategy.startsWith('morph'));
  if (jevRows.length > 0 && morphRows.length > 0) {
    console.log(c.bold('  at matched reduction'));
    for (const j of jevRows) {
      const pts = morphRows
        .map((m) => ({ r: m.reduction, t: m.textKept / Math.max(1, m.textTotal), raw: m }))
        .sort((a, b) => a.r - b.r);
      let matched: { t: number; from: string } | undefined;
      for (let i = 0; i < pts.length - 1; i += 1) {
        const a = pts[i]!;
        const b = pts[i + 1]!;
        if (a.r <= j.reduction && j.reduction <= b.r) {
          const f = (j.reduction - a.r) / Math.max(1e-9, b.r - a.r);
          matched = { t: a.t + f * (b.t - a.t), from: `${a.raw.strategy}..${b.raw.strategy}` };
          break;
        }
      }
      if (!matched && pts.length > 0 && j.reduction > pts[pts.length - 1]!.r) {
        matched = { t: pts[pts.length - 1]!.t, from: `${pts[pts.length - 1]!.raw.strategy} (max tried)` };
      }
      if (!matched && pts.length > 0 && j.reduction < pts[0]!.r) {
        matched = { t: pts[0]!.t, from: `${pts[0]!.raw.strategy} (min tried)` };
      }
      if (!matched) continue;
      const jt = j.textKept / Math.max(1, j.textTotal);
      const verdict = jt > matched.t ? c.green('Jev keeps more text') : jt < matched.t ? c.red('Morph keeps more text') : c.yellow('tie');
      console.log(
        `    ${j.strategy.padEnd(20)} ${Math.round(j.reduction * 100)}% reduction: text ${j.textKept}/${j.textTotal} (${Math.round(jt * 100)}%)`,
      );
      console.log(
        `    ${''.padEnd(20)} morph at same reduction: ${Math.round(matched.t * 100)}% [${matched.from}] → ${verdict}`,
      );
    }
    console.log();
  }
}

/**
 * Flattens a measurement into the row fields.
 */
function flatten(m: ReturnType<typeof measureText>): {
  textKept: number;
  textTotal: number;
  userKept: number;
  userTotal: number;
} {
  return { textKept: m.kept, textTotal: m.total, userKept: m.userKept, userTotal: m.userTotal };
}

main().catch((err) => {
  console.error(c.red(`replay failed: ${(err as Error).message}`));
  process.exit(1);
});
