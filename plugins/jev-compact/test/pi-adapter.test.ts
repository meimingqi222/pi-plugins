/**
 * Tests for the pi ↔ engine adapter.
 *
 * The bug this file exists to prevent: pi splits a tool call and its result
 * across two messages (`assistant` holds the `toolCall` block, a later
 * `toolResult` row holds the output). The engine pairs them through a message's
 * `toolResults` array and renders from `toolUses[].text`. An adapter that sets
 * only one of the two compiles, passes every engine test, and then silently
 * compacts nothing in real use.
 */

import { describe, expect, test } from 'bun:test';

import {
  serializeEngineMessages,
  toEngineMessages,
  type PiMessage,
} from '../src/pi-adapter.ts';
import { collectToolCalls } from '../src/jev/state.ts';

/** A pi-shaped transcript: user, assistant with a toolCall, then the toolResult row. */
function piTranscript(resultText: string): PiMessage[] {
  return [
    { role: 'user', content: 'read the file please' },
    {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'I should read it' },
        { type: 'text', text: 'Reading now.' },
        { type: 'toolCall', id: 'call_1', name: 'read', arguments: { path: 'src/a.ts' } },
      ],
    },
    {
      role: 'toolResult',
      toolCallId: 'call_1',
      toolName: 'read',
      content: [{ type: 'text', text: resultText }],
      isError: false,
    },
    { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] },
  ];
}

describe('toEngineMessages', () => {
  test('pairs a toolCall with its later toolResult row', () => {
    const engine = toEngineMessages(piTranscript('file contents here'));
    const calls = collectToolCalls(engine, 0);

    expect(calls.length).toBe(1);
    expect(calls[0]!.tool).toBe('read');
    expect(calls[0]!.input).toEqual({ path: 'src/a.ts' });
    expect(calls[0]!.resultChars).toBe('file contents here'.length);
  });

  test('the result is visible both to the pairing logic and to the renderer', () => {
    const engine = toEngineMessages(piTranscript('hello'));
    const assistant = engine.find((m) => m.toolUses.length > 0)!;

    // What `collectToolCalls` pairs on and `messageChars` measures.
    expect(assistant.toolResults).toBeDefined();
    expect(assistant.toolResults![0]!.text).toBe('hello');
    // What `serializeEngineMessages` renders after a drop_result.
    expect(assistant.toolUses[0]!.text).toBe('hello');
  });

  test('user and assistant text survive, thinking is not treated as text', () => {
    const engine = toEngineMessages(piTranscript('r'));
    expect(engine[0]!.text).toBe('read the file please');
    const assistant = engine.find((m) => m.toolUses.length > 0)!;
    expect(assistant.text).toBe('Reading now.');
    expect(assistant.text).not.toContain('I should read it');
  });

  test('a call with no result yet is not a candidate', () => {
    const messages: PiMessage[] = [
      { role: 'user', content: 'go' },
      {
        role: 'assistant',
        content: [{ type: 'toolCall', id: 'dangling', name: 'read', arguments: {} }],
      },
    ];
    const engine = toEngineMessages(messages);
    expect(collectToolCalls(engine, 0).length).toBe(0);
  });

  test('image results are noted rather than inlined', () => {
    const messages: PiMessage[] = [
      { role: 'user', content: 'go' },
      {
        role: 'assistant',
        content: [{ type: 'toolCall', id: 'c', name: 'screenshot', arguments: {} }],
      },
      {
        role: 'toolResult',
        toolCallId: 'c',
        content: [
          { type: 'text', text: 'captured' },
          { type: 'image', data: 'BASE64', mimeType: 'image/png' },
        ],
      },
    ];
    const engine = toEngineMessages(messages);
    const use = engine.flatMap((m) => m.toolUses)[0]!;
    expect(use.text).toBe('captured\n[image]');
    expect(use.text).not.toContain('BASE64');
  });

  test('an error result is marked as an error', () => {
    const messages: PiMessage[] = [
      { role: 'user', content: 'go' },
      {
        role: 'assistant',
        content: [{ type: 'toolCall', id: 'c', name: 'bash', arguments: {} }],
      },
      { role: 'toolResult', toolCallId: 'c', content: [{ type: 'text', text: 'boom' }], isError: true },
    ];
    const engine = toEngineMessages(messages);
    expect(collectToolCalls(engine, 0)[0]!.isError).toBe(true);
  });

  test('a string-content user message is accepted', () => {
    const engine = toEngineMessages([{ role: 'user', content: 'plain string' }]);
    expect(engine[0]!.text).toBe('plain string');
  });

  test('empty messages are dropped without throwing', () => {
    const engine = toEngineMessages([
      { role: 'user', content: '' },
      { role: 'assistant', content: [] },
      { role: 'user', content: 'real' },
    ]);
    expect(engine.length).toBe(1);
    expect(engine[0]!.text).toBe('real');
  });

  test('non-conversational roles keep their text instead of being dropped', () => {
    // pi's own `convertToLlm` maps every one of these onto user text, so
    // dropping them here would delete context pi's default summarizer keeps.
    const engine = toEngineMessages([
      { role: 'user', content: 'q' },
      { role: 'branchSummary', summary: 'BRANCH-CONTENT' },
      { role: 'compactionSummary', summary: 'PRIOR-CONTENT' },
      { role: 'custom', content: 'CUSTOM-CONTENT' },
      { role: 'bashExecution', command: 'ls', output: 'BASH-CONTENT' },
    ]);
    const all = engine.map((m) => m.text).join('\n');
    expect(all).toContain('BRANCH-CONTENT');
    expect(all).toContain('PRIOR-CONTENT');
    expect(all).toContain('CUSTOM-CONTENT');
    expect(all).toContain('BASH-CONTENT');
    // ...and none of them introduces a tool call to be judged.
    expect(engine.flatMap((m) => m.toolUses).length).toBe(0);
  });

  test('a bashExecution excluded from context stays out', () => {
    const engine = toEngineMessages([
      { role: 'user', content: 'q' },
      { role: 'bashExecution', command: 'x', output: 'EXCLUDED', excludeFromContext: true },
    ]);
    expect(engine.map((m) => m.text).join('\n')).not.toContain('EXCLUDED');
  });

  test('an unknown role with usable text is kept, not dropped', () => {
    const engine = toEngineMessages([
      { role: 'user', content: 'q' },
      { role: 'somethingNew', content: 'NEW-ROLE-CONTENT' },
    ]);
    expect(engine.map((m) => m.text).join('\n')).toContain('NEW-ROLE-CONTENT');
  });
});

describe('trace arguments are bounded', () => {
  test('a discarded write renders a small trace, not the file body', () => {
    // `write` carries the whole file in `content`, so rendering the arguments in
    // full would reproduce exactly the bytes just discarded. Measured on a real
    // session this cost 489 KB of a 823 KB summary.
    const body = 'x'.repeat(20_000);
    const engine = toEngineMessages([
      { role: 'user', content: 'go' },
      {
        role: 'assistant',
        content: [
          { type: 'toolCall', id: 'w1', name: 'write', arguments: { content: body, path: 'src/a.ts' } },
        ],
      },
      { role: 'toolResult', toolCallId: 'w1', content: [{ type: 'text', text: body }] },
    ]);
    // Mark it dropped the way the engine would.
    for (const m of engine) for (const u of m.toolUses) u.removed = true;

    const text = serializeEngineMessages(engine);
    const callLine = text.split('\n').find((l) => l.startsWith('[Assistant tool calls]:'))!;
    expect(callLine.length).toBeLessThan(700);
    // The identifying key survives even though `content` is huge and comes first.
    expect(callLine).toContain('path="src/a.ts"');
    expect(callLine).toContain('more)');
    // The body itself is not reproduced.
    expect(callLine).not.toContain('x'.repeat(1000));
  });

  test('a kept call still renders its arguments in full', () => {
    const body = 'y'.repeat(5_000);
    const engine = toEngineMessages([
      { role: 'user', content: 'go' },
      {
        role: 'assistant',
        content: [
          { type: 'toolCall', id: 'k1', name: 'write', arguments: { content: body, path: 'src/b.ts' } },
        ],
      },
      { role: 'toolResult', toolCallId: 'k1', content: [{ type: 'text', text: body }] },
    ]);
    const text = serializeEngineMessages(engine);
    // A kept call and its kept result must agree, so nothing is clipped.
    expect(text).toContain(body);
  });
});

describe('serializeEngineMessages', () => {
  test('renders pi-style markers and keeps kept results verbatim', () => {
    const engine = toEngineMessages(piTranscript('important detail'));
    const text = serializeEngineMessages(engine);
    expect(text).toContain('[User]: read the file please');
    expect(text).toContain('[Assistant]: Reading now.');
    expect(text).toContain('[Assistant tool calls]: read(path="src/a.ts")');
    expect(text).toContain('[Tool result]: important detail');
  });

  test('a kept result is NOT clipped at pi\'s 2000-char serializer limit', () => {
    const long = 'z'.repeat(9000);
    const engine = toEngineMessages(piTranscript(long));
    const text = serializeEngineMessages(engine);
    // This is the whole point: pi's own serializer truncates at 2000 chars.
    expect(text).toContain(long);
    expect(text).not.toContain('more characters truncated');
  });

  test('a tool result is rendered once, not also as user text', () => {
    // A toolResult row is folded onto its call. If it also fell through the
    // generic text path it would be emitted twice — once as `[Tool result]:`
    // and again as `[User]:` — doubling the context and misleading Jev.
    const engine = toEngineMessages(piTranscript('UNIQUE-TOOL-OUTPUT'));
    const text = serializeEngineMessages(engine);
    expect((text.match(/UNIQUE-TOOL-OUTPUT/g) ?? []).length).toBe(1);
    expect(text).not.toContain('[User]: UNIQUE-TOOL-OUTPUT');
    expect(text).toContain('[Tool result]: UNIQUE-TOOL-OUTPUT');
  });

  test('a call whose result was removed renders without a result line', () => {
    const engine = toEngineMessages([
      { role: 'user', content: 'go' },
      {
        role: 'assistant',
        content: [{ type: 'toolCall', id: 'c', name: 'read', arguments: { path: 'x' } }],
      },
      { role: 'toolResult', toolCallId: 'c', content: [] },
    ]);
    const text = serializeEngineMessages(engine);
    expect(text).toContain('[Assistant tool calls]: read(path="x")');
    expect(text).not.toContain('[Tool result]:');
  });
});
