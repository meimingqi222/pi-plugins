/**
 * pi-jev-compact — replace pi's compaction *summary* with a Jev pruned
 * transcript.
 *
 * pi's built-in compaction asks an LLM to rewrite old turns into a structured
 * summary. A summary is lossy: a file path, an exact error, or a constraint can
 * vanish even when it matters later. This extension never rewrites anything. It
 * asks Jev, for each tool call outside the pinned head/tail, whether the call
 * and its result are still needed, then keeps the survivors verbatim and
 * serializes them into the compaction summary.
 *
 * Architecture note: pi's `session_before_compact` can only return
 * `{ summary: string }`, not a replaced message list. So the pipeline is
 * prune → serialize, not prune → replace.
 *
 * Configuration (environment):
 *   TYPESAFE_API_KEY              required; the Jev/System One key
 *   JEV_COMPACT=false             disable this extension entirely
 *   JEV_COMPACT_MODEL             default "jev-latest"
 *   JEV_COMPACT_THRESHOLD         keep probability cutoff, default 0.5
 *   JEV_COMPACT_PRESERVE_RECENT   newest messages never touched, default 6
 *   JEV_COMPACT_TRUNCATE_HEAD     chars kept of a dropped result, default 300
 *   JEV_COMPACT_MAX_STATE_TOKENS  state window ceiling, default 28000
 *   JEV_COMPACT_MAX_REQUEST_TOKENS  state + questions ceiling, default 64000
 *   JEV_COMPACT_MAX_CONCURRENCY   simultaneous Jev requests, default 4
 *   JEV_COMPACT_BASE_URL          override the System One endpoint
 *   JEV_COMPACT_MIN_REDUCTION     below this ratio, fall back to pi, default 0.3
 */

import type { ExtensionAPI, SessionBeforeCompactEvent } from '@earendil-works/pi-coding-agent';

import { compact, reductionRatio, resolveOptions } from './jev/compact.ts';
import { JevClient } from './jev/client.ts';
import { DEFAULT_MODEL } from './jev/request.ts';
import { goalFromMessages } from './jev/state.ts';
import { withRetry } from './retry.ts';
import { installRedactBridge, withRedaction, type RedactBridge } from './redact.ts';
import type { CompactOptions, CompactStats } from './jev/types.ts';
import { normalizeDiscardedNotes, serializeEngineMessages, toEngineMessages, type PiMessage } from './pi-adapter.ts';

const PLUGIN_VERSION = '0.1.0';

/**
 * The framing a compaction summary is wrapped in when it is folded back in.
 *
 * pi wraps a stored summary in its own `COMPACTION_SUMMARY_PREFIX` when it
 * builds context, so this text is not what makes the model recognise a summary.
 * It is here so the summary is self-describing when read on its own, and so Jev
 * sees the same framing the built-in summarizer's output would have carried.
 *
 * The cost is that the framing becomes part of the *stored* summary, which is
 * what makes the next compaction delicate — see `stripCompactionFrame`.
 */
const COMPACTION_FRAME =
  'The conversation history before this point was compacted into the following summary:\n\n';

/** The role marker the serializer puts in front of user text. */
const USER_MARKER = '[User]: ';

/**
 * Removes framing this extension previously added, so folding a prior summary
 * back in is **idempotent**.
 *
 * `preparation.previousSummary` is the previous compaction's summary verbatim
 * (pi stores the string the handler returned, with no prefix of its own). That
 * summary is this extension's own serialized output, which already begins with
 * `[User]: ` plus the frame. Prepending both again nests them once per
 * compaction, without bound: a real session reached two nested frames by its
 * third Jev compaction, and each layer is pure overhead the model has to read.
 *
 * Only the **complete** unit (`[User]: ` immediately followed by the frame) is
 * stripped, never a bare marker, so the `[User]:` line that legitimately begins
 * a serialized transcript survives. The loop handles summaries written before
 * this fix, which may carry several layers.
 */
export function stripCompactionFrame(summary: string): string {
  const framed = `${USER_MARKER}${COMPACTION_FRAME}`;
  let text = summary;
  while (text.startsWith(framed)) text = text.slice(framed.length);
  return text;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

function envFlag(name: string, fallback: boolean): boolean {
  const value = process.env[name];
  if (value === undefined || value === '') return fallback;
  return value !== 'false' && value !== '0';
}

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function envProbability(name: string, fallback: number): number {
  return Math.min(1, Math.max(0, envNumber(name, fallback)));
}

/**
 * Reads the whole configuration from the environment **on each use**, not once
 * at import time.
 *
 * Two reasons. `/reload` re-runs the extension factory, so a value read at
 * module scope would go stale for the process lifetime; and a module-scope read
 * makes the extension untestable, because the environment cannot be changed
 * after the import graph is evaluated.
 */
function config() {
  return {
    enabled: envFlag('JEV_COMPACT', true),
    // Below this reduction the pass is not worth taking: it would replace pi's
    // rewritten summary with a near-identical verbatim transcript. Deferring to
    // pi is right there, because pi actually shrinks the text.
    //
    // The ratio is driven by how much of the input is *deletable* tool output,
    // because text is never touched. Measured with every result dropped:
    //
    //   undeletable text   tool share   ratio
    //        200,000 chars      16.7%     9.1%
    //        100,000 chars      44.4%    28.4%
    //         50,000 chars      61.5%    43.9%
    //         20,000 chars      80.0%    65.1%
    //
    // So a text-dominated input (typically a second compaction, where
    // `previousSummary` is folded in as pure user text) lands below the
    // threshold and defers to pi, while a tool-output-dominated session clears
    // it. 0.3 is the line between the two: it admits a session that is at least
    // roughly half deletable output.
    //
    // Jev's answers are sharply bimodal in practice — across 354 real decisions
    // the median `keepResult` was 0.140 and the maximum 0.200, none reaching the
    // 0.5 keep cutoff — so in practice the ratio is set by the input's
    // composition rather than by Jev's judgement. The threshold is therefore
    // best read as "is there enough deletable output here to be worth it".
    minReduction: envProbability('JEV_COMPACT_MIN_REDUCTION', 0.3),
    maxAttempts: Math.max(1, Math.floor(envNumber('JEV_COMPACT_MAX_ATTEMPTS', 4))),
    retryBaseMs: envNumber('JEV_COMPACT_RETRY_BASE_MS', 300),
    model: process.env.JEV_COMPACT_MODEL || DEFAULT_MODEL,
    baseUrl: process.env.JEV_COMPACT_BASE_URL,
    options: {
      keepThreshold: envProbability('JEV_COMPACT_THRESHOLD', 0.5),
      preserveRecentMessages: envNumber('JEV_COMPACT_PRESERVE_RECENT', 6),
      // A *window* size, not a whole-conversation budget: `chunkState` splits a
      // long session into several windows of at most this size, so the number can
      // sit near Jev's real ceiling (32k for state plus the longest question)
      // instead of being squeezed to leave room for a whole conversation.
      maxStateTokens: envNumber('JEV_COMPACT_MAX_STATE_TOKENS', 28_000),
      maxRequestTokens: envNumber('JEV_COMPACT_MAX_REQUEST_TOKENS', 64_000),
      maxConcurrentRequests: envNumber('JEV_COMPACT_MAX_CONCURRENCY', 4),
      truncateHeadChars: envNumber('JEV_COMPACT_TRUNCATE_HEAD', 300),
    } satisfies CompactOptions,
  };
}

/**
 * Resolves the API key from the environment.
 *
 * Called at the point of use rather than cached from `session_start`, so the
 * compaction hook works even if the session-start event has not fired (and so
 * `/reload` picks up a changed value). Only the environment is consulted — see
 * the note in `session_start` for why `auth.json` is not an option.
 *
 * Whitespace is stripped. An API key pasted into `setx` (or a shell heredoc)
 * can pick up a trailing newline or a wrapped line, and a newline inside an
 * HTTP header makes the whole request throw before it is sent:
 *
 *   Header '14' has invalid value: 'Bearer apikey_...\n...'
 *
 * That message names no cause, so the useful failure is a warning here naming
 * the actual problem. A real key never contains whitespace, so stripping is
 * safe and cannot mask a different mistake.
 */
function resolveApiKey(): string | undefined {
  const raw = process.env.TYPESAFE_API_KEY;
  if (!raw) return undefined;
  const cleaned = raw.replace(/\s+/g, '');
  return cleaned.length > 0 ? cleaned : undefined;
}

/**
 * True when the configured key had to be repaired, so the user can be told
 * once at startup rather than discovering it from a confusing 401 later.
 */
function apiKeyHasWhitespace(): boolean {
  const raw = process.env.TYPESAFE_API_KEY;
  return typeof raw === 'string' && raw.length > 0 && /\s/.test(raw);
}

/**
 * The warning for a repaired key.
 *
 * Deliberately does not tell the user to re-set the variable, because the
 * common cause is not a bad value: a process that started before the variable
 * was fixed keeps the old value for its whole lifetime, so the warning can fire
 * while the stored value is already correct. Saying "re-set it" sends the user
 * to check a variable that is fine. The wording therefore reports what was
 * observed and offers both readings.
 */
function whitespaceWarning(): string {
  return (
    'jev-compact: TYPESAFE_API_KEY contains whitespace (a stray newline or a wrapped ' +
    'line). It is trimmed for this request, so compaction still works. If this ' +
    'repeats, the stored value needs fixing; if it appears once after editing the ' +
    'variable, this process simply still holds the old value and a restart clears it.'
  );
}

/**
 * A Jev asker that retries transport faults and redacts the outbound payload.
 *
 * Needed because a Jev request was observed failing with `unknown certificate
 * verification error` while eight immediate repeats all succeeded. Without this
 * wrapper a single TLS blip makes `compact()` throw and the plugin silently
 * falls back to pi's summary, so a network hiccup downgrades the quality of the
 * next context window instead of merely delaying it.
 *
 * Redaction wraps the retrying asker (not the reverse), so every attempt reuses
 * the one redacted payload: re-redacting a large state per retry is wasted
 * work, and re-reading the raw input on a retry would make that the single
 * request that leaks. When pi-redact is not loaded the asker is returned
 * unchanged, so this plugin still works standalone.
 */
function createAsker(
  bridge: RedactBridge,
  onRetry: (info: { attempt: number; delayMs: number; error: Error }) => void,
) {
  const cfg = config();
  const retrying = withRetry(
    new JevClient({ apiKey: resolveApiKey(), model: cfg.model, baseUrl: cfg.baseUrl }),
    { maxAttempts: cfg.maxAttempts, baseDelayMs: cfg.retryBaseMs, onRetry },
  );
  return withRedaction(retrying, bridge);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatTokens(n: number): string {
  return n.toLocaleString('en-US');
}

/** One line summarizing what the prune did, for the compaction details. */
function formatStats(stats: CompactStats): string {
  const discarded = stats.callsDropped;
  const truncated = stats.resultsDropped;
  const parts = [
    `${stats.calls} tool calls`,
    `${stats.kept} kept`,
    `${discarded} outputs discarded (calls retained as traces)`,
    `${truncated} results truncated`,
  ];
  return parts.join(', ');
}

function formatNotice(stats: CompactStats, ratio: number): string {
  const keptChars = stats.charsAfter;
  const beforeChars = stats.charsBefore;
  const windows = stats.chunks > 1 ? `, ${stats.chunks} windows` : '';
  return (
    `Jev compact: ${formatStats(stats)} — ` +
    `${formatTokens(beforeChars)}→${formatTokens(keptChars)} chars ` +
    `(${Math.round(ratio * 100)}% removed, ${stats.requests} request${stats.requests === 1 ? '' : 's'}${windows}, ${stats.ms}ms)`
  );
}

/** Reads the compaction summary text for the Jev-pruned history. */
function buildSummaryText(pruned: ReturnType<typeof toEngineMessages>): string {
  return serializeEngineMessages(pruned);
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function jevCompact(pi: ExtensionAPI): void {
  if (!config().enabled) return;

  // Subscribed before any hook can run, so a compaction in the very first turn
  // still sees pi-redact whether it loaded before or after this plugin.
  const bridge = installRedactBridge(pi);

  pi.on('session_start', async (_event, ctx) => {
    // Read the key from the environment on every session start, so `/reload`
    // picks up a change.
    //
    // Only the environment is consulted, on purpose. `getApiKeyForProvider` is
    // not an option: it resolves through the model registry, which returns
    // `undefined` for any provider id that is not a registered model provider,
    // so a "typesafe" entry in `auth.json` would never be found. Documenting
    // that as a fallback would be a promise the code cannot keep.
    if (!resolveApiKey()) {
      ctx.ui.notify(
        'jev-compact: TYPESAFE_API_KEY is not set — compaction will use pi defaults. ' +
          'Export it before starting pi (setx on Windows), then restart.',
        'warning',
      );
      return;
    }
    if (apiKeyHasWhitespace()) {
      ctx.ui.notify(whitespaceWarning(), 'warning');
    }
    const cfg = config();
    ctx.ui.notify(
      `Jev compact v${PLUGIN_VERSION} loaded (threshold ${cfg.options.keepThreshold}, keep recent ${cfg.options.preserveRecentMessages})`,
      'info',
    );
    // Redaction of the outbound Jev payload depends on pi-redact being loaded.
    // Say so plainly: a user who installed it expecting that protection should
    // not have to infer its absence from an unchanged startup line.
    ctx.ui.notify(
      bridge.active
        ? 'Jev compact: pi-redact detected — Jev payloads are redacted before upload'
        : 'Jev compact: pi-redact not detected — Jev payloads are sent unredacted',
      bridge.active ? 'info' : 'warning',
    );
  });

  pi.on('session_before_compact', async (event: SessionBeforeCompactEvent, ctx) => {
    if (!resolveApiKey()) return;

    const { preparation, signal, customInstructions } = event;
    const { messagesToSummarize, turnPrefixMessages, firstKeptEntryId, tokensBefore } =
      preparation;

    // A second compaction does NOT receive the older history: pi excludes
    // everything before the previous compaction's firstKeptEntryId, and hands
    // the earlier summary back as `previousSummary` instead. Folding it back in
    // as the first message is the only way it survives — and it must be a place
    // Jev can see it, because it is pure text that Jev will never drop.
    //
    // The framing is stripped first because the prior summary is our own
    // serialized output and already carries it; re-adding it verbatim nests one
    // more layer every compaction.
    const allMessages = [
      ...(preparation.previousSummary
        ? [
            {
              role: 'user',
              content: [
                {
                  type: 'text',
                  text:
                    COMPACTION_FRAME +
                    normalizeDiscardedNotes(stripCompactionFrame(preparation.previousSummary)),
                },
              ],
            } satisfies PiMessage,
          ]
        : []),
      ...messagesToSummarize,
      ...turnPrefixMessages,
    ] as PiMessage[];
    if (allMessages.length === 0) return;

    const engineMessages = toEngineMessages(allMessages);
    if (engineMessages.length === 0) return;

    const cfg = config();
    const options = resolveOptions(cfg.options);
    const inferredGoal = options.goal || goalFromMessages(engineMessages);
    const focus = customInstructions?.trim();
    const goal = focus
      ? `${inferredGoal}\nAdditional compaction focus: ${focus}`
      : inferredGoal;

    try {
      const started = Date.now();
      const client = createAsker(bridge, ({ attempt, delayMs, error }) => {
        ctx.ui.notify(
          `Jev compact: ${error.message.slice(0, 80)} — retrying (${attempt}/${cfg.maxAttempts}) in ${delayMs}ms`,
          'info',
        );
      });
      const result = await compact(engineMessages, client, {
        ...options,
        goal,
        // pi hands a signal per compaction. Passing it through lets a cancel stop
        // the in-flight requests instead of letting every window (each carrying a
        // full state) run to completion for a result that will be discarded.
        signal,
      });

      if (signal.aborted) return;

      const ratio = reductionRatio(result);
      // Nothing worth reporting: let pi's own summary handle it. Compacting
      // without removing enough just trades a good summary for a worse one.
      if (ratio < cfg.minReduction) {
        ctx.ui.notify(
          `Jev compact: only ${Math.round(ratio * 100)}% removable, using pi's summary instead`,
          'info',
        );
        return;
      }

      const summary = buildSummaryText(result.messages);
      if (!summary.trim()) return;

      ctx.ui.notify(formatNotice(result.stats, ratio), 'info');

      return {
        compaction: {
          summary,
          firstKeptEntryId,
          tokensBefore,
          details: {
            provider: 'jev-compact',
            version: PLUGIN_VERSION,
            model: process.env.JEV_COMPACT_MODEL || DEFAULT_MODEL,
            reductionRatio: ratio,
            stats: result.stats,
            decisions: result.decisions,
            elapsedMs: Date.now() - started,
          },
        },
      };
    } catch (err) {
      const error = err as Error;
      ctx.ui.notify(
        `Jev compact failed: ${error.message}. Using pi's default summary.`,
        'warning',
      );
      // undefined → pi falls back to its own summarization
      return;
    }
  });
}
