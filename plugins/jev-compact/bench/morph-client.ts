/**
 * Minimal client for Morph's Compact API, used only by the comparison bench.
 *
 * Deliberately mirrors what `pi-morph-plugin` sends (same endpoint, same
 * `compression_ratio` default of 0.3, same `preserve_recent` of 1) so the
 * head-to-head is against the real deployed configuration, not a straw man.
 */

const MORPH_URL = 'https://api.morphllm.com/v1/compact';
const DEFAULT_MODEL = 'morph-compactor';

export interface MorphMessage {
  role: string;
  content: string;
}

export interface MorphCompactOptions {
  /** Defaults to `process.env.MORPH_API_KEY`. */
  apiKey?: string;
  model?: string;
  /** Default 0.3, matching pi-morph-plugin. */
  compressionRatio?: number;
  /** Default 1, matching pi-morph-plugin. */
  preserveRecent?: number;
  fetch?: typeof fetch;
}

export interface MorphCompactResult {
  output: string;
  /** Per-message results when the API returns them. */
  messages?: Array<{ role: string; content: string; compacted_line_ranges?: unknown }>;
}

export async function morphCompact(
  messages: readonly MorphMessage[],
  options: MorphCompactOptions = {},
): Promise<MorphCompactResult> {
  const apiKey = options.apiKey ?? process.env.MORPH_API_KEY ?? '';
  if (!apiKey) throw new Error('MORPH_API_KEY is not configured');
  const fetcher = options.fetch ?? fetch;

  const response = await fetcher(MORPH_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      messages,
      compression_ratio: options.compressionRatio ?? 0.3,
      preserve_recent: options.preserveRecent ?? 1,
      model: options.model ?? DEFAULT_MODEL,
      include_line_ranges: true,
      include_markers: true,
    }),
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Morph compaction failed (${response.status}): ${text.slice(0, 200)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('Morph returned malformed JSON');
  }
  const body = parsed as { output?: string; messages?: MorphCompactResult['messages'] };
  return { output: body.output ?? '', messages: body.messages };
}
