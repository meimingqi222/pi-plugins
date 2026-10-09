/**
 * Turning references into attachments.
 *
 * The scan (`references.ts`) says *where* the paths are; this module decides
 * whether each one is a real image, dedupes repeats of the same file, and
 * builds the replacement text. It is written against an injected `load`, so the
 * planning logic — candidate order, dedupe numbering, what happens when nothing
 * resolves — is tested without a filesystem, and the pi entry point supplies the
 * real one.
 */

import * as path from "node:path";
import { rewriteReferences, scanImageReferences, type ImageReference } from "./references.ts";

/** Refuse to inline a source file larger than this; leave its path as text. */
export const DEFAULT_MAX_SOURCE_BYTES = 32 * 1024 * 1024;
export const DEFAULT_MAX_IMAGES = 20;
export const DEFAULT_MAX_TOTAL_BYTES = 32 * 1024 * 1024;

/**
 * Structurally pi's `ImageContent`, which lives in `@earendil-works/pi-ai` and is
 * not re-exported by `@earendil-works/pi-coding-agent`. Extensions hand images
 * back through `InputEventResult`, so the shape has to match exactly; naming it
 * here keeps this plugin from depending on a package it does not otherwise use.
 */
export interface InlineImage {
	type: "image";
	data: string;
	mimeType: string;
}

export interface LoadedImage {
	mimeType: string;
	/** Base64, the form `ImageContent` carries. */
	base64: string;
}

export interface AttachEnv {
	cwd: string;
	home: string;
	tmpdir: string;
	/**
	 * Read `filePath` as an image, or `undefined` when it is missing, unreadable,
	 * too large, or not an image pi would accept. Must not throw.
	 */
	load(filePath: string): Promise<LoadedImage | undefined>;
}

export interface AttachResult {
	/** `text` with every attached reference replaced by its placeholder. */
	text: string;
	/** One entry per distinct image, in first-reference order. */
	images: InlineImage[];
	/** How many references were replaced; `0` means `text` is unchanged. */
	attached: number;
}

export function placeholder(index: number): string {
	return `[#image ${index}]`;
}

/**
 * Where a reference may point, in the order worth trying.
 *
 * A bare filename gets a second chance in the OS temp directory because that is
 * where pi's clipboard paste puts images — `pi-clipboard-<uuid>.png` still
 * resolves after the path was copied out of its directory.
 */
export function candidatePaths(
	expression: string,
	env: Pick<AttachEnv, "cwd" | "home" | "tmpdir">,
): string[] {
	const candidates: string[] = [];
	if (path.isAbsolute(expression)) {
		candidates.push(path.normalize(expression));
	} else if (expression === "~" || expression.startsWith(`~${path.sep}`) || expression.startsWith("~/")) {
		candidates.push(path.join(env.home, expression.slice(2)));
	} else {
		candidates.push(path.resolve(env.cwd, expression));
		if (/^pi-clipboard-[a-zA-Z0-9-]+\.(?:png|jpe?g|webp|gif|bmp)$/i.test(expression)) {
			candidates.push(path.join(env.tmpdir, expression));
		}
	}
	return [...new Set(candidates)];
}

async function loadSafely(env: AttachEnv, filePath: string): Promise<LoadedImage | undefined> {
	try {
		return await env.load(filePath);
	} catch {
		return undefined;
	}
}

/**
 * Replace every resolvable image reference with a numbered placeholder and
 * return the matching image content. Text with no resolvable reference comes
 * back byte-identical, so a prompt that merely mentions `.png` is untouched.
 */
export async function attachImageReferences(text: string, env: AttachEnv, existingImageCount = 0): Promise<AttachResult> {
	const references = scanImageReferences(text);
	if (references.length === 0) return { text, images: [], attached: 0 };

	const numbers = new Map<string, number>();
	const images: InlineImage[] = [];
	const replacements: Array<{ reference: ImageReference; placeholder: string }> = [];
	let totalBytes = 0;

	for (const reference of references) {
		if (existingImageCount + images.length >= DEFAULT_MAX_IMAGES) break;
		for (const candidate of candidatePaths(reference.expression, env)) {
			const loaded = await loadSafely(env, candidate);
			if (loaded === undefined) continue;
			let index = numbers.get(candidate);
			if (index === undefined) {
				const bytes = Math.floor(loaded.base64.length * 3 / 4) - (loaded.base64.endsWith("==") ? 2 : loaded.base64.endsWith("=") ? 1 : 0);
				if (totalBytes + bytes > DEFAULT_MAX_TOTAL_BYTES) break;
				totalBytes += bytes;
				index = existingImageCount + numbers.size + 1;
				numbers.set(candidate, index);
				images.push({ type: "image", data: loaded.base64, mimeType: loaded.mimeType });
			}
			replacements.push({ reference, placeholder: placeholder(index) });
			break;
		}
	}

	if (replacements.length === 0) return { text, images: [], attached: 0 };
	return { text: rewriteReferences(text, replacements), images, attached: replacements.length };
}
