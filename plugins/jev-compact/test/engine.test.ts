/**
 * Correctness tests for the vendored Jev decision engine.
 *
 * These pin the guarantees the whole plugin rests on:
 *   - text is never rewritten, only tool calls/results are removed or clipped
 *   - a dropped call takes its result with it; no result outlives its call
 *   - the pinned head and tail are never touched
 *   - the three-way decision (keep / drop result / drop call) is thresholded
 *   - failures throw so the caller can fall back instead of losing the turn
 */

import { describe, expect, test } from 'bun:test';

import {
  batchCalls,
  compact,
  decideCall,
  messageChars,
  questionsFor,
  reductionRatio,
  resolveOptions,
  truncatedResultText,
} from '../src/jev/compact.ts';
import { collectToolCalls, chunkState, estimateTokens, fitState, isPinned } from '../src/jev/state.ts';
import { normalizeDiscardedNotes, serializeEngineMessages } from '../src/pi-adapter.ts';
import type { JevAnswer, JevAsker, Message } from '../src/jev/types.ts';
import { fakeJev } from './fake-jev.ts';

/**
 * assistant(call i) with its paired result, for i = 1..n.
 *
 * Both `toolUses[].text` and `toolResults` are set: the engine pairs on
 * `toolResults` and renders from `toolUses[].text`, so a transcript missing
 * either silently disables compaction. `pi-adapter.test.ts` guards the real
 * conversion path.
 *
 * The output is deliberately longer than the ~72-char note a discarded call
 * leaves behind. A shorter one would not be worth discarding at all, and the
 * fixture would then test a path real sessions never take — measured tool
 * output in a real session averages ~800 chars.
 */
function transcript(n: number): Message[] {
  const messages: Message[] = [{ role: 'user', text: 'do the thing', toolUses: [] }];
  for (let i = 1; i <= n; i += 1) {
    const output = `contents of file ${i}\n${'line of output\n'.repeat(20)}`;
    messages.push({
      role: 'assistant',
      text: '',
      toolUses: [
        {
          tool_use_id: `id${i}`,
          tool: 'read',
          input: { path: `src/f${i}.ts` },
          text: output,
        },
      ],
      toolResults: [{ tool_use_id: `id${i}`, text: output }],
    });
  }
  return messages;
}

describe('decideCall thresholds', () => {
  const call = { id: 't1', tool: 'read', pinned: false };
  const opts = { keepThreshold: 0.5 };

  test('keepResult at or above threshold keeps everything', () => {
    expect(decideCall(call, { keepCall: 0.1, keepResult: 0.5 }, opts).action).toBe('keep');
    expect(decideCall(call, { keepCall: 0.9, keepResult: 1 }, opts).action).toBe('keep');
  });

  test('keepResult below but keepCall above drops only the result', () => {
    const d = decideCall(call, { keepCall: 0.5, keepResult: 0.4 }, opts);
    expect(d.action).toBe('drop_result');
    expect(d.reason).toBe('result_dropped');
  });

  test('both below threshold drops the call', () => {
    expect(decideCall(call, { keepCall: 0.49, keepResult: 0 }, opts).action).toBe('drop_call');
  });

  test('a pinned call is kept regardless of the answers', () => {
    const d = decideCall({ ...call, pinned: true }, { keepCall: 0, keepResult: 0 }, opts);
    expect(d.action).toBe('keep');
    expect(d.reason).toBe('pinned');
  });
});

describe('text is never rewritten', () => {
  test('user and assistant text survives verbatim when every call is dropped', async () => {
    const messages: Message[] = [
      { role: 'user', text: 'CONSTRAINT: never edit src/generated', toolUses: [] },
      {
        role: 'assistant',
        text: 'The bug is exp < now, should be exp <= now.',
        toolUses: [
          { tool_use_id: 'a', tool: 'read', input: { path: 'src/a.ts' }, text: 'file a' },
        ],
        toolResults: [{ tool_use_id: 'a', text: 'file a' }],
      },
      {
        role: 'assistant',
        text: 'DECISION: sliding window with 30s skew.',
        toolUses: [
          { tool_use_id: 'b', tool: 'bash', input: { command: 'ls' }, text: 'lots of output' },
        ],
        toolResults: [{ tool_use_id: 'b', text: 'lots of output' }],
      },
      { role: 'assistant', text: 'SUMMARY: 12 passed, 0 failed.', toolUses: [] },
    ];
    const jev = fakeJev({}, { defaultAnswer: 0 });
    const result = await compact(messages, jev, { preserveRecentMessages: 0 });

    const text = result.messages.map((m) => m.text).join('\n');
    expect(text).toContain('CONSTRAINT: never edit src/generated');
    expect(text).toContain('The bug is exp < now, should be exp <= now.');
    expect(text).toContain('DECISION: sliding window with 30s skew.');
    expect(text).toContain('SUMMARY: 12 passed, 0 failed.');
  });

  test('no text is added that was not in the input', async () => {
    const messages: Message[] = [
      { role: 'user', text: 'only this', toolUses: [] },
      {
        role: 'assistant',
        text: '',
        toolUses: [
          { tool_use_id: 'a', tool: 'read', input: { path: 'x' }, text: 'r'.repeat(2000) },
        ],
        toolResults: [{ tool_use_id: 'a', text: 'r'.repeat(2000) }],
      },
    ];
    const jev = fakeJev({}, { defaultAnswer: 0 });
    const result = await compact(messages, jev, { preserveRecentMessages: 0 });
    for (const m of result.messages) {
      expect(['only this', '']).toContain(m.text);
    }
  });
});

describe('a dropped call leaves a trace, not a hole', () => {
  test('the call survives as a trace with its input intact', async () => {
    const messages = transcript(5);
    const jev = fakeJev({}, { defaultAnswer: 0 });
    const result = await compact(messages, jev, { preserveRecentMessages: 0 });

    const uses = result.messages.flatMap((m) => m.toolUses);
    expect(uses.length).toBe(5);
    for (const use of uses) {
      expect(use.removed).toBe(true);
      // The input is the whole point of keeping the trace: it names the file
      // or command, so "re-run the tool" is actionable.
      expect(use.input).toEqual({ path: expect.stringContaining('src/f') as unknown as string });
      expect(use.text).toBeUndefined();
    }
  });

  test('an emptied message is rebuilt, not silently returned unchanged', async () => {
    // `[].every(...)` is vacuously true, so a "nothing changed" short-circuit
    // based on `every` alone treats "every call was removed" as "leave it as
    // is" and returns the original with its output intact. This pins the fix.
    const messages = transcript(3);
    const jev = fakeJev({}, { defaultAnswer: 0 });
    const result = await compact(messages, jev, { preserveRecentMessages: 0 });
    const asst = result.messages.filter((m) => m.role === 'assistant');
    expect(asst.length).toBe(3);
    for (const m of asst) {
      // The evidence lives on the ToolUse, not in the message text.
      expect(m.text).toBe('');
      expect(m.toolUses.every((u) => u.removed)).toBe(true);
    }
    expect(result.stats.charsAfter).toBeLessThan(result.stats.charsBefore);
  });

  test('a call-only message is not erased', async () => {
    // 34% of the assistant messages in a real session carry no text, only
    // calls. Erasing a dropped call there would erase the message.
    const messages = transcript(3);
    const jev = fakeJev({}, { defaultAnswer: 0 });
    const result = await compact(messages, jev, { preserveRecentMessages: 0 });
    expect(result.messages.filter((m) => m.role === 'assistant').length).toBe(3);
  });

  test('no result outlives its call, and the trace is labelled in the output', async () => {
    const messages = transcript(4);
    const jev = fakeJev({ call_t1: 0, result_t1: 0 });
    const result = await compact(messages, jev, { preserveRecentMessages: 0 });
    const useIds = new Set(result.messages.flatMap((m) => m.toolUses.map((u) => u.tool_use_id)));
    const resultIds = new Set(
      result.messages.flatMap((m) => (m.toolResults ?? []).map((r) => r.tool_use_id)),
    );
    // Every surviving result still belongs to a surviving call.
    for (const id of resultIds) expect(useIds.has(id)).toBe(true);
    // The dropped call (t1) leaves no pairing entry, only a trace.
    expect(resultIds.size).toBe(3);

    const text = serializeEngineMessages(result.messages);
    // The discard is marked on the call's own line, not in a second
    // `[Tool result]:` part: that line is what signals an output is available.
    const callLines = text.split('\n').filter((l) => l.startsWith('[Assistant tool calls]:'));
    const marked = callLines.filter((l) => l.includes('output discarded'));
    expect(marked.length).toBe(1);
    expect(marked[0]).toContain('f1');
    // A discarded call emits no result part at all, so the result count is one
    // lower than the call count.
    expect(text.split('\n').filter((l) => l.startsWith('[Tool result]:')).length).toBe(3);
    // The path is still readable, and no stale result body remains.
    expect(text).toContain('src/f1.ts');
    expect(text).not.toContain('contents of file 1');
    // The kept calls still carry their output.
    expect(text).toContain('contents of file 2');
  });
});

describe('a discarded call is marked on its own line', () => {
  // The note used to be a second `[Tool result]: (output discarded …)` part, so
  // a discarded call cost two lines and the note was its own category that later
  // compactions inherited at full size (330 notes were 11% of a real summary,
  // 259 of them inherited). It is now a marker on the call's own line.

  function twoCalls(): Message[] {
    const long = 'x'.repeat(400);
    return [
      { role: 'user', text: 'go', toolUses: [] },
      {
        role: 'assistant',
        text: '',
        toolUses: [{ tool_use_id: 'a', tool: 'read', input: { path: 'src/a.ts' }, text: long }],
        toolResults: [{ tool_use_id: 'a', text: long }],
      },
      {
        role: 'assistant',
        text: '',
        toolUses: [{ tool_use_id: 'b', tool: 'bash', input: { command: 'ls' }, text: long }],
        toolResults: [{ tool_use_id: 'b', text: long }],
      },
    ];
  }

  test('a discarded call emits one line, and no result part', () => {
    const messages = twoCalls();
    for (const m of messages) for (const u of m.toolUses) u.removed = true;
    const text = serializeEngineMessages(messages);
    const lines = text.split('\n');
    const calls = lines.filter((l) => l.startsWith('[Assistant tool calls]:'));
    const results = lines.filter((l) => l.startsWith('[Tool result]:'));
    expect(calls.length).toBe(2);
    // No `[Tool result]:` part at all: its absence is the signal the output is
    // gone. A note there would look like an output that happens to be short.
    expect(results.length).toBe(0);
    for (const line of calls) expect(line).toContain('output discarded');
  });

  test('a discarded call never occupies a second part', () => {
    // The size win is structural: the marker rides on a line that has to exist.
    const dropped = twoCalls();
    for (const m of dropped) for (const u of m.toolUses) u.removed = true;
    const kept = twoCalls();
    const droppedParts = serializeEngineMessages(dropped).split('\n\n').length;
    const keptParts = serializeEngineMessages(kept).split('\n\n').length;
    // Kept: preamble + 2 calls + 2 results = 5 parts. Dropped: preamble + 2 calls.
    expect(keptParts).toBe(5);
    expect(droppedParts).toBe(3);
  });

  test('a kept call still emits its result part', () => {
    // The absence of `[Tool result]:` must mean "discarded", so a kept call
    // must always emit it. Otherwise the two states would be indistinguishable.
    const messages = twoCalls();
    const text = serializeEngineMessages(messages);
    expect(text.split('\n').filter((l) => l.startsWith('[Tool result]:')).length).toBe(2);
    expect(text).not.toContain('output discarded');
  });

  test('the marker names no tool, because the call line already does', () => {
    // Repeating the tool name cost ~30 chars per call with zero information: the
    // marker is the same string for every tool, so it is one category, not four.
    const messages = twoCalls();
    for (const m of messages) for (const u of m.toolUses) u.removed = true;
    const marked = serializeEngineMessages(messages)
      .split('\n')
      .filter((l) => l.includes('output discarded'));
    expect(new Set(marked.map((l) => l.replace(/^.*output discarded/, 'output discarded'))).size).toBe(1);
  });
});

describe('discard notes inherited from earlier versions are folded in', () => {
  // The old renderer's note is text, so Jev never deleted it and each later
  // compaction copied it forward: a real summary carried 328 (24 KB, 11%), 259
  // of them inherited. `previousSummary` is copied verbatim, so the only place
  // to repair them is when folding it back in.
  const LEGACY = (tool: string) =>
    `[Tool result]: (output discarded by compaction; re-run \`${tool}\` if needed)`;

  test('a legacy note merges into its own call line', () => {
    const prior = [
      '[Assistant tool calls]: bash(command="ls")',
      LEGACY('bash'),
      '[Assistant]: still working',
    ].join('\n\n');
    const out = normalizeDiscardedNotes(prior);
    expect(out).toContain('[Assistant tool calls]: bash(command="ls") [output discarded; re-run to restore]');
    // The standalone note part is gone.
    expect(out).not.toContain(LEGACY('bash'));
    // Surrounding content is untouched.
    expect(out).toContain('[Assistant]: still working');
  });

  test('a note whose tool disagrees with the preceding call is left alone', () => {
    // Merging it would attribute the discard to the wrong call.
    const prior = ['[Assistant tool calls]: bash(command="ls")', LEGACY('read')].join('\n\n');
    const out = normalizeDiscardedNotes(prior);
    expect(out).toContain(LEGACY('read'));
    expect(out).not.toContain('output discarded; re-run to restore');
  });

  test('a note with no call line before it is left alone', () => {
    const prior = ['[Assistant]: I ran something', LEGACY('bash')].join('\n\n');
    expect(normalizeDiscardedNotes(prior)).toBe(prior);
  });

  test('quoted text that merely contains the phrase is not rewritten', () => {
    // A kept result can contain anything, including the note's wording. Only a
    // part *equal* to the note, following its own call, is a real note.
    const prior = [
      '[Assistant tool calls]: read(path="a.ts")',
      `[Tool result]: the log said ${LEGACY('read')} and then stopped`,
    ].join('\n\n');
    expect(normalizeDiscardedNotes(prior)).toBe(prior);
  });

  test('normalizing is idempotent and never rewrites a marker twice', () => {
    const once = normalizeDiscardedNotes(
      ['[Assistant tool calls]: edit(path="a.ts")', LEGACY('edit')].join('\n\n'),
    );
    expect(normalizeDiscardedNotes(once)).toBe(once);
    expect(once.split('output discarded').length - 1).toBe(1);
  });

  test('a summary without legacy notes is returned unchanged', () => {
    const prior = '[Assistant]: nothing to do';
    expect(normalizeDiscardedNotes(prior)).toBe(prior);
  });

  test('a call line pushed to a new part by a trailing newline still merges', () => {
    // A kept result whose text ends in `\n` makes a `\n\n\n` run, so
    // `split('\n\n')` yields a part starting with `\n`. The real summary had
    // exactly two such cases, which a start-anchored match silently missed.
    const prior = [
      '[Tool result]: 92 pass\n',
      '[Assistant tool calls]: bash(command="ls")',
      LEGACY('bash'),
      '[Assistant]: done',
    ].join('\n\n');
    const out = normalizeDiscardedNotes(prior);
    expect(out).not.toContain(LEGACY('bash'));
    expect(out).toContain('bash(command="ls") [output discarded; re-run to restore]');
    // The kept result's trailing newline survives byte-for-byte.
    expect(out).toContain('[Tool result]: 92 pass\n');
    expect(out).toContain('[Assistant]: done');
  });
});

describe('dropping is skipped when it would grow the transcript', () => {
  // A `drop_call` replaces the output with a ~72-char note. When the output is
  // shorter than that, discarding makes the summary *bigger* — measured at +47
  // chars for a 10-char output. Jev answers "is this still needed", not "is
  // this bigger than the note", so the decision cannot come from Jev.
  function shortOutput(prefix: string, length: number): Message[] {
    const output = `${prefix}${'z'.repeat(Math.max(0, length - prefix.length))}`;
    return [
      { role: 'user', text: 'go', toolUses: [] },
      {
        role: 'assistant',
        text: '',
        toolUses: [{ tool_use_id: 'a', tool: 'read', input: { path: 'src/a.ts' }, text: output }],
        toolResults: [{ tool_use_id: 'a', text: output }],
      },
    ];
  }

  // regression: jev_effective_drop_call_decision
  test('a very short output is kept rather than replaced by a longer note', async () => {
    const messages = shortOutput('ok', 10);
    const result = await compact(messages, fakeJev({}, { defaultAnswer: 0 }), {
      preserveRecentMessages: 0,
    });
    const use = result.messages.flatMap((m) => m.toolUses)[0];
    // The call was told to drop, but the output is smaller than the note.
    expect(use!.removed).toBeUndefined();
    expect(use!.text).toBe('okzzzzzzzz');
    // The paired result must survive with it, or the call loses its output.
    expect(result.messages.flatMap((m) => m.toolResults ?? []).length).toBe(1);
    expect(result.stats.charsAfter).toBeLessThanOrEqual(result.stats.charsBefore);
    expect(result.decisions[0]?.action).toBe('keep');
    expect(result.decisions[0]?.reason).toBe('not_smaller');
    expect(result.stats.callsDropped).toBe(0);
    expect(result.stats.kept).toBe(1);
  });

  test('an output larger than the note is discarded as asked', async () => {
    const messages = shortOutput('', 400);
    const result = await compact(messages, fakeJev({}, { defaultAnswer: 0 }), {
      preserveRecentMessages: 0,
    });
    const use = result.messages.flatMap((m) => m.toolUses)[0];
    expect(use!.removed).toBe(true);
    expect(result.messages.flatMap((m) => m.toolResults ?? []).length).toBe(0);
    expect(result.stats.charsAfter).toBeLessThan(result.stats.charsBefore);
  });

  test('no decision can grow the transcript', async () => {
    // The invariant, across both verdicts and every output length: the pruned
    // transcript is never larger than the input it came from.
    for (const length of [1, 10, 50, 71, 72, 73, 200, 5000]) {
      for (const answer of [0, 1]) {
        const messages = shortOutput('', length);
        const result = await compact(messages, fakeJev({}, { defaultAnswer: answer }), {
          preserveRecentMessages: 0,
        });
        expect(result.stats.charsAfter).toBeLessThanOrEqual(result.stats.charsBefore);
      }
    }
  });
});

describe('drop_result keeps a bounded head and a note', () => {
  test('a long result is truncated to the head plus an explanatory note', async () => {
    const long = 'x'.repeat(5000);
    const messages: Message[] = [
      { role: 'user', text: 'go', toolUses: [] },
      {
        role: 'assistant',
        text: 'kept text',
        toolUses: [{ tool_use_id: 'a', tool: 'read', input: { path: 'x' }, text: long }],
        toolResults: [{ tool_use_id: 'a', text: long }],
      },
    ];
    const jev = fakeJev({ call_t1: 1, result_t1: 0 });
    const result = await compact(messages, jev, {
      preserveRecentMessages: 0,
      truncateHeadChars: 300,
    });

    const use = result.messages.flatMap((m) => m.toolUses)[0];
    expect(use).toBeDefined();
    expect(use!.text!.length).toBeLessThan(800);
    expect(use!.text!.startsWith('x'.repeat(300))).toBe(true);
    expect(use!.text!).toContain('re-run the tool if needed');
    expect(result.stats.resultsDropped).toBe(1);
    expect(result.stats.callsDropped).toBe(0);
    expect(result.messages.some((m) => m.text === 'kept text')).toBe(true);
  });

  test('the paired toolResult is truncated in step with the ToolUse', async () => {
    const long = 'y'.repeat(4000);
    const messages: Message[] = [
      { role: 'user', text: 'go', toolUses: [] },
      {
        role: 'assistant',
        text: '',
        toolUses: [{ tool_use_id: 'a', tool: 'read', input: {}, text: long }],
        toolResults: [{ tool_use_id: 'a', text: long }],
      },
    ];
    const jev = fakeJev({ call_t1: 1, result_t1: 0 });
    const result = await compact(messages, jev, {
      preserveRecentMessages: 0,
      truncateHeadChars: 100,
    });
    const paired = result.messages.flatMap((m) => m.toolResults ?? [])[0];
    expect(paired).toBeDefined();
    expect(paired!.text.length).toBeLessThan(300);
  });

  test('a short result is left alone even when dropped', () => {
    expect(truncatedResultText('short', false, 300)).toBe('short');
    expect(truncatedResultText('x'.repeat(419), false, 300)).toBe('x'.repeat(419));
    expect(truncatedResultText('x'.repeat(421), false, 300)).toContain('truncated');
  });

  // regression: jev_effective_drop_result_decision
  test('a short result is reported as unchanged rather than truncated', async () => {
    const messages: Message[] = [
      { role: 'user', text: 'go', toolUses: [] },
      {
        role: 'assistant',
        text: '',
        toolUses: [{ tool_use_id: 'a', tool: 'read', input: {}, text: 'short' }],
        toolResults: [{ tool_use_id: 'a', text: 'short' }],
      },
    ];
    const result = await compact(messages, fakeJev({ call_t1: 1, result_t1: 0 }), {
      preserveRecentMessages: 0,
    });
    expect(result.decisions[0]?.action).toBe('keep');
    expect(result.decisions[0]?.reason).toBe('not_smaller');
    expect(result.stats.resultsDropped).toBe(0);
    expect(result.stats.kept).toBe(1);
  });
});

describe('pinning', () => {
  test('the first message and the newest N are pinned', () => {
    expect(isPinned(0, 10, 3)).toBe(true);
    expect(isPinned(1, 10, 3)).toBe(false);
    expect(isPinned(7, 10, 3)).toBe(true);
    expect(isPinned(6, 10, 3)).toBe(false);
  });

  test('a pinned call is never asked about and always survives', async () => {
    const messages = transcript(4);
    const jev = fakeJev({}, { defaultAnswer: 0 });
    const result = await compact(messages, jev, { preserveRecentMessages: 2 });

    const asked = new Set(
      jev.calls.flatMap((c) =>
        Object.keys(c.questions).map((q) => q.replace(/^(call|result)_/, '')),
      ),
    );
    const pinnedCalls = collectToolCalls(messages, 2).filter((c) => c.pinned);
    expect(pinnedCalls.length).toBeGreaterThan(0);
    for (const call of pinnedCalls) expect(asked.has(call.id)).toBe(false);

    const surviving = new Set(
      result.messages.flatMap((m) => m.toolUses.map((u) => u.tool_use_id)),
    );
    for (const call of pinnedCalls) expect(surviving.has(call.tool_use_id)).toBe(true);
  });
});

describe('state fitting and batching', () => {
  test('a small history fits in the "full" stage', () => {
    const messages = transcript(2);
    const calls = collectToolCalls(messages, 0);
    const fitted = fitState(messages, calls, {
      maxStateTokens: 25_000,
      preserveRecentMessages: 0,
      goal: 'test',
    });
    expect(fitted.stage).toBe('full');
    expect(fitted.tokens).toBeGreaterThan(0);
    expect(fitted.state.goal).toBe('test');
  });

  test('an oversized history shrinks in stages rather than throwing', () => {
    const messages = transcript(50);
    const calls = collectToolCalls(messages, 0);
    const fitted = fitState(messages, calls, {
      maxStateTokens: 1500,
      preserveRecentMessages: 0,
      goal: 'g',
    });
    expect(fitted.tokens).toBeLessThanOrEqual(1500);
    expect(fitted.stage).not.toBe('full');
  });

  test('a history with more calls than the budget can fit still fits', () => {
    // Every earlier stage shrinks *within* an entry, so enough tool calls hit a
    // floor no per-entry truncation goes below: measured at ~69 tokens per call,
    // which 800 calls push past even a 12k budget. Before the final stage this
    // threw, and a throw loses the whole compaction because the caller falls
    // back. A real 387-call session hit the same floor against the 25k default.
    const messages = transcript(800);
    const calls = collectToolCalls(messages, 0);
    const fitted = fitState(messages, calls, {
      maxStateTokens: 12_000,
      preserveRecentMessages: 0,
      goal: 'g',
    });
    expect(fitted.tokens).toBeLessThanOrEqual(12_000);
    expect(fitted.stage).toBe('old traces dropped');
  });

  test('dropping traces keeps every text entry', () => {
    // The coarse stage must not become a second way to lose conversation text.
    const messages: Message[] = [
      { role: 'user', text: 'CONSTRAINT: never edit src/generated', toolUses: [] },
      ...transcript(800).slice(1),
    ];
    const calls = collectToolCalls(messages, 0);
    const fitted = fitState(messages, calls, {
      maxStateTokens: 12_000,
      preserveRecentMessages: 0,
      goal: 'g',
    });
    expect(fitted.stage).toBe('old traces dropped');
    const text = fitted.state.history.map((e) => e.text).join('\n');
    expect(text).toContain('CONSTRAINT: never edit src/generated');
  });

  test('a limit below the most aggressive stage throws instead of exceeding it', () => {
    // `old calls merged` is the last shrink stage; below its floor there is
    // nothing left to try, so the engine throws and the caller falls back. This
    // is the behaviour the plugin relies on for its fallback path.
    const messages = transcript(50);
    const calls = collectToolCalls(messages, 0);
    expect(() =>
      fitState(messages, calls, {
        maxStateTokens: 100,
        preserveRecentMessages: 0,
        goal: 'g',
      }),
    ).toThrow(/history too large for Jev/);
  });

  test('questions carry both the call and the result name', () => {
    const calls = collectToolCalls(transcript(1), 0);
    const q = questionsFor(calls[0]!);
    expect(Object.keys(q).sort()).toEqual(['call_t1', 'result_t1']);
  });

  test('batching splits when the question budget runs out', () => {
    const calls = collectToolCalls(transcript(20), 0);
    const stateTokens = 100;
    const oneBatch = batchCalls(calls, stateTokens, { maxRequestTokens: 1_000_000 });
    expect(oneBatch.length).toBe(1);

    const manyBatches = batchCalls(calls, stateTokens, { maxRequestTokens: 400 });
    expect(manyBatches.length).toBeGreaterThan(1);
    const ids = manyBatches.flat().map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBe(calls.length);
  });

  test('a state that leaves no room for questions throws', () => {
    const calls = collectToolCalls(transcript(2), 0);
    expect(() => batchCalls(calls, 100, { maxRequestTokens: 150 })).toThrow(/no room/);
  });

  test('tokens are estimated without a tokenizer', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('1234')).toBe(2);
    expect(estimateTokens('abcdef')).toBe(1);
    expect(estimateTokens('abcdefg')).toBe(2);
  });

  test('CJK text is not underestimated', () => {
    // The ceiling is enforced against this estimator, so underestimating is the
    // dangerous direction: a window believed to be 28k could exceed Jev's 32k
    // limit and be rejected. Chinese was charged 0.9/char against a measured
    // ~1.18, a 17% shortfall.
    const cjk = '这是一个用于测试分词器行为的中文段落';
    const latin = 'abcdefghijklmnopqr'; // same length, all latin letters
    expect(cjk.length).toBe(latin.length);
    expect(estimateTokens(cjk)).toBeGreaterThan(estimateTokens(latin));
    // ~1.2 per character, not 0.9.
    expect(estimateTokens(cjk)).toBeGreaterThanOrEqual(Math.ceil(cjk.length * 1.1));
  });
});

describe('failures surface to the caller', () => {
  test('a Jev error rejects so pi can fall back', async () => {
    const jev = fakeJev({}, { defaultAnswer: 0, failOnRequest: 1 });
    await expect(compact(transcript(2), jev, { preserveRecentMessages: 0 })).rejects.toThrow(
      /Jev request failed/,
    );
  });

  test('a response missing an answer rejects', async () => {
    const bad = {
      async ask() {
        return { answers: {} };
      },
    };
    await expect(compact(transcript(2), bad, { preserveRecentMessages: 0 })).rejects.toThrow(
      /Invalid Jev answer/,
    );
  });
});

describe('size accounting matches what is rendered', () => {
  test('a removed call is measured as its clipped trace, not its raw input', () => {
    // `messageChars` must mirror the serializer, or the reduction ratio is
    // measured against a number the output never had. A removed `write` keeps a
    // 20 KB `content` in its input but renders ~200 chars; counting the input
    // overstated a real session's ratio by 3.5x.
    const body = 'x'.repeat(20_000);
    const message: Message = {
      role: 'assistant',
      text: '',
      toolUses: [
        { tool_use_id: 'w', tool: 'write', input: { content: body, path: 'a.ts' }, removed: true },
      ],
    };
    const counted = messageChars(message);
    const rendered = serializeEngineMessages([message]).length;
    // The trace plus the serializer's markers, not the 20 KB input.
    expect(counted).toBeLessThan(700);
    expect(counted).toBeGreaterThan(100);
    // The gap is only the `[Assistant tool calls]: ` marker, which
    // `messageChars` does not model; the discard marker is part of the line and
    // is counted. It is a fixed cost, not a size.
    expect(rendered - counted).toBeLessThan(40);
    // And it must be nowhere near the raw input.
    expect(counted).toBeLessThan(body.length / 20);
  });

  test('size accounting is exactly the serialized length, for any message', () => {
    // The regression this pins: the accounting used to be *mirrored* by hand —
    // it omitted the serializer's markers and separators and measured a kept
    // call's input with `JSON.stringify`, where the renderer emits `key=value`.
    // On a real session that reported 80.9% reduction against 76.9% actual,
    // which is enough to flip a decision near `JEV_COMPACT_MIN_REDUCTION`.
    // It now calls the renderer, so equality is the contract.
    const messages: Message[] = [
      {
        role: 'assistant',
        text: 'note',
        toolUses: [{ tool_use_id: 'k', tool: 'read', input: { path: 'src/a.ts' }, text: 'body' }],
        toolResults: [{ tool_use_id: 'k', text: 'body' }],
      },
      {
        role: 'assistant',
        text: '',
        toolUses: [
          { tool_use_id: 'd', tool: 'write', input: { path: 'b.ts', content: 'x'.repeat(900) }, removed: true },
        ],
      },
      { role: 'user', text: 'a question', toolUses: [] },
      // A message with no text and no calls renders to nothing at all.
      { role: 'assistant', text: '', toolUses: [] },
    ];
    for (const message of messages) {
      expect(messageChars(message)).toBe(serializeEngineMessages([message]).length);
    }
    // The whole transcript is the sum plus the `\n\n` separators *between
    // messages that render to something*. Each message's own figure already
    // carries its internal separators, so only the inter-message joins differ:
    // three of the four messages produce output, hence 2 × (3 - 1) = 4 chars.
    const counted = messages.reduce((sum, m) => sum + messageChars(m), 0);
    const rendered = serializeEngineMessages(messages).length;
    expect(counted).toBeLessThanOrEqual(rendered);
    expect(rendered - counted).toBe(2 * 2);
  });

  test('a fully dropped transcript reports a positive reduction', () => {
    // The regression the flat-estimate version caused: charsAfter exceeded
    // charsBefore, so the ratio went negative and the plugin fell back.
    const messages = transcript(8);
    return compact(messages, fakeJev({}, { defaultAnswer: 0 }), {
      preserveRecentMessages: 0,
    }).then((result) => {
      expect(result.stats.charsAfter).toBeLessThan(result.stats.charsBefore);
      expect(reductionRatio(result)).toBeGreaterThan(0);
    });
  });
});

describe('bookkeeping', () => {
  test('reductionRatio reports the character reduction', () => {
    expect(reductionRatio({ stats: { charsBefore: 0, charsAfter: 0 } as never })).toBe(0);
    expect(reductionRatio({ stats: { charsBefore: 1000, charsAfter: 250 } as never })).toBeCloseTo(
      0.75,
      5,
    );
  });

  test('messageChars is the serialized length of that message', () => {
    const m: Message = {
      role: 'assistant',
      text: 'ab',
      toolUses: [{ tool_use_id: 'a', tool: 'read', input: { path: 'src/a.ts' }, text: 'xyz' }],
      toolResults: [{ tool_use_id: 'a', text: 'xyz' }],
    };
    // `[Assistant]: ab\n\n[Assistant tool calls]: read(path="src/a.ts")\n\n[Tool result]: xyz`
    expect(messageChars(m)).toBe(serializeEngineMessages([m]).length);
    expect(messageChars(m)).toBe(13 + 2 + 2 + 24 + 'read'.length + 'path="src/a.ts"'.length + 2 + 2 + 15 + 3);
  });

  test('resolveOptions applies defaults and floors', () => {
    const o = resolveOptions({
      keepThreshold: 4,
      preserveRecentMessages: -3,
      truncateHeadChars: 4.9,
      maxConcurrentRequests: 0,
    });
    expect(o.preserveRecentMessages).toBe(0);
    expect(o.truncateHeadChars).toBe(4);
    expect(o.keepThreshold).toBe(1);
    expect(o.maxConcurrentRequests).toBe(1);
    expect(o.maxStateTokens).toBe(28_000);
    // Jev's request budget is 64k (state + all questions), not 30k.
    expect(o.maxRequestTokens).toBe(64_000);
  });
});

describe('end to end shape', () => {
  test('the default answer keeps everything and removes nothing', async () => {
    const messages = transcript(6);
    const jev = fakeJev({}, { defaultAnswer: 1 });
    const result = await compact(messages, jev, { preserveRecentMessages: 0 });
    expect(result.stats.callsDropped).toBe(0);
    expect(result.stats.resultsDropped).toBe(0);
    // Nothing changed, so the output must serialize to exactly the input size.
    expect(result.stats.charsAfter).toBe(result.stats.charsBefore);
    expect(reductionRatio(result)).toBe(0);
  });

  test('a cancellation signal is handed to every request', async () => {
    // pi passes a signal per compaction. Dropping it let every window keep
    // issuing requests (each with a full state) after the user cancelled.
    const controller = new AbortController();
    const jev = fakeJev({}, { defaultAnswer: 1 });
    await compact(transcript(4), jev, {
      preserveRecentMessages: 0,
      signal: controller.signal,
    });
    expect(jev.calls.length).toBeGreaterThan(0);
    for (const call of jev.calls) expect(call.options?.signal).toBe(controller.signal);
  });
});

describe('long conversations are windowed, not shrunk', () => {
  /**
   * The regression this suite exists for: shrinking the *whole* conversation into
   * one budget made Jev judge calls it could no longer see. A 1600-call session
   * collapsed to a 747-token state with every trace dropped. Windowing keeps each
   * call beside its own context instead.
   */
  test('a history too big for one window is split into several', () => {
    const messages = transcript(400);
    const calls = collectToolCalls(messages, 0);
    const chunks = chunkState(messages, calls, {
      maxStateTokens: 12_000,
      preserveRecentMessages: 0,
      goal: 'g',
    });
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.tokens).toBeLessThanOrEqual(12_000);
    // Nothing is silently abandoned: every candidate is owned by exactly one window.
    const owned = chunks.flatMap((c) => c.calls.map((call) => call.id));
    expect(new Set(owned).size).toBe(owned.length);
    expect(owned.length).toBe(calls.filter((c) => !c.pinned).length);
  });

  test('every window keeps full detail instead of degrading to a trace dump', () => {
    // The old failure mode: past a certain call count every window was reduced to
    // `old traces dropped`. Windowing must keep the structured form (`full`), not
    // trade context for size.
    const messages = transcript(400);
    const calls = collectToolCalls(messages, 0);
    const chunks = chunkState(messages, calls, {
      maxStateTokens: 12_000,
      preserveRecentMessages: 0,
      goal: 'g',
    });
    for (const chunk of chunks) expect(chunk.stage).toBe('full');
    // And the state carries real calls, not just placeholder strings.
    const hasStructuredCall = chunks.some((chunk) =>
      chunk.state.history.some((entry) => Array.isArray(entry.tool_calls) && entry.tool_calls.length > 0),
    );
    expect(hasStructuredCall).toBe(true);
  });

  test('the standing first message reaches every window', () => {
    // The first entry holds the standing instruction. If it only reached window 1,
    // later decisions would be made without the constraint.
    const messages: Message[] = [
      { role: 'user', text: 'CONSTRAINT: never edit src/generated', toolUses: [] },
      ...transcript(400).slice(1),
    ];
    const calls = collectToolCalls(messages, 0);
    const chunks = chunkState(messages, calls, {
      maxStateTokens: 12_000,
      preserveRecentMessages: 0,
      goal: 'g',
    });
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.state.history[0]?.text).toContain('CONSTRAINT: never edit src/generated');
    }
  });

  test('an oversized first message does not give every entry its own window', () => {
    // Regression: `previousSummary` enters as the first message and can be
    // hundreds of KB of pure text. It is repeated as the preamble in every
    // window, so an uncapped one exceeded the whole budget and no second entry
    // could ever fit — the packer emitted **318 windows for 318 messages** at 14%
    // budget utilisation, i.e. one request per message.
    const summary = 'prior summary line\n'.repeat(40_000); // ~1.1MB, ~200k tokens
    const messages: Message[] = [
      { role: 'user', text: summary, toolUses: [] },
      ...transcript(300).slice(1),
    ];
    const calls = collectToolCalls(messages, 0);
    const budget = 12_000;
    const chunks = chunkState(messages, calls, {
      maxStateTokens: budget,
      preserveRecentMessages: 0,
      goal: 'g',
    });
    // Well under one-per-message, and each window actually uses its budget.
    expect(chunks.length).toBeLessThan(messages.length / 2);
    for (const chunk of chunks) {
      expect(chunk.tokens).toBeLessThanOrEqual(budget);
    }
    const busiest = Math.max(...chunks.map((c) => c.tokens));
    expect(busiest).toBeGreaterThan(budget * 0.5);
  });

  test('a huge preamble is abridged, keeping its head', () => {
    // The head of a prior summary usually names the task, which is the part worth
    // keeping when it has to be cut.
    const summary = 'TASK: refactor the auth module\n' + 'filler detail line\n'.repeat(40_000);
    const messages: Message[] = [
      { role: 'user', text: summary, toolUses: [] },
      ...transcript(50).slice(1),
    ];
    const calls = collectToolCalls(messages, 0);
    const chunks = chunkState(messages, calls, {
      maxStateTokens: 8_000,
      preserveRecentMessages: 0,
      goal: 'g',
    });
    for (const chunk of chunks) {
      expect(chunk.state.history[0]?.text).toContain('TASK: refactor the auth module');
    }
  });

  test('a run of medium messages does not overflow a window', () => {
    // Regression: the packer always swallowed its first body entry, even when the
    // preamble plus the full overlap had already spent the budget. The in-place
    // shrinker could not repair it, because that body entry fit the body budget
    // on its own — so `shrinkEntryToFit` was a no-op and the window threw. The
    // caller then fell back to the single-window `fitState`, silently restoring
    // the exact "whole history shrank, the model is blind" failure windowing
    // exists to remove.
    //
    // Five pasted files of ~6k tokens each plus a tool call: the sizes are ordinary
    // (a large document is common), and the default overlap of 3 is what pushed it
    // over. The old code threw `one message is larger than a Jev window`.
    const messages: Message[] = [{ role: 'user', text: 'refactor the parser', toolUses: [] }];
    for (let i = 0; i < 5; i += 1) {
      messages.push({
        role: 'user',
        text: `src/module${i}.ts\n${'export const value = compute();\n'.repeat(700)}`,
        toolUses: [],
      });
    }
    const output = 'read output\n'.repeat(40);
    messages.push({
      role: 'assistant',
      text: '',
      toolUses: [
        { tool_use_id: 'id0', tool: 'read', input: { path: 'src/module0.ts' }, text: output },
      ],
      toolResults: [{ tool_use_id: 'id0', text: output }],
    });

    const calls = collectToolCalls(messages, 0);
    const chunks = chunkState(messages, calls, {
      maxStateTokens: 28_000,
      preserveRecentMessages: 0,
      goal: 'g',
    });

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.tokens).toBeLessThanOrEqual(28_000);
    // The call must still be decided, in the window whose body holds it.
    const owned = chunks.flatMap((chunk) => chunk.calls.map((call) => call.id));
    expect(owned.length).toBe(calls.filter((call) => !call.pinned).length);
  });

  test('every call a window owns is present in that window\'s state', () => {
    // A window that decides a call it cannot see is the failure this whole
    // refactor removes, so it is asserted directly. Found by this test: the
    // overlap-dropping loop spliced at a fixed index and walked backwards into
    // the body, deleting entries that owned calls.
    const messages = transcript(400);
    const calls = collectToolCalls(messages, 0);
    const chunks = chunkState(messages, calls, {
      maxStateTokens: 12_000,
      preserveRecentMessages: 0,
      goal: 'g',
    });
    for (const chunk of chunks) {
      const present = new Set(chunk.state.history.map((entry) => entry.i));
      for (const call of chunk.calls) {
        expect(present.has(call.callIndex)).toBe(true);
      }
    }
  });

  test('a window carries context from the window before it', () => {
    // Without overlap the first call of each window is judged with no preceding
    // turn, which is exactly the context that explains it.
    const messages = transcript(400);
    const calls = collectToolCalls(messages, 0);
    const chunks = chunkState(messages, calls, {
      maxStateTokens: 12_000,
      preserveRecentMessages: 0,
      goal: 'g',
      overlapEntries: 3,
    });
    const second = chunks[1]!;
    const firstCallEntry = second.calls[0];
    expect(firstCallEntry).toBeDefined();
    // The window's first body entry is preceded by entries that belong to the
    // previous window's range, i.e. the overlap is present.
    const bodyIndex = second.state.history.findIndex((e) => e.i === firstCallEntry!.callIndex);
    expect(bodyIndex).toBeGreaterThan(1);
  });

  test('a small history stays a single window', () => {
    const messages = transcript(3);
    const calls = collectToolCalls(messages, 0);
    const chunks = chunkState(messages, calls, {
      maxStateTokens: 30_000,
      preserveRecentMessages: 0,
      goal: 'g',
    });
    expect(chunks.length).toBe(1);
    expect(chunks[0]!.stage).toBe('full');
  });

  test('compaction across windows decides every call and reports the count', async () => {
    const messages = transcript(400);
    const jev = fakeJev({}, { defaultAnswer: 0 });
    const result = await compact(messages, jev, {
      preserveRecentMessages: 0,
      maxStateTokens: 12_000,
      keepThreshold: 0.5,
    });
    expect(result.stats.chunks).toBeGreaterThan(1);
    // Every candidate got a decision; none was left unanswered.
    const decided = result.decisions.filter((d) => d.reason !== 'pinned');
    expect(decided.length).toBe(collectToolCalls(messages, 0).length);
    // And the answers came from windows, so more than one request was made.
    expect(result.stats.requests).toBeGreaterThan(1);
  });

  // regression: jev_request_concurrency_limit
  test('all windows and batches share one request concurrency limit', async () => {
    const messages = transcript(120);
    let active = 0;
    let peak = 0;
    let requests = 0;
    const asker: JevAsker = {
      async ask(_state: unknown, questions: Record<string, unknown>) {
        requests += 1;
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 2));
        active -= 1;
        const answers: Record<string, JevAnswer> = Object.fromEntries(
          Object.keys(questions).map((name) => [name, { type: 'noul', noul: 1 }]),
        );
        return {
          answers,
        };
      },
    };

    await compact(messages, asker, {
      preserveRecentMessages: 0,
      maxStateTokens: 1_000,
      maxRequestTokens: 1_500,
      maxConcurrentRequests: 2,
    });

    expect(requests).toBeGreaterThan(2);
    expect(peak).toBe(2);
  });
});
