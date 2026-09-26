import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const CHANNEL = "pi-redact:service";
const REQUEST = "pi-redact:service-request";

export type RedactService = { version: number; redactJson(value: unknown): unknown; redactString(value: string): string };

/** Runtime-only bridge: goal remains independently installable. */
export function installRedactBridge(pi: ExtensionAPI): () => RedactService | undefined {
	let service: RedactService | undefined;
	try {
		pi.events?.on(CHANNEL, (value) => {
			const candidate = value as Partial<RedactService> | null;
			if ((candidate?.version === 1 || candidate?.version === 2) && typeof candidate.redactJson === "function" && typeof candidate.redactString === "function") service = candidate as RedactService;
		});
		pi.events?.emit(REQUEST, undefined);
	} catch { /* Older pi: verification still works, without this optional bridge. */ }
	return () => service;
}
