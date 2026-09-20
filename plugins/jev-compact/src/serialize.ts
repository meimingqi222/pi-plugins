/**
 * Rendering a pruned transcript to text, and measuring that same text.
 *
 * These two live together on purpose. The reduction ratio decides whether a
 * compaction is worth using at all (`JEV_COMPACT_MIN_REDUCTION`), so it has to
 * describe the string that will actually be produced — not an approximation of
 * it. Keeping the renderer and the measurement in separate modules let them
 * drift: the size accounting omitted the serializer's markers and separators
 * and measured kept calls with `JSON.stringify(input)` where the renderer emits
 * `key=value`, overstating a real session's ratio by ~4 points (80.9% reported
 * against 76.9% actual). A threshold near that error would flip the decision.
 *
 * `serializedChars` therefore calls the renderer instead of mirroring it, and
 * exactness is structural rather than maintained by hand.
 */

import type { Message } from './jev/types.ts';

/**
 * Bounds on a discarded call's trace arguments.
 *
 * A trace is not the same size as the call it stands in for: `write` and `edit`
 * carry the **whole file body** in their input, so rendering the arguments in
 * full reproduces exactly the bytes that were just discarded. Measured on a real
 * session, unbounded traces took 489 KB — 59% of the summary — with `write`
 * calls up to 14 KB each.
 *
 * Per value, then per call: the first cuts a single large argument, the second
 * stops one giant call from dominating several.
 */
export const TRACE_ARG_CHARS = 200;
export const TRACE_TOTAL_CHARS = 600;

/** `key=value`, matching pi's own `serializeConversation` rendering. */
function renderArgValue(value: unknown): string {
  try {
    return JSON.stringify(value) ?? 'undefined';
  } catch {
    return '"[unserializable]"';
  }
}

/** Full argument rendering, as a **kept** call emits. */
export function renderArgs(args: Record<string, unknown>): string {
  return Object.entries(args)
    .map(([key, value]) => `${key}=${renderArgValue(value)}`)
    .join(', ');
}

/**
 * The marker appended to a discarded call's own line.
 *
 * A discarded call used to render as **two** parts — the call line, then a
 * separate `[Tool result]: (output discarded …)` note — which duplicated the
 * call line's identity and cost ~74 chars per call. Measured on a real session,
 * 330 such notes were 11% of the summary, and because they are text they were
 * inherited unchanged by every later compaction (259 of the 330 came from
 * earlier summaries), projecting to 59% of the summary after 20 compactions.
 *
 * Folding the note into the call line removes the duplicate category: the
 * marker rides on a line that has to exist anyway, and it keeps the per-call
 * fact — a call with the marker had output that was discarded, a call with no
 * `[Tool result]` line after it produced none. The call already names the tool,
 * so the note no longer repeats it.
 *
 * Merging *runs* of discarded calls into `(N calls omitted)` was measured and
 * rejected: consecutive dropped calls average 1.34 in length (244 runs for 326
 * calls, longest 6), so aggregation saved less than inlining while losing the
 * per-call marker.
 */
export const DISCARDED_MARKER = ' [output discarded; re-run to restore]';

/** The exact `[Tool result]:` note the pre-0.2 renderer emitted for a drop. */
const LEGACY_DISCARD_NOTE =
  /^\[Tool result\]: \(output discarded by compaction; re-run `([a-z_]+)` if needed\)$/;

/** The tool name a serialized call line names. */
const CALL_LINE_TOOL = /^\[Assistant tool calls\]: ([a-z_]+)\(/;

/**
 * Rewrites discard notes inherited from earlier versions into the inline marker.
 *
 * Older versions rendered a discarded call as **two** parts — the call line,
 * then a `[Tool result]: (output discarded …)` note. That note is text, so Jev
 * never deletes it and every later compaction copied it forward at full size: a
 * real summary carried 328 of them (24 KB, 11%), 259 inherited rather than
 * produced by the current pass. The current renderer appends `DISCARDED_MARKER`
 * to the call's own line instead, which stops new growth, but the accumulated
 * ones stay because `previousSummary` is copied verbatim.
 *
 * Only the **exact** note part is rewritten, and only when the part before it is
 * a call line naming the same tool. Anything else is left alone: a kept result
 * whose text merely contains the phrase is not a part equal to the note, and a
 * note that does not follow its own call cannot be safely merged. The
 * transformation is lossless — the tool name the note repeated is already on the
 * call line — and idempotent, because the marker is not the note.
 *
 * Parts are matched after trimming leading newlines. A kept result whose text
 * ends in `\n` produces a `\n\n\n` run at the part boundary, so the following
 * part starts with one: `split('\n\n')` turns `"A\n\n\nB"` into `["A", "\nB"]`.
 * The leading whitespace is left on the call line rather than trimmed, so
 * rejoining reproduces the original bytes exactly.
 */
export function normalizeDiscardedNotes(summary: string): string {
  if (!summary.includes('(output discarded by compaction')) return summary;
  const parts = summary.split('\n\n');
  const out: string[] = [];
  for (const part of parts) {
    const note = LEGACY_DISCARD_NOTE.exec(part.trimStart());
    const previous = out[out.length - 1];
    if (note && previous !== undefined && !previous.includes(DISCARDED_MARKER)) {
      const call = CALL_LINE_TOOL.exec(previous.trimStart());
      if (call !== null && call[1] === note[1]) {
        out[out.length - 1] = previous + DISCARDED_MARKER;
        continue;
      }
    }
    out.push(part);
  }
  return out.join('\n\n');
}

/**
 * Characters a call occupies once kept: full arguments plus its whole output.
 *
 * Compared against `droppedCallChars` to decide whether discarding is worth
 * it. The markers (`[Assistant tool calls]: `) are identical in both cases, so
 * they are left out; only the difference matters.
 */
export function keptCallChars(
  input: Record<string, unknown>,
  resultChars: number,
): number {
  return renderArgs(input).length + resultChars;
}

/**
 * Characters a call occupies once its output is discarded: clipped trace
 * arguments plus the marker appended to the call's own line.
 *
 * Discarding is **not** always smaller. The marker is 37 chars, so a call whose
 * output is shorter than that grows the transcript when dropped — measured at
 * +47 chars for a 10-char output under the old two-line note. Jev answers "is
 * this still needed", not "is this bigger than the marker", so the caller has
 * to check.
 */
export function droppedCallChars(input: Record<string, unknown>): number {
  return renderTraceArgs(input).length + DISCARDED_MARKER.length;
}

/**
 * Renders a discarded call's arguments for a trace: the same shape as a full
 * rendering, but every value is clipped so the trace stays a pointer rather
 * than a copy.
 *
 * Values are clipped individually rather than clipping the rendered string, so
 * **keys always survive**. That matters because the key is what carries the
 * identifying fact — `path=...` for `read`/`write`, `command=...` for `bash` —
 * and a naive prefix cut would keep `content="…"` and lose the path.
 */
export function renderTraceArgs(args: Record<string, unknown>): string {
  const parts: string[] = [];
  let used = 0;
  for (const [key, value] of Object.entries(args)) {
    const rendered = renderArgValue(value);
    const clipped =
      rendered.length > TRACE_ARG_CHARS
        ? `${rendered.slice(0, TRACE_ARG_CHARS)}…(${rendered.length - TRACE_ARG_CHARS} more)`
        : rendered;
    const piece = `${key}=${clipped}`;
    if (used + piece.length > TRACE_TOTAL_CHARS && parts.length > 0) {
      parts.push('…');
      break;
    }
    parts.push(piece);
    used += piece.length;
  }
  return parts.join(', ');
}

/**
 * Renders the pruned transcript as text for pi's compaction summary.
 *
 * Markers match pi's built-in `serializeConversation` (`[User]:`,
 * `[Assistant]:`, `[Assistant tool calls]:`, `[Tool result]:`) so the model
 * reads a familiar format — but kept tool results are **not** truncated. That
 * is the point: a result Jev decided to keep must survive intact, whereas pi's
 * own serializer clips every result at 2000 chars regardless of value.
 *
 * A discarded call emits only its own line, suffixed with `DISCARDED_MARKER`.
 * It does **not** emit a `[Tool result]:` part: that line is what tells the
 * reader an output is still available, so omitting it is the signal that the
 * output is gone.
 */
export function serializeEngineMessages(messages: readonly Message[]): string {
  const parts: string[] = [];
  for (const message of messages) {
    if (message.role === 'user') {
      if (message.text.trim().length > 0) parts.push(`[User]: ${message.text}`);
      continue;
    }
    if (message.text.trim().length > 0) parts.push(`[Assistant]: ${message.text}`);
    for (const tool of message.toolUses) {
      // A discarded call renders clipped arguments; a kept call renders them in
      // full, because its output is kept too and the pair must stay consistent.
      const args = tool.removed ? renderTraceArgs(tool.input) : renderArgs(tool.input);
      const line = `[Assistant tool calls]: ${tool.tool}(${args})`;
      // The discard marker is part of the call's own line rather than a second
      // `[Tool result]:` part, so it does not become a separate category that
      // every later compaction inherits at full size. See `DISCARDED_MARKER`.
      parts.push(tool.removed ? `${line}${DISCARDED_MARKER}` : line);
      if (tool.removed) continue;
      if (tool.text !== undefined && tool.text.length > 0) {
        parts.push(`[Tool result]: ${tool.text}`);
      }
    }
  }
  return parts.join('\n\n');
}

/**
 * Characters the transcript occupies once serialized — the number the reduction
 * ratio must be computed against.
 *
 * Delegates to the renderer rather than reimplementing it, so the measurement
 * cannot disagree with the output it describes.
 */
export function serializedChars(messages: readonly Message[]): number {
  return serializeEngineMessages(messages).length;
}
