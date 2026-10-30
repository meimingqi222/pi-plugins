import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isCompatibleRedactService } from "@meimingqi222/pi-redact-contract";

interface RedactService {
  version: number;
  isEnabled?: () => boolean;
  redactJson(value: unknown): unknown;
  redactString(value: string): string;
}

// Plugins publish independently; negotiate the pi-redact contract over pi's bus.
export function installRedactBridge(pi: ExtensionAPI) {
  let service: RedactService | undefined;
  pi.events?.on("pi-redact:service", (value: unknown) => {
    if (isCompatibleRedactService(value)) service = value as RedactService;
  });
  pi.events?.emit("pi-redact:service-request", undefined);
  return {
    // A throwing service must propagate to the hook's fallback, never send raw.
    redact<T>(value: T): T { return service ? service.redactJson(value) as T : value; },
  };
}
