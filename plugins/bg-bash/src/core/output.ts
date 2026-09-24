/**
 * A bounded tail buffer for live command output.
 *
 * A background job can emit unbounded output. The registry keeps only the tail
 * the model may need while the full stream still goes to the job's log file.
 * Trimming happens on whole lines, so the presentation layer can report how
 * many lines were dropped instead of silently losing them.
 */

/** Default retained tail. Four times pi's own tool-output cap (50 KB). */
export const DEFAULT_TAIL_BYTES = 256 * 1024;

export class TailBuffer {
	private buffer = "";
	// Tracked incrementally: re-measuring the whole buffer on every append is
	// quadratic for a chatty job.
	private bufferBytes = 0;
	private droppedBytes = 0;
	private droppedLines = 0;

	constructor(private readonly maxBytes = DEFAULT_TAIL_BYTES) {}

	append(chunk: string): void {
		if (!chunk) return;
		this.buffer += chunk;
		this.bufferBytes += Buffer.byteLength(chunk, "utf8");
		this.trim();
	}

	/** The retained tail. */
	text(): string {
		return this.buffer;
	}

	/** Bytes and lines discarded from the front so far. */
	dropped(): { bytes: number; lines: number } {
		return { bytes: this.droppedBytes, lines: this.droppedLines };
	}

	byteLength(): number {
		return this.bufferBytes;
	}

	private trim(): void {
		let remaining = this.bufferBytes;
		if (remaining <= this.maxBytes) return;

		let cut = 0;
		while (remaining > this.maxBytes) {
			const newline = this.buffer.indexOf("\n", cut);
			if (newline === -1) {
				// A single line larger than the cap: keep its last maxBytes bytes.
				const kept = tailByBytes(this.buffer.slice(cut), this.maxBytes);
				this.droppedBytes += remaining - Buffer.byteLength(kept, "utf8");
				cut = this.buffer.length - kept.length;
				remaining = Buffer.byteLength(kept, "utf8");
				break;
			}
			const lineBytes = Buffer.byteLength(this.buffer.slice(cut, newline + 1), "utf8");
			this.droppedBytes += lineBytes;
			this.droppedLines += 1;
			cut = newline + 1;
			remaining -= lineBytes;
		}

		this.buffer = this.buffer.slice(cut);
		this.bufferBytes = remaining;
	}
}

/** The last `maxBytes` bytes of `text`, cut on a code-point boundary. */
function tailByBytes(text: string, maxBytes: number): string {
	const total = Buffer.byteLength(text, "utf8");
	if (total <= maxBytes) return text;
	const overflow = total - maxBytes;
	let bytes = 0;
	let index = 0;
	while (index < text.length && bytes < overflow) {
		const code = text.codePointAt(index) ?? 0;
		const width = code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
		bytes += width;
		index += code > 0xffff ? 2 : 1;
	}
	return text.slice(index);
}
