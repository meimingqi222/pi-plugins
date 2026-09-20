/**
 * A synthetic transcript with *known* facts, so compaction quality can be
 * measured instead of eyeballed.
 *
 * Why it is built this way — the goal is to discriminate a **semantic** filter
 * from a **positional** one, so the fixture must defeat position:
 *
 *  1. Facts are buried in the *middle* of long prose blocks, not parked at the
 *     head or tail. A filter that keeps the first 30% of lines, or that keeps
 *     "boundary" lines, does not get them for free.
 *  2. Noise lives in both prose and tool output, interleaved with the facts, so
 *     "drop the big tool results" is not a complete answer either.
 *  3. Everything is superseded or re-derivable, so a competent judge has a
 *     principled reason to delete the noise.
 *
 * Scoring is on planted facts: **critical** (constraints, root cause, exact
 * errors, decisions — must not be lost) and **important** (paths, config —
 * nice to keep). A compactor that scores well keeps those and drops the noise,
 * however many tokens it spends.
 */

import type { Message, ToolResult, ToolUse } from '../src/jev/types.ts';
import type { PiMessage } from '../src/pi-adapter.ts';

export type FactKind = 'critical' | 'important';

export interface Fact {
  id: string;
  kind: FactKind;
  /** The literal text planted in the transcript. */
  text: string;
  where: 'user' | 'assistant' | 'toolResult';
}

export interface Fixture {
  engine: Message[];
  pi: PiMessage[];
  facts: Fact[];
  /** Total input size in characters. */
  chars: number;
}

// ---------------------------------------------------------------------------
// Planted facts
// ---------------------------------------------------------------------------

export const CRITICAL: Record<string, string> = {
  'constraint-generated':
    'CONSTRAINT: never edit anything under src/generated; it is overwritten by codegen on every build.',
  'constraint-compat':
    'CONSTRAINT: the public API of parseAuthToken must stay backward compatible through v2.',
  'root-cause':
    'ROOT CAUSE: the expiry check reads exp < now but tokens are issued at 1s granularity, so it must be exp <= now.',
  'exact-error':
    "EXACT ERROR: TypeError: Cannot read properties of undefined (reading 'exp') at verifyToken (src/auth/verify.ts:42:18)",
  'decision-window':
    'DECISION: use a 30 second sliding window with clock-skew tolerance instead of absolute comparison.',
  'decision-library':
    'DECISION: use jose for JWT verification; jsonwebtoken was rejected for bundle size.',
  'file-migration':
    'MIGRATION FILE: db/migrations/20260919_add_token_version.sql must run before the backfill job.',
  'test-command':
    'VERIFY WITH: bun test plugins/auth --filter "token expiry" (currently 3 failing).',
};

export const IMPORTANT: Record<string, string> = {
  'file-verify': 'FILE READ: src/auth/verify.ts holds verifyToken and a 12 line expiry helper.',
  'config-ttl': 'CONFIG: TOKEN_TTL_SECONDS defaults to 3600 in src/config/defaults.ts.',
  'file-routes': 'FILE READ: src/auth/routes.ts wires POST /login and POST /refresh.',
  'test-file': 'TEST FILE: src/auth/verify.test.ts has 14 cases, 3 of them red.',
};

/** Filler prose for one chapter. Indistinguishable from the fact-bearing prose. */
function prose(chapter: number, lines: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < lines; i += 1) {
    out.push(
      `${['Considering', 'Reviewing', 'Noting', 'Checking', 'Tracing'][(chapter + i) % 5]} ` +
        `chapter ${chapter} line ${i}: the helper at this level only forwards arguments and adds no policy of its own.`,
    );
  }
  return out;
}

/** Bulky, superseded, structurally repetitive tool output — safe to drop. */
function noiseOutput(chapter: number): string {
  const lines = [`Scanning module group ${chapter}/20 ...`];
  for (let j = 0; j < 55; j += 1) {
    lines.push(
      `  [${chapter}.${j}] found symbol candidate_${chapter}_${j} in package ${chapter} with 0 callers`,
    );
  }
  lines.push(`Group ${chapter} complete: 55 symbols, none requiring changes.`);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

/**
 * One chapter of the transcript: a long assistant prose block, optionally
 * carrying a fact near its middle, then a bulky tool result.
 */
interface Chapter {
  proseLines: number;
  fact?: { id: string; kind: FactKind };
  /** 0..1 position of the fact within the prose block. */
  factAt?: number;
  tool: boolean;
}

const CHAPTERS: Chapter[] = [
  { proseLines: 30, tool: true },
  { proseLines: 30, fact: { id: 'constraint-generated', kind: 'critical' }, factAt: 0.5, tool: true },
  { proseLines: 30, tool: true },
  { proseLines: 30, fact: { id: 'file-verify', kind: 'important' }, factAt: 0.55, tool: true },
  { proseLines: 30, tool: true },
  { proseLines: 30, fact: { id: 'constraint-compat', kind: 'critical' }, factAt: 0.45, tool: true },
  { proseLines: 30, tool: true },
  { proseLines: 30, fact: { id: 'config-ttl', kind: 'important' }, factAt: 0.5, tool: true },
  { proseLines: 30, tool: true },
  { proseLines: 30, fact: { id: 'root-cause', kind: 'critical' }, factAt: 0.5, tool: true },
  { proseLines: 30, tool: true },
  { proseLines: 30, fact: { id: 'exact-error', kind: 'critical' }, factAt: 0.52, tool: true },
  { proseLines: 30, tool: true },
  { proseLines: 30, fact: { id: 'file-routes', kind: 'important' }, factAt: 0.48, tool: true },
  { proseLines: 30, tool: true },
  { proseLines: 30, fact: { id: 'decision-window', kind: 'critical' }, factAt: 0.5, tool: true },
  { proseLines: 30, tool: true },
  { proseLines: 30, fact: { id: 'decision-library', kind: 'critical' }, factAt: 0.5, tool: true },
  { proseLines: 30, tool: true },
  { proseLines: 30, fact: { id: 'test-file', kind: 'important' }, factAt: 0.5, tool: true },
];

export function buildFixture(): Fixture {
  const engine: Message[] = [];
  const pi: PiMessage[] = [];
  const facts: Fact[] = [];

  const table = (kind: FactKind) => (kind === 'critical' ? CRITICAL : IMPORTANT);

  const user = (text: string) => {
    engine.push({ role: 'user', text, toolUses: [] });
    pi.push({ role: 'user', content: text });
  };

  const assistant = (text: string) => {
    engine.push({ role: 'assistant', text, toolUses: [] });
    pi.push({ role: 'assistant', content: [{ type: 'text', text }] });
  };

  const call = (id: string, tool: string, input: Record<string, unknown>, output: string) => {
    const use: ToolUse = { tool_use_id: id, tool, input, text: output };
    const paired: ToolResult = { tool_use_id: id, text: output };
    engine.push({ role: 'assistant', text: '', toolUses: [use], toolResults: [paired] });
    pi.push({ role: 'assistant', content: [{ type: 'toolCall', id, name: tool, arguments: input }] });
    pi.push({
      role: 'toolResult',
      toolCallId: id,
      toolName: tool,
      content: [{ type: 'text', text: output }],
    });
  };

  // --- turn 1: the working constraints, stated up front -------------------------
  user(
    [
      'We have failing auth tests in production and I need this fixed today.',
      'Walk the whole module tree before changing anything: I want to see the reasoning, not just a diff.',
      'Please investigate src/auth and tell me what is wrong first.',
    ].join('\n'),
  );

  // --- turn 2: the user restates two load-bearing constraints mid-conversation --
  user(
    [
      'Two things I forgot to mention, both important:',
      CRITICAL['constraint-compat'],
      CRITICAL['test-command'],
    ].join('\n'),
  );
  facts.push({ id: 'constraint-compat', kind: 'critical', text: CRITICAL['constraint-compat']!, where: 'user' });
  facts.push({ id: 'test-command', kind: 'critical', text: CRITICAL['test-command']!, where: 'user' });

  // --- 20 chapters, facts buried mid-prose --------------------------------------
  CHAPTERS.forEach((chapter, index) => {
    const lines = prose(index + 1, chapter.proseLines);
    if (chapter.fact) {
      const factText = table(chapter.fact.kind)[chapter.fact.id]!;
      const at = Math.min(
        lines.length - 1,
        Math.max(0, Math.floor(lines.length * (chapter.factAt ?? 0.5))),
      );
      lines[at] = factText;
      facts.push({
        id: chapter.fact.id,
        kind: chapter.fact.kind,
        text: factText,
        where: 'assistant',
      });
    }
    assistant(lines.join('\n'));

    if (chapter.tool) {
      call(`scan-${index + 1}`, 'grep', { pattern: `candidate_${index + 1}`, path: 'src' }, noiseOutput(index + 1));
    }
  });

  // --- a late load-bearing user message -----------------------------------------
  user(
    [
      'One more thing before you finish, and this one has bitten us before:',
      CRITICAL['file-migration'],
      'Do not skip it; the last deploy failed purely because of ordering.',
    ].join('\n'),
  );
  facts.push({ id: 'file-migration', kind: 'critical', text: CRITICAL['file-migration']!, where: 'user' });

  // --- trailing noise, so the tail is not a free win ----------------------------
  for (let i = 1; i <= 3; i += 1) {
    assistant(prose(100 + i, 20).join('\n'));
    const output = Array.from({ length: 40 }, (_, j) => `waiting for job ${i} step ${j} ... ok`).join('\n');
    call(`job-${i}`, 'bash', { command: `run job ${i}` }, output);
  }

  const chars = engine.reduce((sum, m) => {
    let n = m.text.length;
    for (const u of m.toolUses) n += JSON.stringify(u.input).length;
    for (const r of m.toolResults ?? []) n += r.text.length;
    return sum + n;
  }, 0);

  return { engine, pi, facts, chars };
}

/** Counts how many planted facts appear in a block of text. */
export function scoreFacts(
  facts: readonly Fact[],
  text: string,
): {
  kept: Fact[];
  lost: Fact[];
  byKind: Record<FactKind, { kept: number; total: number }>;
} {
  const kept: Fact[] = [];
  const lost: Fact[] = [];
  for (const fact of facts) {
    const probe = fact.text.slice(0, Math.min(48, fact.text.length));
    if (text.includes(probe)) kept.push(fact);
    else lost.push(fact);
  }
  const byKind: Record<FactKind, { kept: number; total: number }> = {
    critical: { kept: 0, total: 0 },
    important: { kept: 0, total: 0 },
  };
  for (const fact of facts) {
    byKind[fact.kind].total += 1;
    if (kept.includes(fact)) byKind[fact.kind].kept += 1;
  }
  return { kept, lost, byKind };
}

/** pi's own token estimate: characters over four. */
export function roughTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
