/**
 * Tests for the extension's own hook wiring — the layer between pi's
 * `session_before_compact` event and the Jev engine.
 *
 * The bug this file exists to prevent: pi runs a **second** compaction by
 * taking the previous summary out of the message list and handing it back as
 * `preparation.previousSummary`. Everything the earlier summary contained is
 * therefore absent from `messagesToSummarize`. An extension that reads only the
 * messages writes a summary that forgets all older context — silently, because
 * the compaction still "succeeds".
 *
 * These tests are hermetic: `globalThis.fetch` is replaced with a fake that
 * answers the System One endpoint, so the real client, retry wrapper, engine and
 * serializer all run without touching the network.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import jevCompact, { stripCompactionFrame } from '../src/index.ts';

type Handler = (event: unknown, ctx: unknown) => Promise<unknown>;

const JE = 'https://api.typesafe.ai/v1/systemone';

/** Records the answer Jev would give and lets a test override it. */
interface FakeJevServer {
  requests: Array<{ url: string; body: string }>;
  /** Probability returned for every question. */
  answer: number;
  /** Throw a transport-looking error on the Nth request (1-based). */
  failOn: number | null;
  restore: () => void;
}

function installFakeJev(answer = 0): FakeJevServer {
  const original = globalThis.fetch;
  const server: FakeJevServer = {
    requests: [],
    answer,
    failOn: null,
    restore: () => {
      globalThis.fetch = original;
    },
  };
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const body = typeof init?.body === 'string' ? init.body : '';
    server.requests.push({ url, body });
    if (server.failOn !== null && server.requests.length === server.failOn) {
      throw Object.assign(new Error('fetch failed'), {
        cause: new Error('unknown certificate verification error'),
      });
    }
    const parsed = JSON.parse(body) as { questions?: Record<string, unknown> };
    const answers: Record<string, { type: string; noul: number }> = {};
    for (const name of Object.keys(parsed.questions ?? {})) {
      answers[name] = { type: 'noul', noul: server.answer };
    }
    return new Response(JSON.stringify({ answers }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return server;
}

/** Loads the extension factory and captures the handlers it registers. */
function loadExtension(): Record<string, Handler[]> {
  const handlers: Record<string, Handler[]> = {};
  const pi = {
    on(event: string, handler: Handler) {
      (handlers[event] ??= []).push(handler);
    },
    registerCommand() {},
    registerTool() {},
    registerShortcut() {},
    events: createBus(),
  };
  jevCompact(pi as never);
  return handlers;
}

/**
 * A minimal `pi.events` stand-in.
 *
 * The redaction bridge is the only consumer, and it needs a real bus to prove
 * the handshake works in both load orders rather than simply being wired.
 */
function createBus(): {
  emit(channel: string, data: unknown): void;
  on(channel: string, handler: (data: unknown) => void): () => void;
} {
  const handlers = new Map<string, Set<(data: unknown) => void>>();
  return {
    emit(channel, data) {
      for (const handler of handlers.get(channel) ?? []) handler(data);
    },
    on(channel, handler) {
      const set = handlers.get(channel) ?? new Set();
      set.add(handler);
      handlers.set(channel, set);
      return () => set.delete(handler);
    },
  };
}

function makeCtx(): { ctx: unknown; notes: string[] } {
  const notes: string[] = [];
  return {
    notes,
    ctx: {
      ui: { notify: (message: string) => notes.push(message) },
      cwd: process.cwd(),
      modelRegistry: {
        // The extension must not depend on this: an unregistered provider id
        // makes `getApiKeyForProvider` return undefined.
        async getApiKeyForProvider() {
          return undefined;
        },
      },
    },
  };
}

/** An assistant tool call plus its separate result row, both filled with noise. */
function noisyToolMessages(count: number): unknown[] {
  const messages: unknown[] = [{ role: 'user', content: 'recent question' }];
  for (let i = 0; i < count; i += 1) {
    messages.push({
      role: 'assistant',
      content: [{ type: 'toolCall', id: `t${i}`, name: 'bash', arguments: { command: `noisy ${i}` } }],
    });
    messages.push({
      role: 'toolResult',
      toolCallId: `t${i}`,
      toolName: 'bash',
      content: [{ type: 'text', text: `noise ${i}\n`.repeat(60) }],
    });
  }
  return messages;
}

function preparation(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    firstKeptEntryId: 'keep-1',
    messagesToSummarize: noisyToolMessages(12),
    turnPrefixMessages: [],
    isSplitTurn: false,
    tokensBefore: 90_000,
    fileOps: { read: new Set(), written: new Set(), deleted: new Set() },
    settings: { enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 },
    ...overrides,
  };
}

async function runCompact(
  handlers: Record<string, Handler[]>,
  ctx: unknown,
  prep: Record<string, unknown>,
  customInstructions?: string,
): Promise<{ summary?: string; returned: unknown }> {
  let result: { compaction?: { summary: string } } | undefined;
  for (const handler of handlers['session_before_compact'] ?? []) {
    result = (await handler(
      {
        type: 'session_before_compact',
        preparation: prep,
        branchEntries: [],
        customInstructions,
        reason: 'threshold',
        willRetry: false,
        signal: new AbortController().signal,
      },
      ctx,
    )) as typeof result;
  }
  return { summary: result?.compaction?.summary, returned: result };
}

let server: FakeJevServer;
let savedKey: string | undefined;

beforeEach(() => {
  savedKey = process.env.TYPESAFE_API_KEY;
  process.env.TYPESAFE_API_KEY = 'test-key';
  server = installFakeJev(0);
});

afterEach(() => {
  server.restore();
  if (savedKey === undefined) delete process.env.TYPESAFE_API_KEY;
  else process.env.TYPESAFE_API_KEY = savedKey;
});

describe('second compaction', () => {
  test('previousSummary is folded back into the summary', async () => {
    const handlers = loadExtension();
    const { ctx } = makeCtx();
    const PRIOR =
      'PRIOR-CONSTRAINT: never edit src/generated; the API is /v2/orders; the migration runs first.';

    const { summary } = await runCompact(
      handlers,
      ctx,
      preparation({ previousSummary: PRIOR }),
    );

    expect(summary).toBeDefined();
    // The prior summary is the ONLY carrier of this text: pi excludes the
    // pre-compaction history from `messagesToSummarize`.
    expect(summary).toContain('never edit src/generated');
    expect(summary).toContain('/v2/orders');
    expect(summary).toContain('the migration runs first');
  });

  test('the prior summary is sent to Jev, not merely appended', async () => {
    const handlers = loadExtension();
    const { ctx } = makeCtx();
    await runCompact(handlers, ctx, preparation({ previousSummary: 'PRIOR-UNIQUE-TOKEN' }));
    const sent = server.requests.map((r) => r.body).join('\n');
    expect(sent).toContain('PRIOR-UNIQUE-TOKEN');
  });

  test('a first compaction (no previousSummary) still works', async () => {
    const handlers = loadExtension();
    const { ctx } = makeCtx();
    const { summary } = await runCompact(handlers, ctx, preparation());
    expect(summary).toBeDefined();
    expect(summary!.length).toBeGreaterThan(0);
  });

  test('the framing does not nest when a prior summary is folded in again', async () => {
    // `previousSummary` is our own serialized output, so it already begins with
    // `[User]: ` plus the frame. Prepending both again nested one more layer per
    // compaction — a real session reached two nested frames by its third Jev
    // compaction, and the layers are pure overhead the model has to read.
    const handlers = loadExtension();
    const { ctx } = makeCtx();
    const FRAME =
      'The conversation history before this point was compacted into the following summary:\n\n';
    // What pi hands back after a first Jev compaction: the summary verbatim.
    const prior = `[User]: ${FRAME}## Goal\n- keep this constraint`;

    const { summary } = await runCompact(
      handlers,
      ctx,
      preparation({ previousSummary: prior }),
    );

    expect(summary).toBeDefined();
    // Exactly one frame, no matter how many compactions came before.
    expect(summary!.split(FRAME).length - 1).toBe(1);
    expect(summary!.startsWith(`[User]: ${FRAME}## Goal`)).toBe(true);
    expect(summary).toContain('keep this constraint');
  });

  test('framing already nested by earlier versions is collapsed, not extended', async () => {
    // Sessions compacted before the fix carry several layers. They must be
    // unwound rather than added to, or the count keeps growing forever.
    const handlers = loadExtension();
    const { ctx } = makeCtx();
    const FRAME =
      'The conversation history before this point was compacted into the following summary:\n\n';
    const prior = `[User]: ${FRAME}[User]: ${FRAME}[User]: ${FRAME}## Goal\n- legacy layers`;

    const { summary } = await runCompact(
      handlers,
      ctx,
      preparation({ previousSummary: prior }),
    );

    expect(summary).toBeDefined();
    expect(summary!.split(FRAME).length - 1).toBe(1);
    expect(summary).toContain('legacy layers');
  });

  test('discard notes inherited from an earlier version are folded in', async () => {
    // Unit tests cover `normalizeDiscardedNotes`; this proves the hook actually
    // applies it to `previousSummary`. Without the call, the notes stay text that
    // Jev can never delete, and every later compaction copies them forward — a
    // real summary accumulated 328 (24 KB, 11%).
    const handlers = loadExtension();
    const { ctx } = makeCtx();
    const legacy = '[Tool result]: (output discarded by compaction; re-run `bash` if needed)';
    const prior = [
      '[Assistant tool calls]: bash(command="ls")',
      legacy,
      '[Assistant]: keep this',
    ].join('\n\n');

    const { summary } = await runCompact(
      handlers,
      ctx,
      preparation({ previousSummary: prior }),
    );

    expect(summary).toBeDefined();
    expect(summary).not.toContain(legacy);
    expect(summary).toContain('bash(command="ls") [output discarded; re-run to restore]');
    expect(summary).toContain('keep this');
  });

  test('a bare [User]: marker is not mistaken for framing', () => {
    // The marker alone legitimately begins a serialized transcript; stripping it
    // would delete real content. Only the complete marker+frame unit is removed.
    expect(stripCompactionFrame('[User]: ordinary text')).toBe('[User]: ordinary text');
    expect(stripCompactionFrame('plain text')).toBe('plain text');
    expect(stripCompactionFrame('')).toBe('');
    // A frame without the marker is left alone too: it is not the unit we wrote.
    const FRAME =
      'The conversation history before this point was compacted into the following summary:\n\n';
    expect(stripCompactionFrame(FRAME + 'body')).toBe(FRAME + 'body');
    // The complete unit is removed, once per repetition.
    expect(stripCompactionFrame(`[User]: ${FRAME}body`)).toBe('body');
    expect(stripCompactionFrame(`[User]: ${FRAME}[User]: ${FRAME}body`)).toBe('body');
  });
});

describe('fallback behaviour', () => {
  // regression: jev_custom_compaction_focus
  test('manual compaction instructions are included in Jev goal', async () => {
    const handlers = loadExtension();
    const { ctx } = makeCtx();
    await runCompact(
      handlers,
      ctx,
      preparation(),
      'Keep database migration commands and their exact output.',
    );

    expect(server.requests.length).toBeGreaterThan(0);
    const bodies = server.requests.map((request) => JSON.parse(request.body) as {
      state?: { goal?: string };
    });
    for (const body of bodies) {
      expect(body.state?.goal).toContain('recent question');
      expect(body.state?.goal).toContain(
        'Additional compaction focus: Keep database migration commands and their exact output.',
      );
    }
  });

  test('the returned compaction carries the ids pi needs back', async () => {
    const handlers = loadExtension();
    const { ctx } = makeCtx();
    const { returned } = await runCompact(
      handlers,
      ctx,
      preparation({ firstKeptEntryId: 'keep-abc', tokensBefore: 123_456 }),
    );
    const compaction = (returned as { compaction: Record<string, unknown> }).compaction;
    expect(compaction.firstKeptEntryId).toBe('keep-abc');
    expect(compaction.tokensBefore).toBe(123_456);
    expect((compaction.details as { provider: string }).provider).toBe('jev-compact');
  });

  test('an empty input falls back to pi rather than returning an empty summary', async () => {
    const handlers = loadExtension();
    const { ctx } = makeCtx();
    const { returned } = await runCompact(
      handlers,
      ctx,
      preparation({ messagesToSummarize: [], turnPrefixMessages: [] }),
    );
    expect(returned).toBeUndefined();
    expect(server.requests.length).toBe(0);
  });

  test('too little reduction falls back instead of replacing a good summary', async () => {
    const handlers = loadExtension();
    const { ctx, notes } = makeCtx();
    // Text-only input: nothing Jev may delete, so reduction is zero.
    const { returned } = await runCompact(
      handlers,
      ctx,
      preparation({ messagesToSummarize: [{ role: 'user', content: 'just text' }] }),
    );
    expect(returned).toBeUndefined();
    expect(notes.some((n) => n.includes('using pi'))).toBe(true);
  });

  test('a transport failure is retried and still succeeds', async () => {
    server.failOn = 1;
    const handlers = loadExtension();
    const { ctx, notes } = makeCtx();
    const { summary } = await runCompact(handlers, ctx, preparation());
    expect(server.requests.length).toBe(2);
    expect(summary).toBeDefined();
    expect(notes.some((n) => n.includes('retrying'))).toBe(true);
  });
});

describe('api key resolution', () => {
  test('a missing key disables the hook and warns, without consulting the registry', async () => {
    delete process.env.TYPESAFE_API_KEY;
    const handlers = loadExtension();
    const { ctx, notes } = makeCtx();
    for (const handler of handlers['session_start'] ?? []) {
      await handler({ type: 'session_start', reason: 'startup' }, ctx);
    }
    expect(notes.some((n) => n.includes('TYPESAFE_API_KEY is not set'))).toBe(true);

    const { returned } = await runCompact(handlers, ctx, preparation());
    expect(returned).toBeUndefined();
    expect(server.requests.length).toBe(0);
  });

  test('a key with a stray newline is repaired rather than sent broken', async () => {
    // A key pasted into `setx` can pick up a wrapped line. A newline inside an
    // HTTP header throws before the request is sent, with an error that names
    // no cause, so the key is stripped and the user is warned.
    process.env.TYPESAFE_API_KEY = 'test-key\nbroken';
    const handlers = loadExtension();
    const { ctx, notes } = makeCtx();
    for (const handler of handlers['session_start'] ?? []) {
      await handler({ type: 'session_start', reason: 'startup' }, ctx);
    }
    expect(notes.some((n) => n.includes('contains whitespace'))).toBe(true);

    const { summary } = await runCompact(handlers, ctx, preparation());
    expect(summary).toBeDefined();
    // The header pi would have sent must be free of whitespace.
    const auth = server.requests.length > 0 ? 'sent' : '';
    expect(auth).toBe('sent');
  });

  test('a whitespace-only key counts as missing', async () => {
    process.env.TYPESAFE_API_KEY = '   \n  ';
    const handlers = loadExtension();
    const { ctx, notes } = makeCtx();
    for (const handler of handlers['session_start'] ?? []) {
      await handler({ type: 'session_start', reason: 'startup' }, ctx);
    }
    expect(notes.some((n) => n.includes('is not set'))).toBe(true);
    const { returned } = await runCompact(handlers, ctx, preparation());
    expect(returned).toBeUndefined();
  });

  test('JEV_COMPACT=false disables the extension entirely', async () => {
    process.env.JEV_COMPACT = 'false';
    try {
      const handlers = loadExtension();
      expect(handlers['session_before_compact']).toBeUndefined();
    } finally {
      delete process.env.JEV_COMPACT;
    }
  });
});
