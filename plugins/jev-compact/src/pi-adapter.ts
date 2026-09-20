/**
 * Translates between pi's message shape and the backend-agnostic `Message`
 * shape the Jev engine works on, and renders the surviving messages back to
 * text for pi's compaction summary.
 *
 * Why a text round-trip: pi's `session_before_compact` can only return a
 * `summary: string` (see `CompactionResult`), not a replaced message list. So
 * the Jev strategy is applied as *prune, then serialize verbatim* — the text
 * of everything Jev kept is reproduced exactly, and only stale tool calls and
 * results are gone. Nothing is summarized or reworded.
 *
 * Which pi messages carry text (from pi's own `convertToLlm`):
 *   - `user`             → string or (TextContent|ImageContent)[]
 *   - `assistant`        → (TextContent|ThinkingContent|ToolCall)[]
 *   - `toolResult`       → (TextContent|ImageContent)[] + toolCallId/toolName
 *   - `bashExecution`    → a `!command` run; becomes user text
 *   - `custom`           → extension message; becomes user text
 *   - `branchSummary`    → a prior branch summary; becomes user text
 *   - `compactionSummary`→ a prior compaction summary; becomes user text
 *
 * All of those except `toolResult` are pure text as far as this engine is
 * concerned, so all of them are folded into the user-text channel. Omitting any
 * of them would silently delete context that pi's own summarizer would have
 * kept — the exact failure mode this plugin exists to prevent.
 *
 * A `ToolCall` block carries no result text — the result lives in a later
 * `toolResult` message — so they are paired by id before handing the engine a
 * transcript it can reason about. The paired result is attached to the
 * assistant message twice: as `toolUses[].text` (what `serializeEngineMessages`
 * renders) and as a `toolResults` entry (what `collectToolCalls` pairs on and
 * `messageChars` measures). Both are needed; dropping either silently disables
 * compaction.
 */

import {
  DISCARDED_MARKER,
  renderTraceArgs,
  serializeEngineMessages,
  serializedChars,
} from './serialize.ts';
import type { Message, ToolResult, ToolUse } from './jev/types.ts';

// The serializer lives in `serialize.ts` beside the size accounting that has to
// agree with it, and is re-exported here because this is where pi's adapter
// boundary is. Keeping the two apart is what let them drift.
export {
  DISCARDED_MARKER,
  normalizeDiscardedNotes,
  renderTraceArgs,
  serializeEngineMessages,
  serializedChars,
} from './serialize.ts';

/** The subset of pi's message shape this adapter touches. */
export interface PiContentBlock {
  type: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  arguments?: Record<string, unknown>;
  data?: string;
  mimeType?: string;
}

export interface PiMessage {
  role: string;
  content?: string | PiContentBlock[];
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  /** `branchSummary` / `compactionSummary` carry their body here, not in `content`. */
  summary?: string;
  /** `bashExecution` carries the command and its output. */
  command?: string;
  output?: string;
  /** When true, pi itself excludes the message from context. */
  excludeFromContext?: boolean;
}

function textOf(content: string | PiContentBlock[] | undefined): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
  }
  return parts.join('\n');
}

/** Renders a tool result's content as text, noting images instead of inlining them. */
function resultTextOf(content: string | PiContentBlock[] | undefined): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
    else if (block.type === 'image') parts.push('[image]');
  }
  return parts.join('\n');
}

/**
 * Converts a pi transcript into engine messages.
 *
 * A `toolResult` row is folded into the assistant message that made the call,
 * because `applyDecisions` only knows how to rewrite a call's own `ToolUse`.
 * Only `user`/`assistant` rows survive as top-level entries; the rest
 * (`custom`, `bashExecution`, ...) are outside the engine's model, so they are
 * neither candidates nor dropped.
 *
 * The engine decides what to delete; the caller keeps the original pi messages
 * and renders the pruned view separately, so this is a projection, not a
 * mutation.
 */
export function toEngineMessages(messages: readonly PiMessage[]): Message[] {
  const results = new Map<string, { text: string; isError: boolean }>();
  for (const message of messages) {
    if (message.role === 'toolResult' && message.toolCallId) {
      results.set(message.toolCallId, {
        text: resultTextOf(message.content),
        isError: message.isError === true,
      });
    }
  }

  const out: Message[] = [];
  for (const message of messages) {
    if (message.role === 'user') {
      const text = textOf(message.content);
      if (text.trim().length === 0) continue;
      out.push({ role: 'user', text, toolUses: [] });
      continue;
    }
    // A tool result is folded onto the call that produced it, below. It must
    // NOT also fall through to the generic text path, or every tool output would
    // appear twice: once as `[Tool result]:` and again as `[User]:`.
    if (message.role === 'toolResult') continue;
    if (message.role === 'assistant') {
      const blocks = Array.isArray(message.content) ? message.content : [];
      const toolUses: ToolUse[] = [];
      const toolResults: ToolResult[] = [];
      for (const block of blocks) {
        if (block.type !== 'toolCall' || typeof block.id !== 'string') continue;
        const result = results.get(block.id);
        const use: ToolUse = {
          tool_use_id: block.id,
          tool: typeof block.name === 'string' ? block.name : 'unknown',
          input: block.arguments ?? {},
        };
        if (result) {
          use.text = result.text;
          if (result.isError) use.isError = true;
          const paired: ToolResult = { tool_use_id: block.id, text: result.text };
          if (result.isError) paired.isError = true;
          toolResults.push(paired);
        }
        toolUses.push(use);
      }
      const text = textOf(message.content);
      if (text.trim().length === 0 && toolUses.length === 0) continue;
      const entry: Message = { role: 'assistant', text, toolUses };
      if (toolResults.length > 0) entry.toolResults = toolResults;
      out.push(entry);
      continue;
    }

    // Every remaining role is pure text as far as the engine is concerned.
    // pi's own `convertToLlm` maps all of them onto the user-text channel, so
    // they are folded in here rather than dropped.
    const text = otherRoleText(message);
    if (text !== undefined && text.trim().length > 0) {
      out.push({ role: 'user', text, toolUses: [] });
    }
  }
  return out;
}

/**
 * Extracts the text of a non-user/assistant/toolResult message the way pi's
 * `convertToLlm` does. Returns undefined when pi itself excludes the message
 * from context (an `excludeFromContext` bash execution), which must stay out.
 */
function otherRoleText(message: PiMessage): string | undefined {
  switch (message.role) {
    case 'bashExecution': {
      if (message.excludeFromContext) return undefined;
      const command = typeof message.command === 'string' ? message.command : '';
      const output = typeof message.output === 'string' ? message.output : '';
      const body = [command && `$ ${command}`, output].filter(Boolean).join('\n');
      return body.length > 0 ? body : undefined;
    }
    case 'custom':
      // `content` may be a string or content blocks.
      return textOf(message.content) || undefined;
    case 'branchSummary':
    case 'compactionSummary':
      return typeof message.summary === 'string' && message.summary.length > 0
        ? message.summary
        : undefined;
    default:
      // Unknown/custom app message with usable text: keep it rather than drop
      // it, since dropping is the failure mode this plugin exists to avoid.
      return textOf(message.content) || undefined;
  }
}

// The transcript renderer (`serializeEngineMessages`) and the trace renderer it
// uses (`renderTraceArgs`) live in `serialize.ts`, re-exported above.

