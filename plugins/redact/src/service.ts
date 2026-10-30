/**
 * The redaction service pi-redact publishes on pi's shared event bus.
 *
 * Why this exists: pi-redact gates the *provider* payload, but another
 * extension that talks to its own backend (for example pi-jev-compact, which
 * posts a conversation to TypeSafe) never passes through those hooks. Without a
 * channel, the only ways to fix that would be to duplicate the 112-rule engine
 * in the other plugin or to couple one plugin to the other's package — both
 * rejected. pi's documented inter-extension bus (`pi.events`) lets the consumer
 * call this live redactor instead.
 *
 * Consumers are installed and loaded independently of this extension — a
 * machine may run `pi-permissions` without `pi-redact` at all — so the
 * contract lives in a small shared package and every announcement is still
 * validated at runtime before it is used.
 */

import { isCompatibleRedactService } from "@meimingqi222/pi-redact-contract";

/** Channel a consumer subscribes to. Namespaced to avoid collisions. */
export const REDACT_SERVICE_CHANNEL = "pi-redact:service";

/**
 * Channel a consumer emits to ask for a fresh announcement.
 *
 * Needed because load order is not controllable and there is no "wait for
 * extension X" primitive: whichever plugin loads second would otherwise miss
 * the other's single announcement. A consumer that finds nothing calls this and
 * listens, so the handshake completes in either order.
 */
export const REDACT_DISCOVERY_CHANNEL = "pi-redact:service-request";

/** Bump on any change to `RedactService`'s shape or semantics. */
export const REDACT_SERVICE_VERSION = 2;

/**
 * What pi-redact announces. `redactJson` is the primary entry point: it deep
 * walks the value and returns a redacted copy, leaving unchanged branches by
 * reference.
 *
 * The service is a **live view**, not a snapshot: it honours `/redact off`, so a
 * caller that respects the user's pause does not need to track that state.
 */
export interface RedactService {
  readonly version: number;
  /** Live state; a paused service must not be mistaken for an active guard. */
  isEnabled(): boolean;
  /** Deep-redact any JSON-reachable value. Returns the input when disabled. */
  redactJson(value: unknown): unknown;
  /** Redact one string. Returns it unchanged when disabled. */
  redactString(value: string | null | undefined): string | null | undefined;
  /** Active pattern count, for diagnostics in the consuming plugin. */
  readonly patternCount: number;
}

/** True when `value` is a usable, compatible announcement. */
export function isRedactService(value: unknown): value is RedactService {
  if (!isCompatibleRedactService(value)) return false;
  const candidate = value;
  return (
    candidate.version === REDACT_SERVICE_VERSION &&
    typeof candidate.isEnabled === "function" &&
    typeof candidate.redactJson === "function" &&
    typeof candidate.redactString === "function" &&
    typeof candidate.patternCount === "number"
  );
}
