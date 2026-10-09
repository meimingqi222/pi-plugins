import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

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
    if (!value || typeof value !== "object") return;
    const candidate = value as RedactService;
    if ((candidate.version === 1 || (candidate.version === 2 && typeof candidate.isEnabled === "function"))
      && typeof candidate.redactJson === "function" && typeof candidate.redactString === "function") service = candidate;
  });
  pi.events?.emit("pi-redact:service-request", undefined);
  return {
    // A throwing service must propagate to the hook's fallback, never send raw.
    redact<T>(value: T): T { return service ? service.redactJson(value) as T : value; },
  };
}
