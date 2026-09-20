/**
 * Vendored from `fast-jev-compaction` v0.2.0 (MIT, tamaratran). See ATTRIBUTION.md.
 *
 * The decision core: for every unpinned tool call, ask Jev whether the *call*
 * still matters and whether its *result* still needs to stay verbatim, then
 * delete/truncate accordingly. Text messages are never rewritten — this is the
 * whole point of the design.
 */

import { noulAnswer } from './request.ts';
import { droppedCallChars, keptCallChars, serializedChars } from '../serialize.ts';
import { chunkState, collectToolCalls, estimateTokens, fitState, worstStage } from './state.ts';
import type {
  AskOptions,
  CallAnswer,
  CallDecision,
  CompactOptions,
  CompactResult,
  CompactionState,
  FittedState,
  JevAsker,
  JevQuestions,
  Message,
  ResolvedCompactOptions,
  StateChunk,
  ToolCall,
  ToolUse,
} from './types.ts';

export const DEFAULT_OPTIONS: ResolvedCompactOptions = {
  goal: '',
  keepThreshold: 0.5,
  preserveRecentMessages: 6,
  // One window of state. Jev's ceiling is 32k for `state` plus the longest
  // question (docs.typesafe.ai/models).
  //
  // Not 32k, because the ceiling is enforced against `estimateTokens`, which has
  // no tokenizer and is content-dependent: measured against Jev's reported
  // `input_tokens`, English prose came out ~10% optimistic and mixed
  // Chinese/identifier text ~11%. A 32k window would therefore be a ~35k request
  // and rejected outright. 28k leaves ~12% headroom, enough for the worst
  // observed error, and is still far more context per window than the old
  // whole-conversation budget allowed.
  maxStateTokens: 28_000,
  // Jev's full request budget is 64k (`state` + all questions combined). The
  // previous 30k was half of that and forced 9 requests where 2 suffice, each
  // re-sending the whole state — measured at 269k billed input tokens instead of
  // 94k for the same decisions.
  maxRequestTokens: 64_000,
  maxConcurrentRequests: 4,
  truncateHeadChars: 300,
};

/** Tokens the request envelope (`model`, key names) adds around state and questions. */
const REQUEST_OVERHEAD_TOKENS = 20;

function finite(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function probability(value: number | undefined, fallback: number): number {
  return Math.min(1, Math.max(0, finite(value, fallback)));
}

export function resolveOptions(options: CompactOptions = {}): ResolvedCompactOptions {
  return {
    goal: options.goal ?? DEFAULT_OPTIONS.goal,
    keepThreshold: probability(options.keepThreshold, DEFAULT_OPTIONS.keepThreshold),
    preserveRecentMessages: Math.max(
      0,
      Math.floor(
        finite(options.preserveRecentMessages, DEFAULT_OPTIONS.preserveRecentMessages),
      ),
    ),
    maxStateTokens: Math.max(1, finite(options.maxStateTokens, DEFAULT_OPTIONS.maxStateTokens)),
    maxRequestTokens: Math.max(
      1,
      finite(options.maxRequestTokens, DEFAULT_OPTIONS.maxRequestTokens),
    ),
    maxConcurrentRequests: Math.max(
      1,
      Math.floor(
        finite(options.maxConcurrentRequests, DEFAULT_OPTIONS.maxConcurrentRequests),
      ),
    ),
    truncateHeadChars: Math.max(
      0,
      Math.floor(finite(options.truncateHeadChars, DEFAULT_OPTIONS.truncateHeadChars)),
    ),
  };
}

/** The two `noul` questions asked about one call: keep the call, keep its result. */
export function questionsFor(call: ToolCall): JevQuestions {
  return {
    [`call_${call.id}`]: {
      type: 'noul',
      instructions: `Tool call ${call.id} (${call.tool}) should stay in the history: knowing this call was made, with its input, still matters for what the assistant does next`,
    },
    [`result_${call.id}`]: {
      type: 'noul',
      instructions: `The full output of tool call ${call.id} (${call.tool}, ${call.resultChars} chars) should stay in the history verbatim: the assistant still needs its contents and re-running the tool would not do`,
    },
  };
}

/**
 * Splits the candidate calls into batches whose questions, together with the
 * (always complete) state, fit one request.
 */
export function batchCalls(
  calls: readonly ToolCall[],
  stateTokens: number,
  options: Pick<ResolvedCompactOptions, 'maxRequestTokens'>,
): ToolCall[][] {
  const budget = options.maxRequestTokens - stateTokens - REQUEST_OVERHEAD_TOKENS;
  const batches: ToolCall[][] = [];
  let current: ToolCall[] = [];
  let currentTokens = 0;
  for (const call of calls) {
    const tokens = estimateTokens(JSON.stringify(questionsFor(call)));
    if (current.length > 0 && currentTokens + tokens > budget) {
      batches.push(current);
      current = [];
      currentTokens = 0;
    }
    if (current.length === 0 && tokens > budget) {
      throw new Error(
        `state leaves no room for questions (~${stateTokens} of ${options.maxRequestTokens} tokens)`,
      );
    }
    current.push(call);
    currentTokens += tokens;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

export function decideCall(
  call: Pick<ToolCall, 'id' | 'tool' | 'pinned'>,
  answer: CallAnswer,
  options: Pick<ResolvedCompactOptions, 'keepThreshold'>,
): CallDecision {
  const base = { id: call.id, tool: call.tool, ...answer };
  if (call.pinned) return { ...base, action: 'keep', reason: 'pinned' };
  if (answer.keepResult >= options.keepThreshold) {
    return { ...base, action: 'keep', reason: 'kept' };
  }
  if (answer.keepCall >= options.keepThreshold) {
    return { ...base, action: 'drop_result', reason: 'result_dropped' };
  }
  return { ...base, action: 'drop_call', reason: 'call_dropped' };
}

async function askBatch(
  asker: JevAsker,
  state: CompactionState,
  batch: readonly ToolCall[],
  options: AskOptions,
): Promise<Map<string, CallAnswer>> {
  const questions: JevQuestions = Object.assign({}, ...batch.map(questionsFor));
  const { answers } = await asker.ask(state, questions, options);
  return new Map(
    batch.map((call) => [
      call.id,
      {
        keepCall: noulAnswer(answers, `call_${call.id}`),
        keepResult: noulAnswer(answers, `result_${call.id}`),
      },
    ]),
  );
}

export function truncatedResultText(
  text: string,
  isError: boolean,
  headChars: number,
): string {
  if (text.length <= headChars + 120) return text;
  const head = headChars > 0 ? `${text.slice(0, headChars)}\n` : '';
  return `${head}[jev-compact truncated ${text.length - headChars} chars of this tool result${
    isError ? ' (error)' : ''
  }; re-run the tool if needed]`;
}

/**
 * Rebuilds the conversation from the decisions. A dropped call disappears
 * together with its result; a dropped result keeps a bounded head and note.
 * Messages that lose all their content are removed; untouched messages are
 * returned as the same objects they came in as.
 */
export function applyDecisions(
  messages: readonly Message[],
  decisions: readonly CallDecision[],
  calls: readonly ToolCall[],
  headChars: number,
): Message[] {
  const byId = new Map(calls.map((call) => [call.id, call]));
  const actions = new Map<string, CallDecision['action']>();
  for (const decision of decisions) {
    const call = byId.get(decision.id);
    if (call && decision.action !== 'keep') actions.set(call.tool_use_id, decision.action);
  }
  const kept: Message[] = [];
  for (const message of messages) {
    const touched =
      message.toolUses.some((tool) => actions.has(tool.tool_use_id)) ||
      (message.toolResults ?? []).some((result) => actions.has(result.tool_use_id));
    if (!touched) {
      kept.push(message);
      continue;
    }
    // A `drop_call` keeps the call as a trace and only discards its output.
    // Erasing the call entirely would delete the one fact that makes the output
    // re-obtainable — the path or command — and, for a call-only assistant
    // message, would delete the whole message.
    //
    // Discarding is skipped when it would not actually shrink the transcript:
    // the trace note is ~72 chars, so a call whose output is shorter than that
    // grows the summary when dropped. Jev answers "is this still needed", not
    // "is this bigger than the note". `discarded` records what really went, so
    // the pairing result is filtered only when its call was really dropped.
    const discarded = new Set<string>();
    const toolUses = message.toolUses.map((tool) => {
      const action = actions.get(tool.tool_use_id);
      if (action === 'drop_call') {
        if (tool.removed) {
          discarded.add(tool.tool_use_id);
          return tool;
        }
        const outputChars = tool.text?.length ?? 0;
        if (keptCallChars(tool.input, outputChars) <= droppedCallChars(tool.input)) {
          return tool;
        }
        discarded.add(tool.tool_use_id);
        const copy: ToolUse = {
          tool_use_id: tool.tool_use_id,
          tool: tool.tool,
          input: tool.input,
          removed: true,
        };
        if (tool.isError) copy.isError = true;
        return copy;
      }
      if (action !== 'drop_result') return tool;
      const text = truncatedResultText(tool.text ?? '', tool.isError ?? false, headChars);
      if ((tool.text ?? '') === text) return tool;
      const copy: ToolUse = {
        tool_use_id: tool.tool_use_id,
        tool: tool.tool,
        input: tool.input,
        text,
      };
      if (tool.isError) copy.isError = true;
      return copy;
    });
    // The pairing entry is removed for a dropped call: the call is no longer a
    // compaction candidate, and the trace already stands in for it.
    const toolResults = (message.toolResults ?? [])
      .filter((result) => !discarded.has(result.tool_use_id))
      .map((result) => {
        if (actions.get(result.tool_use_id) !== 'drop_result') return result;
        const text = truncatedResultText(result.text, result.isError ?? false, headChars);
        return text === result.text
          ? result
          : {
              tool_use_id: result.tool_use_id,
              text,
              isError: result.isError,
            };
      });
    // Lengths must match explicitly. `[].every(...)` is vacuously true, so
    // relying on `every` alone would treat "every call was filtered out" as
    // "nothing changed" and push the original message back.
    if (
      toolUses.length === message.toolUses.length &&
      toolResults.length === (message.toolResults?.length ?? 0) &&
      toolUses.every((tool, index) => tool === message.toolUses[index]) &&
      toolResults.every((result, index) => result === message.toolResults?.[index])
    ) {
      kept.push(message);
      continue;
    }
    if (
      message.text.trim().length === 0 &&
      toolUses.length === 0 &&
      toolResults.length === 0
    ) {
      continue;
    }
    const rebuilt: Message = { role: message.role, text: message.text, toolUses };
    if (toolResults.length > 0) rebuilt.toolResults = toolResults;
    kept.push(rebuilt);
  }
  return kept;
}

/**
 * Turns model verdicts into the actions that will actually be applied.
 * Replacing a short result with a longer marker is not compaction, so those
 * verdicts become explicit keeps before applying or reporting them.
 */
function effectiveDecisions(
  messages: readonly Message[],
  decisions: readonly CallDecision[],
  calls: readonly ToolCall[],
  headChars: number,
): CallDecision[] {
  const uses = new Map(
    messages.flatMap((message) => message.toolUses.map((tool) => [tool.tool_use_id, tool] as const)),
  );
  const results = new Map(
    messages.flatMap((message) =>
      (message.toolResults ?? []).map((result) => [result.tool_use_id, result] as const),
    ),
  );
  const byId = new Map(calls.map((call) => [call.id, call]));
  return decisions.map((decision) => {
    if (decision.action === 'keep') return decision;
    const call = byId.get(decision.id);
    const tool = call ? uses.get(call.tool_use_id) : undefined;
    if (!call || !tool) return decision;
    const pairedResult = results.get(call.tool_use_id);
    const text = tool.text ?? pairedResult?.text ?? '';
    let changes: boolean;
    if (decision.action === 'drop_call') {
      changes = keptCallChars(tool.input, text.length) > droppedCallChars(tool.input);
    } else {
      const isError = tool.isError ?? pairedResult?.isError ?? false;
      changes = truncatedResultText(text, isError, headChars) !== text;
    }
    return changes ? decision : { ...decision, action: 'keep', reason: 'not_smaller' };
  });
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]!);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => worker()),
  );
  return results;
}

/**
 * Characters a message contributes to the serialized transcript.
 *
 * Kept for callers that need a per-message figure (the benchmarks do). It
 * delegates to the renderer, so it cannot disagree with what is emitted: the
 * previous hand-written version omitted the serializer's markers and separators
 * and measured a kept call's input with `JSON.stringify`, where the renderer
 * emits `key=value`. On a real session that overstated the reduction ratio by
 * ~4 points (80.9% reported against 76.9% actual), which is enough to flip a
 * decision near `JEV_COMPACT_MIN_REDUCTION`.
 */
export function messageChars(message: Message): number {
  return serializedChars([message]);
}

export function reductionRatio(result: Pick<CompactResult, 'stats'>): number {
  const { charsBefore, charsAfter } = result.stats;
  return charsBefore === 0 ? 0 : (charsBefore - charsAfter) / charsBefore;
}

function count(decisions: readonly CallDecision[], reason: CallDecision['reason']): number {
  return decisions.filter((decision) => decision.reason === reason).length;
}

/**
 * Compacts a transcript by asking Jev, for every tool call outside the pinned
 * first and newest messages, whether the call and whether its result must stay.
 *
 * The conversation is split into contiguous windows that each fit Jev's request
 * ceiling, and every call is judged inside the window that contains it. This is
 * the central design choice: Jev's limit bounds one request's state, not the
 * conversation, so a long session becomes several well-contextualised windows
 * rather than one shrunken history. Shrinking everything into a single budget
 * made the model judge calls it could no longer see — a 1600-call session
 * collapsed to a 747-token state, every trace gone.
 *
 * A window that still cannot be fitted falls back to `fitState`, and a call left
 * without an answer is kept (the safe direction). Throws only when Jev itself
 * fails; the caller decides whether to fall back to pi.
 */
export async function compact(
  messages: readonly Message[],
  asker: JevAsker,
  options: CompactOptions = {},
): Promise<CompactResult> {
  const started = Date.now();
  const resolved = resolveOptions(options);
  const askOptions: AskOptions = options.signal ? { signal: options.signal } : {};
  const calls = collectToolCalls(messages, resolved.preserveRecentMessages);
  const candidates = calls.filter((call) => !call.pinned);
  const charsBefore = serializedChars(messages);

  const answers = new Map<string, CallAnswer>();
  let requests = 0;
  let stateTokens = 0;
  let stateStage = '';
  let chunkCount = 0;

  if (candidates.length > 0) {
    let chunks: StateChunk[];
    try {
      chunks = chunkState(messages, calls, resolved);
    } catch (err) {
      // `chunkState` only throws when a single entry cannot be shrunk into a
      // whole window. `fitState` has coarser stages (it can drop messages
      // entirely and merge call runs), so it gets one attempt before giving up.
      // If it also fails, the chunker's error is the more precise one — it names
      // the offending message — so that is what propagates.
      let fallback: FittedState;
      try {
        fallback = fitState(messages, calls, resolved);
      } catch {
        throw err;
      }
      chunks = [
        {
          state: fallback.state,
          tokens: fallback.tokens,
          stage: fallback.stage,
          calls: candidates,
        },
      ];
    }
    chunkCount = chunks.length;
    stateTokens = chunks.reduce((max, chunk) => Math.max(max, chunk.tokens), 0);
    stateStage = worstStage(chunks.map((chunk) => chunk.stage));

    const jobs = chunks.flatMap((chunk) =>
      batchCalls(chunk.calls, chunk.tokens, resolved).map((batch) => ({
        state: chunk.state,
        batch,
      })),
    );
    requests = jobs.length;
    const answered = await mapWithConcurrency(
      jobs,
      resolved.maxConcurrentRequests,
      (job) => askBatch(asker, job.state, job.batch, askOptions),
    );
    for (const map of answered) {
      for (const [id, answer] of map) answers.set(id, answer);
    }
  }

  const decisions = effectiveDecisions(
    messages,
    calls.map((call) =>
      decideCall(call, answers.get(call.id) ?? { keepCall: 1, keepResult: 1 }, resolved),
    ),
    calls,
    resolved.truncateHeadChars,
  );
  const kept = applyDecisions(messages, decisions, calls, resolved.truncateHeadChars);
  return {
    messages: kept,
    decisions,
    stats: {
      messagesBefore: messages.length,
      messagesAfter: kept.length,
      charsBefore,
      charsAfter: serializedChars(kept),
      calls: calls.length,
      kept: decisions.filter(
        (decision) => decision.action === 'keep' && decision.reason !== 'pinned',
      ).length,
      resultsDropped: count(decisions, 'result_dropped'),
      callsDropped: count(decisions, 'call_dropped'),
      pinned: count(decisions, 'pinned'),
      stateTokens,
      stateStage,
      chunks: chunkCount,
      requests,
      ms: Date.now() - started,
    },
  };
}
