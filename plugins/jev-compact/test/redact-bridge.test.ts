/**
 * The redaction bridge: pi-jev-compact must redact the payload it uploads to
 * TypeSafe when pi-redact is loaded, and must work unchanged when it is not.
 *
 * Why this file exists: pi-redact gates pi's *provider* payloads through hooks,
 * but this plugin sends a full conversation to TypeSafe with its own `fetch`,
 * which never passes through those hooks. Before the bridge, the same secret
 * was redacted from the model request and uploaded in the clear in the same
 * turn. An independent-install requirement rules out importing pi-redact, so
 * the contract travels over `pi.events` and is validated at runtime.
 */

import { describe, expect, test } from 'bun:test';

import { installRedactBridge, withRedaction } from '../src/redact.ts';
import type { JevAsker, JevQuestions, JevResponse, JevState } from '../src/jev/types.ts';

const SERVICE_CHANNEL = 'pi-redact:service';
const DISCOVERY_CHANNEL = 'pi-redact:service-request';

/** A `pi.events` stand-in, so both load orders can be exercised directly. */
function createBus() {
  const handlers = new Map<string, Set<(data: unknown) => void>>();
  const emitted: Array<{ channel: string; data: unknown }> = [];
  return {
    emitted,
    emit(channel: string, data: unknown) {
      emitted.push({ channel, data });
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

/** A service that replaces a sentinel string, so redaction is observable. */
function fakeService(overrides: Record<string, unknown> = {}) {
  return {
    version: 2,
    patternCount: 3,
    isEnabled: () => true,
    redactJson: (value: unknown) => JSON.parse(JSON.stringify(value).replaceAll('SECRET', '[REDACTED]')),
    redactString: (value: string | null | undefined) =>
      typeof value === 'string' ? value.replaceAll('SECRET', '[REDACTED]') : value,
    ...overrides,
  };
}

/**
 * The pi-redact side of the handshake, mirroring `src/service.ts`: announce on
 * load, and re-announce whenever a consumer asks.
 *
 * Needed because pi's event bus does not replay history. A consumer that loads
 * *after* pi-redact has already announced hears nothing, which is exactly the
 * load order a single announcement would miss — the discovery request is what
 * makes the handshake order-independent, so the test must model it.
 */
function installFakeRedact(bus: ReturnType<typeof createBus>, service = fakeService()) {
  const announce = () => bus.emit(SERVICE_CHANNEL, service);
  bus.on(DISCOVERY_CHANNEL, announce);
  announce();
  return service;
}

/** Captures exactly what the underlying asker received. */
function recordingAsker(): { asker: JevAsker; seen: Array<{ state: JevState; questions: JevQuestions }> } {
  const seen: Array<{ state: JevState; questions: JevQuestions }> = [];
  return {
    seen,
    asker: {
      async ask(state: JevState, questions: JevQuestions): Promise<JevResponse> {
        seen.push({ state, questions });
        return { answers: {} };
      },
    },
  };
}

describe('redaction bridge', () => {
  test('is inactive when pi-redact never announces', () => {
    const bus = createBus();
    const bridge = installRedactBridge({ events: bus } as never);
    expect(bridge.active).toBe(false);
    expect(bridge.service()).toBeUndefined();
  });

  test('discovers a service announced before this plugin loaded', () => {
    // pi-redact first: its announcement is gone by the time this plugin
    // subscribes, so the discovery request must make it announce again.
    const bus = createBus();
    installFakeRedact(bus);
    const bridge = installRedactBridge({ events: bus } as never);
    expect(bridge.active).toBe(true);
  });

  test('discovers a service that loads after this plugin', () => {
    const bus = createBus();
    const bridge = installRedactBridge({ events: bus } as never);
    expect(bridge.active).toBe(false);

    installFakeRedact(bus);
    expect(bridge.active).toBe(true);
  });

  test('the handshake completes in either load order', () => {
    const redactFirst = createBus();
    installFakeRedact(redactFirst);
    const a = installRedactBridge({ events: redactFirst } as never);

    const compactFirst = createBus();
    const b = installRedactBridge({ events: compactFirst } as never);
    installFakeRedact(compactFirst);

    expect(a.active).toBe(true);
    expect(b.active).toBe(true);
  });

  test('ignores an announcement from an incompatible service version', () => {
    const bus = createBus();
    installFakeRedact(bus, fakeService({ version: 99 }));
    const bridge = installRedactBridge({ events: bus } as never);
    expect(bridge.active).toBe(false);
  });

  test('redacts both the state and the questions before upload', async () => {
    const bus = createBus();
    installFakeRedact(bus);
    const bridge = installRedactBridge({ events: bus } as never);
    const { asker, seen } = recordingAsker();

    await withRedaction(asker, bridge).ask(
      { goal: 'SECRET goal' },
      { call_t1: { type: 'noul', instructions: 'SECRET question' } },
    );

    const sent = JSON.stringify(seen[0]);
    expect(sent).not.toContain('SECRET');
    expect(sent).toContain('[REDACTED]');
  });

  test('preserves question keys, so answers still map back to their call', async () => {
    // pi-redact only rewrites string values. If it rewrote a key, Jev's answer
    // would no longer match the question and every call would look unanswered.
    const bus = createBus();
    installFakeRedact(bus);
    const bridge = installRedactBridge({ events: bus } as never);
    const { asker, seen } = recordingAsker();

    await withRedaction(asker, bridge).ask({}, {
      call_t1: { type: 'noul', instructions: 'SECRET' },
      result_t1: { type: 'noul', instructions: 'SECRET' },
    });

    expect(Object.keys(seen[0]!.questions).sort()).toEqual(['call_t1', 'result_t1']);
  });

  test('passes the payload through untouched when pi-redact is absent', async () => {
    const bus = createBus();
    const bridge = installRedactBridge({ events: bus } as never);
    const { asker, seen } = recordingAsker();

    await withRedaction(asker, bridge).ask({ goal: 'SECRET' }, {});

    expect(JSON.stringify(seen[0]!.state)).toContain('SECRET');
  });

  test('strict mode refuses upload without pi-redact and accepts it after a late announcement', async () => {
    const bus = createBus();
    const bridge = installRedactBridge({ events: bus } as never);
    const { asker, seen } = recordingAsker();
    const guarded = withRedaction(asker, bridge, true);

    await expect(guarded.ask({ goal: 'SECRET' }, {})).rejects.toThrow(/redaction service.*unavailable/);
    expect(seen).toHaveLength(0);

    installFakeRedact(bus);
    await guarded.ask({ goal: 'SECRET' }, {});
    expect(JSON.stringify(seen)).not.toContain('SECRET');
  });

  test('strict mode refuses upload when redaction is paused or its state is unknown', async () => {
    const bus = createBus();
    installFakeRedact(bus, fakeService({ isEnabled: () => false }));
    const { asker, seen } = recordingAsker();
    await expect(withRedaction(asker, installRedactBridge({ events: bus } as never), true)
      .ask({ goal: 'SECRET' }, {})).rejects.toThrow(/redaction service.*unavailable/);
    expect(seen).toHaveLength(0);

    const oldBus = createBus();
    installFakeRedact(oldBus, fakeService({ version: 1, isEnabled: undefined }));
    await expect(withRedaction(asker, installRedactBridge({ events: oldBus } as never), true)
      .ask({ goal: 'SECRET' }, {})).rejects.toThrow(/redaction service.*unavailable/);
    expect(seen).toHaveLength(0);
  });

  test("a broken redactor fails closed instead of uploading the raw payload", async () => {
    // Sending the secret is the exact outcome the bridge exists to prevent, so a
    // redactor that throws must abort the ask. The caller turns that into pi's
    // own summary, which is a safe degradation.
    const bus = createBus();
    installFakeRedact(
      bus,
      fakeService({
        redactJson: () => {
          throw new Error('engine exploded');
        },
      }),
    );
    const bridge = installRedactBridge({ events: bus } as never);
    const { asker, seen } = recordingAsker();

    for (const strict of [false, true]) {
      await expect(
        withRedaction(asker, bridge, strict).ask({ goal: 'SECRET' }, {}),
      ).rejects.toThrow(/refusing to send/);
    }
    expect(seen).toHaveLength(0);
  });

  test('a pi-redact service that throws is what triggers fail-closed', () => {
    // The consumer's fail-closed guarantee only holds if the *announced*
    // service propagates engine errors. Wrapping it in pi-redact's own `safe()`
    // helper would fail open instead, so the throw would never arrive here and
    // the raw payload would be uploaded. Guarded on the consumer side too, in
    // `plugins/redact/test/index.test.ts`.
    const bus = createBus();
    installFakeRedact(bus, {
      version: 2,
      patternCount: 1,
      isEnabled: () => true,
      redactJson: () => {
        throw new Error('engine exploded');
      },
      redactString: (value: string | null | undefined) => value,
    });
    const bridge = installRedactBridge({ events: bus } as never);
    const service = bridge.service();
    expect(service).toBeDefined();
    expect(() => service!.redactJson({})).toThrow();
  });

  test('a redactor that throws on the questions does not send the state raw', async () => {
    // Guards the deliberate single-try: redacting state and questions together
    // means a failure on the second call cannot leave the first half uploaded.
    const bus = createBus();
    let calls = 0;
    installFakeRedact(
      bus,
      fakeService({
        redactJson: (value: unknown) => {
          calls += 1;
          if (calls > 1) throw new Error('second call failed');
          return value;
        },
      }),
    );
    const bridge = installRedactBridge({ events: bus } as never);
    const { asker, seen } = recordingAsker();

    await expect(
      withRedaction(asker, bridge).ask({ goal: 'SECRET' }, { call_t1: { type: 'noul', instructions: 'x' } }),
    ).rejects.toThrow();
    expect(seen).toHaveLength(0);
  });

  test('a pi without an event bus degrades to unredacted rather than crashing', async () => {
    const bridge = installRedactBridge({} as never);
    const { asker, seen } = recordingAsker();
    await withRedaction(asker, bridge).ask({ goal: 'SECRET' }, {});
    expect(bridge.active).toBe(false);
    expect(JSON.stringify(seen[0]!.state)).toContain('SECRET');
  });
});
