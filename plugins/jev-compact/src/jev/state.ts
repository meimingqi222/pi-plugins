/**
 * Vendored from `fast-jev-compaction` v0.2.0 (MIT, tamaratran). See ATTRIBUTION.md.
 *
 * Building the Jev **state**: the whole conversation, oldest first, with tool
 * results replaced by a short note. Fitting it into `maxStateTokens` is a
 * staged shrink — tool inputs, then long texts, then whole old messages.
 */

import type {
  CompactionState,
  FittedState,
  HistoryEntry,
  HistoryToolCall,
  Message,
  ResolvedCompactOptions,
  StateChunk,
  ToolCall,
  ToolResult,
} from './types.ts';

export const STATE_CONTEXT =
  'A coding assistant conversation is being compacted to free context. `history` is the whole conversation so far, oldest first; tool outputs are replaced by a short `result` note and long texts may be abridged. Each question asks whether one tool call, or the full output of that call, still needs to stay in the history verbatim. Whatever is not kept is deleted permanently, but the assistant can always re-run a tool or re-read a file.';

/** Successive caps on the serialised tool input included per call. */
const INPUT_CHARS = [1000, 200, 60] as const;
const TEXT_HEAD = 400;
const TEXT_TAIL = 150;

const TOKEN_PIECES = /[A-Za-z]+|\d+|[^\sA-Za-z\d]/g;

/**
 * True for CJK ideographs, kana and Hangul: scripts where one character is
 * closer to one token than to the nine-tenths a symbol is charged.
 *
 * Measured against Jev's reported `input_tokens`, a run of Chinese text costs
 * ~1.18 tokens per character while this estimator charged 0.9 — a 17% shortfall,
 * rising to 33% on mixed Chinese/identifier text. Underestimating is the
 * dangerous direction: the ceiling is enforced against *this* number, so a
 * window believed to be 30k could be over Jev's 32k limit and be rejected
 * outright. Overestimating only yields slightly smaller windows.
 */
function isCjk(code: number): boolean {
  return (
    (code >= 0x3040 && code <= 0x30ff) || // kana
    (code >= 0x3400 && code <= 0x4dbf) || // CJK extension A
    (code >= 0x4e00 && code <= 0x9fff) || // CJK unified ideographs
    (code >= 0xac00 && code <= 0xd7af) || // Hangul syllables
    (code >= 0xf900 && code <= 0xfaff) || // CJK compatibility ideographs
    (code >= 0xff00 && code <= 0xffef) // full-width forms
  );
}

/**
 * Estimates tokens without a tokenizer: a word costs one token per six
 * letters, a digit half a token, a CJK character one and a fifth, any other
 * symbol nine tenths. Calibrated against the usage Jev reports for real
 * transcripts.
 */
export function estimateTokens(text: string): number {
  let tokens = 0;
  for (const [piece] of text.matchAll(TOKEN_PIECES)) {
    const first = piece.charCodeAt(0);
    if (first >= 48 && first <= 57) tokens += piece.length / 2;
    else if ((first >= 65 && first <= 90) || (first >= 97 && first <= 122)) {
      tokens += 1 + Math.floor((piece.length - 1) / 6);
    } else if (piece.length === 1 && isCjk(first)) tokens += 1.2;
    else tokens += 0.9;
  }
  return Math.ceil(tokens);
}

export function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, Math.max(0, limit - 1))}…`;
}

function abridge(text: string, head: number, tail: number): string {
  if (text.length <= head + tail + 40) return text;
  const omitted = text.length - head - tail;
  return `${text.slice(0, head)}\n[… ${omitted} chars omitted …]\n${text.slice(-tail)}`;
}

export function isPinned(
  index: number,
  total: number,
  preserveRecentMessages: number,
): boolean {
  return index === 0 || index >= total - preserveRecentMessages;
}

/**
 * Pairs every tool_use with its tool_result by `tool_use_id`. Calls without a
 * result are not candidates (there is nothing to drop yet).
 */
export function collectToolCalls(
  messages: readonly Message[],
  preserveRecentMessages: number,
): ToolCall[] {
  const results = new Map<string, { index: number; result: ToolResult }>();
  messages.forEach((message, index) => {
    for (const result of message.toolResults ?? []) {
      results.set(result.tool_use_id, { index, result });
    }
  });
  const calls: ToolCall[] = [];
  messages.forEach((message, callIndex) => {
    for (const tool of message.toolUses) {
      const found = results.get(tool.tool_use_id);
      if (!found) continue;
      calls.push({
        id: `t${calls.length + 1}`,
        tool_use_id: tool.tool_use_id,
        tool: tool.tool,
        input: tool.input,
        callIndex,
        resultIndex: found.index,
        resultChars: found.result.text.length,
        isError: found.result.isError ?? false,
        pinned:
          isPinned(callIndex, messages.length, preserveRecentMessages) ||
          isPinned(found.index, messages.length, preserveRecentMessages),
      });
    }
  });
  return calls;
}

function inputText(input: Record<string, unknown>, limit: number): string {
  let json = '';
  try {
    json = JSON.stringify(input);
  } catch {
    json = '[unserializable input]';
  }
  return truncate(json, limit);
}

function resultNote(call: ToolCall): string {
  return `${call.isError ? 'error' : 'ok'}, ${call.resultChars} chars (omitted)`;
}

/** One call as a single line, for when the structured form is too costly. */
function compactCall(call: ToolCall): string {
  const input = Object.entries(call.input)
    .map(([key, value]) => {
      const text = typeof value === 'string' ? value : inputText({ [key]: value }, 200);
      return `${key}=${text.replace(/\s+/g, ' ')}`;
    })
    .join(' ');
  return `${call.id} ${call.tool} ${truncate(input, INPUT_CHARS[2])} → ${
    call.isError ? 'error' : 'ok'
  } ${call.resultChars}ch`;
}

/**
 * Folds runs of adjacent call-only entries into one entry each, so the
 * per-entry envelope is paid once per run; the call lines keep their ids.
 */
function mergeCallRuns(
  history: readonly HistoryEntry[],
  pinned: (e: HistoryEntry) => boolean,
): HistoryEntry[] {
  const merged: HistoryEntry[] = [];
  for (const entry of history) {
    const previous = merged[merged.length - 1];
    const foldable = (e: HistoryEntry): boolean =>
      !pinned(e) && e.text.length === 0 && typeof e.tool_calls?.[0] === 'string';
    if (previous && foldable(previous) && foldable(entry) && previous.role === entry.role) {
      previous.tool_calls = [
        ...(previous.tool_calls as string[]),
        ...(entry.tool_calls as string[]),
      ];
      continue;
    }
    merged.push({ ...entry });
  }
  return merged;
}

function callsByMessage(calls: readonly ToolCall[]): Map<number, ToolCall[]> {
  const byMessage = new Map<number, ToolCall[]>();
  for (const call of calls) {
    const list = byMessage.get(call.callIndex) ?? [];
    list.push(call);
    byMessage.set(call.callIndex, list);
  }
  return byMessage;
}

function historyEntries(
  messages: readonly Message[],
  calls: readonly ToolCall[],
  inputChars: number,
): HistoryEntry[] {
  const byMessage = callsByMessage(calls);
  const entries: HistoryEntry[] = [];
  messages.forEach((message, i) => {
    const toolCalls = (byMessage.get(i) ?? []).map((call) => ({
      id: call.id,
      tool: call.tool,
      input: inputText(call.input, inputChars),
      result: resultNote(call),
    }));
    if (message.text.trim().length === 0 && toolCalls.length === 0) return;
    const entry: HistoryEntry = { i, role: message.role, text: message.text };
    if (toolCalls.length > 0) entry.tool_calls = toolCalls;
    entries.push(entry);
  });
  return entries;
}

/** The last three user prompts, as the default `goal`. */
export function goalFromMessages(messages: readonly Message[]): string {
  return messages
    .filter(
      (message) =>
        message.role === 'user' &&
        message.text.trim().length > 0 &&
        (message.toolResults ?? []).length === 0,
    )
    .slice(-3)
    .map((message) => truncate(message.text, 500))
    .join('\n');
}

function stateOf(goal: string, history: HistoryEntry[]): CompactionState {
  return { context: STATE_CONTEXT, goal, history };
}

function entryTokens(entry: HistoryEntry): number {
  return estimateTokens(JSON.stringify(entry)) + 1;
}

function baseStateTokens(goal: string): number {
  return estimateTokens(JSON.stringify(stateOf(goal, [])));
}

/**
 * How many entries before a chunk's start are repeated as leading context, so a
 * call near a boundary is judged with the turns that preceded it. Without this
 * the first call of every window loses the context that explains it.
 */
export const DEFAULT_CHUNK_OVERLAP = 3;

/**
 * Share of a window's budget the repeated preamble may take. Small enough that a
 * huge first message cannot crowd out the body, large enough to hold a real
 * standing instruction without shrinking it.
 */
const PREAMBLE_BUDGET_SHARE = 0.25;

/** Stage names from least to most destructive; used to report the worst one. */
const STAGE_SEVERITY = [
  'full',
  'inputs<=200',
  'inputs<=60',
  'texts abridged',
  'old messages collapsed',
  'old calls compacted',
  'old messages left out',
  'old calls merged',
  'old traces dropped',
] as const;

/** The most destructive stage any window needed, so `full` means nothing shrank. */
export function worstStage(stages: readonly string[]): string {
  let worst = 0;
  for (const stage of stages) {
    const rank = STAGE_SEVERITY.indexOf(stage as (typeof STAGE_SEVERITY)[number]);
    if (rank > worst) worst = rank;
  }
  return STAGE_SEVERITY[worst]!;
}

/**
 * Shrinks one entry until it fits `budget`, reusing `fitState`'s stages in the
 * same order. Only needed for an entry that is larger than a whole window on its
 * own (a pasted document, or a message carrying many calls).
 *
 * Returns the stage that was needed, `full` when the entry already fit.
 */
function shrinkEntryToFit(
  entry: HistoryEntry,
  budget: number,
  originalTextLength: number,
): string {
  if (entryTokens(entry) <= budget) return 'full';
  if (entry.text.length > TEXT_HEAD + TEXT_TAIL + 40) {
    entry.text = abridge(entry.text, TEXT_HEAD, TEXT_TAIL);
    if (entryTokens(entry) <= budget) return 'texts abridged';
  }
  if (entry.text.length > 0) {
    entry.text = `[… ${originalTextLength} chars omitted …]`;
    if (entryTokens(entry) <= budget) return 'old messages collapsed';
  }
  if (Array.isArray(entry.tool_calls)) {
    const count = entry.tool_calls.length;
    entry.tool_calls = count > 0 ? [`(${count} tool calls omitted)`] : entry.tool_calls;
  }
  return 'old traces dropped';
}

function cloneEntry(entry: HistoryEntry): HistoryEntry {
  const copy: HistoryEntry = { i: entry.i, role: entry.role, text: entry.text };
  if (entry.tool_calls) {
    copy.tool_calls = Array.isArray(entry.tool_calls) && typeof entry.tool_calls[0] === 'string'
      ? [...(entry.tool_calls as string[])]
      : (entry.tool_calls as HistoryToolCall[]).map((call) => ({ ...call }));
  }
  return copy;
}

/**
 * Splits the conversation into contiguous windows that each fit Jev's request
 * ceiling, and returns for each window the calls it is responsible for.
 *
 * This replaces "shrink the whole history into one budget" as the primary
 * strategy. Jev's limit bounds **one request's state**, not the conversation, so
 * a long session becomes several windows instead of one mutilated one. The
 * difference is not cosmetic: a 1600-call session used to collapse to a 747-token
 * state — every trace dropped — and Jev was asked to judge calls it could no
 * longer see. Windows keep each call beside its own context.
 *
 * Every window carries the conversation's first entry as a preamble (it holds the
 * standing instruction) plus `overlapEntries` of leading context from the window
 * before it. Only the body of a window owns calls, so a call is decided exactly
 * once, in the window whose body contains it.
 */
export function chunkState(
  messages: readonly Message[],
  calls: readonly ToolCall[],
  options: Pick<
    ResolvedCompactOptions,
    'maxStateTokens' | 'preserveRecentMessages' | 'goal'
  > & { overlapEntries?: number },
): StateChunk[] {
  const goal = options.goal || goalFromMessages(messages);
  const overlap = Math.max(0, Math.floor(options.overlapEntries ?? DEFAULT_CHUNK_OVERLAP));
  const budget = Math.max(1, options.maxStateTokens);
  const entries = historyEntries(messages, calls, INPUT_CHARS[0]);
  if (entries.length === 0) return [];

  const tokens = entries.map(entryTokens);
  const base = baseStateTokens(goal);

  // Reduce oversized entries *before* packing. Packing charges the preamble to
  // every window and each body entry to one window; an entry larger than a body
  // can hold makes packing degenerate. Measured on a real session whose first
  // message was an 823k-char `previousSummary` (~200k tokens): the packer emitted
  // **318 windows for 318 messages**, each holding one entry at 3,916 tokens
  // against a 28k budget — 14% utilisation and a request per message.
  const stages: string[] = [];

  // The preamble is the conversation's first entry, repeated in every window to
  // carry the standing instruction. That only works while it is small. A prior
  // compaction summary enters as the first message and is pure text, so it can be
  // hundreds of KB; left at full size it would be charged to every request. It is
  // capped to a share of the budget and abridged to its head and tail — the head
  // usually names the overall task, which is the part worth keeping.
  const preambleCap = Math.max(1, Math.floor(budget * PREAMBLE_BUDGET_SHARE));
  const first = entries[0]!;
  if (entryTokens(first) > preambleCap) {
    stages.push(
      shrinkEntryToFit(first, preambleCap, messages[first.i]?.text.length ?? first.text.length),
    );
    tokens[0] = entryTokens(first);
  }
  const preambleTokens = tokens[0]!;

  // Any remaining entry that cannot share a body with the preamble would also get
  // a window to itself. Shrink it first so it packs normally.
  const bodyBudget = Math.max(1, budget - base - preambleTokens);
  for (let i = 1; i < entries.length; i += 1) {
    if (tokens[i]! <= bodyBudget) continue;
    const entry = entries[i]!;
    stages.push(
      shrinkEntryToFit(entry, bodyBudget, messages[entry.i]?.text.length ?? entry.text.length),
    );
    tokens[i] = entryTokens(entry);
  }
  const preShrinkStage = worstStage(stages);

  // Pack windows so that `preamble + overlap + body` fits the budget. The overlap
  // is *reserved* rather than dropped-on-overflow: a full window is the normal
  // case for a long conversation, so dropping overlap first would mean overlap
  // never applied exactly when it was needed. Reserving it keeps the leading
  // context of every boundary call.
  //
  // The reservation is capped so the window's **first body entry** always fits.
  // Without that cap the preamble plus a full overlap can consume the budget
  // before any body entry is added, and the per-entry shrinker cannot repair it:
  // the body entry already fits the body budget on its own, so
  // `shrinkEntryToFit` is a no-op and the window reaches the throw below.
  // Measured on five pasted documents of ~6k tokens each: the second window
  // needed 30,251 tokens against a 28,000 budget, `chunkState` threw, and the
  // caller silently fell back to the single-window `fitState` — the exact
  // "whole history shrank, the model is blind" failure windowing exists to fix.
  const ranges: Array<{ start: number; end: number; overlap: number[] }> = [];
  let start = 0;
  while (start < entries.length) {
    // Reserve overlap from the newest entries backwards (the context closest to
    // the body is the most relevant), leaving room for `tokens[start]`.
    const firstBodyTokens = tokens[start]!;
    const overlapBudget = Math.max(0, budget - base - preambleTokens - firstBodyTokens);
    const overlapPositions: number[] = [];
    let overlapUsed = 0;
    for (let i = start - 1; i > 0 && i >= Math.max(0, start - overlap); i -= 1) {
      if (overlapUsed + tokens[i]! > overlapBudget) continue;
      overlapPositions.push(i);
      overlapUsed += tokens[i]!;
    }
    overlapPositions.reverse(); // oldest first, matching history order
    const charged = new Set<number>([0, ...overlapPositions]);
    let used = base + preambleTokens + overlapUsed;
    let end = start;
    while (end < entries.length) {
      if (end > start && used + tokens[end]! > budget) break;
      if (charged.has(end)) {
        end += 1;
        continue;
      }
      used += tokens[end]!;
      end += 1;
    }
    // A single entry larger than the budget still has to go somewhere; give it a
    // window of its own and let the per-entry shrinker handle it below.
    ranges.push({ start, end: Math.max(end, start + 1), overlap: overlapPositions });
    start = Math.max(end, start + 1);
  }

  // Map each candidate call to the entry position that holds it, so a window can
  // claim the calls inside its body.
  const positionOfMessage = new Map<number, number>();
  entries.forEach((entry, position) => positionOfMessage.set(entry.i, position));
  const candidatesByPosition = new Map<number, ToolCall[]>();
  for (const call of calls) {
    if (call.pinned) continue;
    const position = positionOfMessage.get(call.callIndex);
    if (position === undefined) continue;
    const list = candidatesByPosition.get(position) ?? [];
    list.push(call);
    candidatesByPosition.set(position, list);
  }

  const chunks: StateChunk[] = [];
  for (const range of ranges) {
    const history: HistoryEntry[] = [];
    const seen = new Set<number>();
    const add = (position: number): void => {
      if (seen.has(position)) return;
      seen.add(position);
      history.push(cloneEntry(entries[position]!));
    };
    // Leading context, oldest first: preamble, then the reserved overlap, then
    // the body. The overlap positions are the ones the packer actually reserved,
    // so the built window matches the size the packer planned for.
    add(0);
    for (const position of range.overlap) add(position);
    for (let i = range.start; i < range.end; i++) add(i);

    let total = base + history.reduce((sum, entry) => sum + entryTokens(entry), 0);

    // A single body entry larger than the whole window. Pre-shrinking above
    // should have handled this, so reaching here means the entry could not be
    // reduced further; shrink in place rather than emitting an oversized request.
    let stage = preShrinkStage;
    if (total > budget) {
      const stages: string[] = [];
      for (const entry of history) {
        const original = messages[entry.i]?.text.length ?? entry.text.length;
        stages.push(shrinkEntryToFit(entry, Math.max(1, budget - base), original));
      }
      stage = worstStage(stages);
      total = base + history.reduce((sum, entry) => sum + entryTokens(entry), 0);
    }

    if (total > budget) {
      throw new Error(
        `one message is larger than a Jev window (~${total} tokens, limit ${budget})`,
      );
    }

    const chunkCalls: ToolCall[] = [];
    for (let i = range.start; i < range.end; i++) {
      chunkCalls.push(...(candidatesByPosition.get(i) ?? []));
    }
    chunks.push({ state: stateOf(goal, history), tokens: total, stage, calls: chunkCalls });
  }
  return chunks;
}

/**
 * Builds the Jev state from the whole conversation and shrinks it in stages
 * until it fits `maxStateTokens`: tool inputs are truncated, then long texts
 * are abridged oldest-first (pinned messages last), then old messages collapse
 * to a one-line note, then old tool calls shrink to one line each, then old
 * messages that carry no call are left out, then runs of old call-only
 * messages are folded into one entry. Throws when even that is too big.
 *
 * Superseded by `chunkState` as the primary strategy — shrinking the whole
 * conversation into one window is what made long sessions unreadable to Jev.
 * Kept because it is the honest fallback when a *single* window cannot be made
 * to fit, and because its stages are what `shrinkEntryToFit` reuses.
 */
export function fitState(
  messages: readonly Message[],
  calls: readonly ToolCall[],
  options: Pick<ResolvedCompactOptions, 'maxStateTokens' | 'preserveRecentMessages' | 'goal'>,
): FittedState {
  const goal = options.goal || goalFromMessages(messages);
  const baseTokens = baseStateTokens(goal);
  const fitted = (history: HistoryEntry[], tokens: number, stage: string): FittedState => ({
    state: stateOf(goal, history),
    tokens,
    stage,
  });

  let history: HistoryEntry[] = [];
  let perEntry: number[] = [];
  let tokens = 0;
  const rebuild = (inputChars: number): void => {
    history = historyEntries(messages, calls, inputChars);
    perEntry = history.map(entryTokens);
    tokens = baseTokens + perEntry.reduce((sum, n) => sum + n, 0);
  };
  const fits = (): boolean => tokens <= options.maxStateTokens;
  const shrink = (index: number, change: (entry: HistoryEntry) => void): void => {
    const entry = history[index];
    if (!entry) return;
    change(entry);
    const now = entryTokens(entry);
    tokens += now - (perEntry[index] ?? 0);
    perEntry[index] = now;
  };

  rebuild(INPUT_CHARS[0]);
  if (fits()) return fitted(history, tokens, 'full');

  for (const limit of INPUT_CHARS.slice(1)) {
    rebuild(limit);
    if (fits()) return fitted(history, tokens, `inputs<=${limit}`);
  }

  const pinned = (entry: HistoryEntry): boolean =>
    isPinned(entry.i, messages.length, options.preserveRecentMessages);
  const indices = history.map((_, index) => index);
  const order = [
    ...indices.filter((index) => !pinned(history[index]!)),
    ...indices.filter((index) => pinned(history[index]!)),
  ];

  for (const index of order) {
    const entry = history[index]!;
    if (entry.text.length <= TEXT_HEAD + TEXT_TAIL + 40) continue;
    shrink(index, (e) => {
      e.text = abridge(e.text, TEXT_HEAD, TEXT_TAIL);
    });
    if (fits()) return fitted(history, tokens, 'texts abridged');
  }

  for (const index of order) {
    const entry = history[index]!;
    if (pinned(entry) || entry.text.length === 0) continue;
    const original = messages[entry.i]?.text.length ?? entry.text.length;
    shrink(index, (e) => {
      e.text = `[… ${original} chars omitted …]`;
    });
    if (fits()) return fitted(history, tokens, 'old messages collapsed');
  }

  const byMessage = callsByMessage(calls);
  for (const index of order) {
    const entry = history[index]!;
    const own = byMessage.get(entry.i);
    if (pinned(entry) || !own) continue;
    shrink(index, (e) => {
      e.tool_calls = own.map(compactCall);
    });
    if (fits()) return fitted(history, tokens, 'old calls compacted');
  }

  const left = new Set<number>();
  for (const index of order) {
    const entry = history[index]!;
    if (pinned(entry) || entry.tool_calls) continue;
    left.add(index);
    tokens -= perEntry[index] ?? 0;
    if (fits()) {
      return fitted(
        history.filter((_, i) => !left.has(i)),
        tokens,
        'old messages left out',
      );
    }
  }

  history = mergeCallRuns(
    history.filter((_, i) => !left.has(i)),
    pinned,
  );
  perEntry = history.map(entryTokens);
  tokens = baseTokens + perEntry.reduce((sum, n) => sum + n, 0);
  if (fits()) return fitted(history, tokens, 'old calls merged');

  // Last resort: drop whole call traces, oldest first, while keeping every text
  // entry. Every earlier stage shrinks *within* an entry, so a conversation with
  // enough tool calls hits a floor (~69 tokens per call) that no amount of
  // per-entry truncation can go below — at 387 calls the floor is ~27k, over the
  // default 25k budget, and the previous code threw. Throwing loses the whole
  // compaction (the caller falls back), so a coarser stage is strictly better:
  // dropping the oldest traces keeps the decision quality for recent calls and
  // still tells Jev which calls existed, because the entry's own text remains.
  //
  // Jev's request ceiling is ~32k tokens (measured: 32,343 accepted, 32,812
  // rejected with `max_tokens_exceeded`), so this stage must be able to reach
  // well under that even for very long conversations.
  const traceOrder = history
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => !pinned(entry) && entry.tool_calls !== undefined)
    .map(({ index }) => index)
    .reverse();

  for (const index of traceOrder) {
    shrink(index, (e) => {
      const count = Array.isArray(e.tool_calls) ? e.tool_calls.length : 0;
      e.tool_calls = count > 0 ? [`(${count} tool calls omitted)`] : e.tool_calls;
    });
    if (fits()) return fitted(history, tokens, 'old traces dropped');
  }

  throw new Error(
    `history too large for Jev (~${tokens} tokens after truncation, limit ${options.maxStateTokens})`,
  );
}
