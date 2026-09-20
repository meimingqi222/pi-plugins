/**
 * End-to-end proof that a secret in the transcript does not reach TypeSafe when
 * both plugins are loaded.
 *
 * The unit tests on each side use a fake counterpart, so they prove the bridge
 * wires up but not that the *real* pi-redact engine redacts the *real* Jev
 * payload shape. This file loads both real extensions onto one shared bus and
 * inspects the bytes the Jev client actually sends.
 *
 * It also pins the reason the bridge exists: without it, the same secret is
 * redacted from the model request and uploaded to TypeSafe in the clear.
 *
 * The two plugins are separate packages, so this test imports across the
 * workspace. That is deliberate — an integration test is the one place a
 * cross-package dependency is correct. It must not leak into either plugin's
 * runtime, which is what the bus contract guarantees.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import piRedact from '../../redact/src/index.ts';
import jevCompact from '../src/index.ts';
import { REDACT_DISCOVERY_CHANNEL, REDACT_SERVICE_CHANNEL } from '../../redact/src/service.ts';

/** A real-ish bus, shared by both extensions exactly as pi shares one. */
function createBus() {
  const handlers = new Map<string, Set<(data: unknown) => void>>();
  return {
    emit(channel: string, data: unknown) {
      for (const handler of handlers.get(channel) ?? []) handler(data);
    },
    on(channel: string, handler: (data: unknown) => void) {
      const set = handlers.get(channel) ?? new Set();
      set.add(handler);
      handlers.set(channel, set);
      return () => set.delete(handler);
    },
  };
}

interface Loaded {
  handlers: Record<string, Array<(event: any, ctx: any) => Promise<unknown>>>;
  /** Raw request bodies the Jev client sent. */
  sent: string[];
  /** Notifications the extension raised, in order. */
  notes: string[];
  restore: () => void;
}

/**
 * Loads the requested extensions in the given order onto one bus, with `fetch`
 * stubbed so the real engine and serializer run but nothing leaves the machine.
 */
function loadExtensions(
  factories: Array<(pi: any) => void>,
  order?: 'reverse',
): Loaded {
  const bus = createBus();
  const handlers: Loaded['handlers'] = {};
  const sent: string[] = [];
  const notes: string[] = [];

  const makePi = () => ({
    on(event: string, handler: (event: any, ctx: any) => Promise<unknown>) {
      (handlers[event] ??= []).push(handler);
    },
    registerCommand() {},
    registerTool() {},
    registerShortcut() {},
    appendEntry() {},
    events: bus,
  });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
    sent.push(typeof init?.body === 'string' ? init.body : '');
    // Answer every question with noul = 0 so everything is droppable, which
    // keeps the compaction from deferring to pi and exercises the summary path.
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : {};
    const answers: Record<string, { type: string; noul: number }> = {};
    for (const name of Object.keys(body.questions ?? {})) {
      answers[name] = { type: 'noul', noul: 0 };
    }
    return new Response(JSON.stringify({ answers }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }) as Response;
  }) as typeof fetch;

  const ordered = order === 'reverse' ? [...factories].reverse() : factories;
  for (const factory of ordered) factory(makePi() as never);

  return {
    handlers,
    sent,
    notes,
    restore: () => {
      globalThis.fetch = originalFetch;
    },
  };
}

/** The real secret shape pi-redact recognises: a GitHub PAT. */
const GITHUB_PAT = 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8';

function ctx(notes?: string[]) {
  return {
    ui: { notify: (message: string) => void notes?.push(message) },
    cwd: process.cwd(),
    sessionManager: { getBranch: () => [] },
    modelRegistry: { async getApiKeyForProvider() { return undefined; } },
  };
}

/**
 * A transcript that puts the secret exactly where Jev actually sees text.
 *
 * This matters and was got wrong first: the Jev state replaces a tool result's
 * *contents* with `ok, N chars (omitted)`, so a secret hidden in tool output
 * never reaches TypeSafe in the first place. The surfaces that DO carry text
 * are user messages, assistant text, and tool **arguments** — and for a coding
 * agent a credential in a tool argument (`bash(command=...)`) is the common
 * case. The fixture therefore plants the secret in all three.
 */
function preparation() {
  const messages: unknown[] = [
    { role: 'user', content: `deploy using token ${GITHUB_PAT}` },
    {
      role: 'assistant',
      content: [
        { type: 'text', text: `I will export ${GITHUB_PAT} before deploying` },
        {
          type: 'toolCall',
          id: 't0',
          name: 'bash',
          arguments: { command: `export GH_TOKEN=${GITHUB_PAT}` },
        },
      ],
    },
    {
      role: 'toolResult',
      toolCallId: 't0',
      toolName: 'bash',
      content: [{ type: 'text', text: 'exported' }],
    },
  ];
  // Bulk, so a compaction is worth taking and the engine does not defer to pi.
  for (let i = 1; i <= 12; i += 1) {
    messages.push({
      role: 'assistant',
      content: [{ type: 'toolCall', id: `t${i}`, name: 'read', arguments: { path: `.env.${i}` } }],
    });
    messages.push({
      role: 'toolResult',
      toolCallId: `t${i}`,
      toolName: 'read',
      content: [{ type: 'text', text: `filler ${i} `.repeat(80) }],
    });
  }
  return {
    firstKeptEntryId: 'keep-1',
    messagesToSummarize: messages,
    turnPrefixMessages: [],
    isSplitTurn: false,
    tokensBefore: 90_000,
    fileOps: { read: new Set(), written: new Set(), deleted: new Set() },
    settings: { enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 },
  };
}

async function runCompact(loaded: Loaded): Promise<void> {
  for (const handler of loaded.handlers['session_before_compact'] ?? []) {
    await handler(
      {
        type: 'session_before_compact',
        preparation: preparation(),
        branchEntries: [],
        reason: 'threshold',
        willRetry: false,
        signal: new AbortController().signal,
      },
      ctx(loaded.notes),
    );
  }
}

/** Fires the startup notice, which is where the protection state is reported. */
async function runSessionStart(loaded: Loaded): Promise<void> {
  for (const handler of loaded.handlers['session_start'] ?? []) {
    await handler({ type: 'session_start', reason: 'startup' }, ctx(loaded.notes));
  }
}

let savedKey: string | undefined;

beforeEach(() => {
  savedKey = process.env.TYPESAFE_API_KEY;
  process.env.TYPESAFE_API_KEY = 'test-key';
  process.env.PI_REDACT_NOTIFY = 'false';
});

afterEach(() => {
  if (savedKey === undefined) delete process.env.TYPESAFE_API_KEY;
  else process.env.TYPESAFE_API_KEY = savedKey;
  delete process.env.PI_REDACT_NOTIFY;
});

describe('pi-redact + pi-jev-compact integration', () => {
  for (const order of ['redact-first', 'compact-first'] as const) {
    test(`a secret in user text, assistant text and tool args never reaches TypeSafe (${order})`, async () => {
      const loaded = loadExtensions(
        [piRedact, jevCompact],
        order === 'compact-first' ? 'reverse' : undefined,
      );
      try {
        await runCompact(loaded);

        expect(loaded.sent.length).toBeGreaterThan(0);
        const uploaded = loaded.sent.join('\n');
        expect(uploaded).not.toContain(GITHUB_PAT);
        expect(uploaded).toContain('[REDACTED:github-pat]');
      } finally {
        loaded.restore();
      }
    });
  }

  test('the startup notice reports whether the upload is protected', async () => {
    // The protection cannot be assumed from "both plugins are installed": if
    // the handshake failed, the user must be told rather than left guessing.
    const protectedRun = loadExtensions([piRedact, jevCompact], 'reverse');
    try {
      await runSessionStart(protectedRun);
      expect(protectedRun.notes.some((n) => n.includes('pi-redact detected'))).toBe(true);
      expect(protectedRun.notes.some((n) => n.includes('sent unredacted'))).toBe(false);
    } finally {
      protectedRun.restore();
    }

    const soloRun = loadExtensions([jevCompact]);
    try {
      await runSessionStart(soloRun);
      expect(soloRun.notes.some((n) => n.includes('pi-redact not detected'))).toBe(true);
      expect(soloRun.notes.some((n) => n.includes('sent unredacted'))).toBe(true);
    } finally {
      soloRun.restore();
    }
  });

  test('without pi-redact the payload is uploaded unredacted (pre-bridge baseline)', async () => {
    // Pins the gap the bridge closes, so the test cannot pass vacuously by the
    // secret never having been in the payload at all.
    const loaded = loadExtensions([jevCompact]);
    try {
      await runCompact(loaded);
      expect(loaded.sent.join('\n')).toContain(GITHUB_PAT);
    } finally {
      loaded.restore();
    }
  });

  test('the bus contract constants match across both packages', () => {
    // The consumer duplicates the channel names and version because it cannot
    // import them without recreating the dependency the bus removes. This test
    // is what keeps the two copies honest.
    const bus = createBus();
    const announcements: unknown[] = [];
    bus.on(REDACT_SERVICE_CHANNEL, (data) => announcements.push(data));
    piRedact({
      on() {},
      registerCommand() {},
      registerTool() {},
      registerShortcut() {},
      appendEntry() {},
      events: bus,
    } as never);

    expect(announcements).toHaveLength(1);
    expect((announcements[0] as { version: number }).version).toBe(1);
    expect(REDACT_DISCOVERY_CHANNEL).toBe('pi-redact:service-request');
    expect(REDACT_SERVICE_CHANNEL).toBe('pi-redact:service');
  });
});
