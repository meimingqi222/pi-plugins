import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isCompatibleRedactService } from "@meimingqi222/pi-redact-contract";
import type { RedactService as RedactServiceContract } from "@meimingqi222/pi-redact-contract";

type RedactService = Pick<RedactServiceContract, "version" | "isEnabled" | "redactJson" | "redactString">;

// Installed and loaded independently, so the contract is negotiated on pi's bus
// rather than linked at build time: either plugin may be absent.
export function installRedactBridge(pi: ExtensionAPI) {
  let service: RedactService | undefined;
  pi.events?.on("pi-redact:service", (value: unknown) => {
    if (isCompatibleRedactService(value)) service = value as RedactService;
  });
  pi.events?.emit("pi-redact:service-request", undefined);
  return {
    // A throwing service must propagate to the hook's fallback, never send raw.
    redact<T>(value: T): T { return service ? service.redactJson(value) as T : value; },
    /**
     * Whether a redactor answered at all.
     *
     * Distinct from "redaction is paused": a service that reports itself
     * disabled is the user's explicit choice and the payload goes out as they
     * asked. No service at all is an unexamined gap, and a caller that would
     * otherwise upload unredacted has to treat the two differently.
     */
    available(): boolean { return service !== undefined; },
  };
}
