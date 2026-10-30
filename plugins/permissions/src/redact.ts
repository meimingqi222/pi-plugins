/**
 * Consumes the redaction service pi-redact publishes on pi's shared event bus.
 *
 * The privacy gap this closes: an `auto`-mode reviewer sends the tool call and
 * the user's last message to a backend. The `registry` backend goes through
 * pi's provider path (which pi-redact gates), but the Jev backend posts to
 * TypeSafe with its own `fetch` — exactly the shape pi-jev-compact already had
 * to bridge. A user who pastes a credential into a prompt and then makes one
 * grey call sent it to a third party in the clear.
 *
 * The event bus avoids depending on the redactor extension; a small shared
 * contract library validates the same versioned service across consumers.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isCompatibleRedactService } from "@meimingqi222/pi-redact-contract";

const SERVICE_CHANNEL = "pi-redact:service";
const DISCOVERY_CHANNEL = "pi-redact:service-request";

/** The shape pi-redact announces. Validated at runtime, never trusted. */
export interface RedactService {
  version: number;
  isEnabled?: () => boolean;
  redactJson(value: unknown): unknown;
  redactString(value: string | null | undefined): string | null | undefined;
  patternCount?: number;
}

function isService(value: unknown): value is RedactService {
  return isCompatibleRedactService(value);
}

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
      // Discovery is best effort; without it payloads are simply not redacted.
    }
  };

  try {
    pi.events?.on(SERVICE_CHANNEL, (data) => {
      if (isService(data)) current = data;
    });
  } catch {
    // An older pi without `pi.events` leaves the bridge inactive.
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
 * Redact a reviewer payload, or refuse to send it.
 *
 * Fail **closed** when the caller requires redaction: this is a permission
 * layer, and "the redactor is missing" must not degrade into "send the raw
 * secret". The caller treats a throw as `ask`, which is the same path as a
 * reviewer timeout.
 */
export function redactPayload(
  payload: unknown,
  bridge: RedactBridge | undefined,
  requireRedact: boolean,
): unknown {
  const service = bridge?.service();
  if (!service) {
    if (requireRedact) {
      throw new Error("pi-permissions: reviewer payload redaction is required but pi-redact is not active");
    }
    return payload;
  }
  if (service.isEnabled && !service.isEnabled()) {
    if (requireRedact) {
      throw new Error("pi-permissions: the pi-redact service is paused; refusing to send the reviewer payload");
    }
    return payload;
  }
  return service.redactJson(payload);
}
