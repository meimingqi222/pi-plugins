/**
 * Consumes the redaction service pi-redact publishes on pi's shared event bus.
 *
 * The privacy gap this closes: pi-redact gates pi's *provider* payloads, but
 * this plugin posts a full conversation to TypeSafe (Jev/System One) with its
 * own `fetch`. That request never passes through pi-redact's hooks, so without
 * this bridge a secret in the transcript would be redacted from the model
 * request and sent in the clear to TypeSafe in the same turn.
 *
 * Why a bus and not an import: the two plugins are installed and published
 * independently. `pi-jev-compact` must work with `pi-redact` absent, present,
 * or installed in either order, and must not depend on it at the package level.
 * pi's documented inter-extension bus (`pi.events`) is the one channel that
 * satisfies all three, so the contract is negotiated at runtime instead of
 * linked at build time.
 *
 * The constants below are duplicated from `pi-redact/src/service.ts` on
 * purpose; a cross-package import would reintroduce the dependency. `VERSION`
 * must be kept in sync with `REDACT_SERVICE_VERSION` there, and an
 * announcement from a different version is ignored rather than guessed at.
 */

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

import type { AskOptions, JevAsker, JevQuestions, JevResponse, JevState } from './jev/types.ts';

const SERVICE_CHANNEL = 'pi-redact:service';
const DISCOVERY_CHANNEL = 'pi-redact:service-request';
const SERVICE_VERSION = 1;

/** The shape pi-redact announces. Validated at runtime, never trusted. */
interface RedactService {
  version: number;
  redactJson(value: unknown): unknown;
  redactString(value: string | null | undefined): string | null | undefined;
  patternCount: number;
}

function isService(value: unknown): value is RedactService {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    candidate.version === SERVICE_VERSION &&
    typeof candidate.redactJson === 'function' &&
    typeof candidate.redactString === 'function'
  );
}

/**
 * Tracks the live redaction service, if any.
 *
 * Discovery has to work regardless of load order, and pi offers no "wait for
 * extension X". Subscribing and *also* emitting a request makes the handshake
 * complete either way: a late consumer misses the announcement but its request
 * makes pi-redact repeat it, and a late pi-redact emits into a subscription
 * that is already listening.
 */
export interface RedactBridge {
  /** The service, or undefined when pi-redact is not installed/loaded. */
  service(): RedactService | undefined;
  /** True once a compatible announcement has been seen. */
  readonly active: boolean;
}

export function installRedactBridge(pi: ExtensionAPI): RedactBridge {
  let current: RedactService | undefined;

  const request = (): void => {
    try {
      pi.events?.emit(DISCOVERY_CHANNEL, undefined);
    } catch {
      // Discovery is best effort: without it the payload is simply not redacted.
    }
  };

  try {
    pi.events?.on(SERVICE_CHANNEL, (data) => {
      if (isService(data)) current = data;
    });
  } catch {
    // An older pi without `pi.events` leaves the bridge inactive; callers then
    // send unredacted, which is the pre-bridge behaviour rather than a crash.
  }
  request();

  return {
    service: () => current,
    get active() {
      return current !== undefined;
    },
  };
}

/**
 * Wraps an asker so the payload is redacted immediately before it is sent.
 *
 * Deliberately the **outermost** wrapper, above the retry loop: a retry must
 * reuse the redacted request, both because re-redacting a large state per
 * attempt is wasted work and because a retry that re-read the unredacted input
 * would be the one request that leaks. Wrapping here, at the transport edge,
 * also means any future caller of this asker is covered by construction — the
 * redaction cannot be forgotten in a code path that never touches it.
 *
 * When pi-redact is absent the asker is returned untouched, so this plugin
 * still works standalone. Redaction preserves object keys, so Jev's answers
 * still map back to their questions by name.
 */
export function withRedaction(asker: JevAsker, bridge: RedactBridge): JevAsker {
  return {
    async ask(
      state: JevState,
      questions: JevQuestions,
      options: AskOptions = {},
    ): Promise<JevResponse> {
      const service = bridge.service();
      if (!service) return asker.ask(state, questions, options);

      // Fail **closed**. If the redactor throws we must not fall through to the
      // raw payload: sending a secret to TypeSafe is the exact outcome this
      // bridge exists to prevent, and the caller's failure path (pi's own
      // summary) is a safe degradation. Redacting state and questions in one
      // `try` is deliberate — a partial success must not send the other half raw.
      let safeState: JevState;
      let safeQuestions: JevQuestions;
      try {
        safeState = service.redactJson(state) as JevState;
        safeQuestions = service.redactJson(questions) as JevQuestions;
      } catch (error) {
        throw new Error(
          `pi-redact failed to redact the Jev payload; refusing to send it: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
      return asker.ask(safeState, safeQuestions, options);
    },
  };
}
