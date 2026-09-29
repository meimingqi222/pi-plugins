/**
 * Shared fixtures.
 *
 * `PNG_1X1` is a real, minimal PNG: 1×1, RGBA, one IDAT chunk. It has to be
 * real bytes rather than a fake header because the plugin asks pi's own sniffer
 * whether a file is an image — a stub would test the stub instead of the
 * decision that matters.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as path from "node:path";
import type { AttachEnv, LoadedImage } from "../src/attach.ts";

export const PNG_1X1 = Uint8Array.from([
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
	0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
	0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89,
	0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00, 0x05,
	0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4,
	0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
]);

export const PNG_1X1_BASE64 = Buffer.from(PNG_1X1).toString("base64");

/** A model stub; only `input` is read by the plugin. */
export function model(input: string[]): ExtensionContext["model"] {
	return { input } as unknown as ExtensionContext["model"];
}

export interface StubImage {
	mimeType: string;
	base64: string;
}

/**
 * An `AttachEnv` over a fixed map of files. Paths are matched exactly as the
 * loader would receive them, so a test that asserts candidate order has to
 * spell out the candidates.
 *
 * Both sides go through `path.normalize` first. `candidatePaths` speaks the
 * platform's path dialect — it resolves through `path.resolve`/`path.normalize`,
 * so a virtual `/var/folders/tmp/a.png` arrives here as `\var\folders\tmp\a.png`
 * on Windows. Folding both sides keeps a test about candidate order and dedupe
 * from also being a test of `path.normalize` on one platform.
 */
export function stubEnv(
	files: Record<string, StubImage>,
	overrides: Partial<Pick<AttachEnv, "cwd" | "home" | "tmpdir">> = {},
): AttachEnv & { readonly loaded: string[] } {
	const loaded: string[] = [];
	const normal = new Map(Object.entries(files).map(([key, image]) => [path.normalize(key), image]));
	return {
		cwd: overrides.cwd ?? "/work/project",
		home: overrides.home ?? "/Users/me",
		tmpdir: overrides.tmpdir ?? "/var/folders/tmp",
		loaded,
		load: async (filePath: string): Promise<LoadedImage | undefined> => {
			loaded.push(filePath);
			return normal.get(path.normalize(filePath));
		},
	};
}
