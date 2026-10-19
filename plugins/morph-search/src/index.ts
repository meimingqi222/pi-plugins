import { Type } from "typebox";
import { WarpGrepClient, type WarpGrepResult } from "@morphllm/morphsdk";
import {
  convertToLlm,
  truncateHead,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { loadConfig, type MorphSearchConfig } from "./config.ts";
import { installRedactBridge } from "./redact.ts";
import { compactWithSignal } from "./compact.ts";

const githubRepo = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export function resolveGitHubRepo(ownerRepo?: string, githubUrl?: string): string {
  if (Boolean(ownerRepo) === Boolean(githubUrl)) throw new Error("Provide exactly one of owner_repo or github_url");
  let repo = ownerRepo?.trim();
  if (githubUrl) {
    const url = new URL(githubUrl);
    if (url.protocol !== "https:" || url.hostname !== "github.com" || url.search || url.hash) {
      throw new Error("github_url must be an https://github.com/owner/repo URL");
    }
    repo = url.pathname.replace(/^\//, "").replace(/\/$/, "").replace(/\.git$/, "");
  }
  if (!repo || !githubRepo.test(repo) || repo.includes("..")) throw new Error("Invalid GitHub owner/repo");
  return repo;
}

export function formatResults(result: WarpGrepResult): string {
  if (!result.success) throw new Error(result.error || "Morph search failed");
  const contexts = result.contexts ?? [];
  if (contexts.length === 0) return "No relevant code found.";
  return contexts.map((context) => {
    const lines = context.lines && context.lines !== "*"
      ? ` lines="${context.lines.map(([start, end]) => `${start}-${end}`).join(",")}"`
      : "";
    return `<file path="${context.file}"${lines}>\n${context.content}\n</file>`;
  }).join("\n\n");
}

/** The subset of pi's LLM message shape this converter reads. */
interface ContentBlock {
  type: string;
  text?: string;
  thinking?: string;
  name?: string;
  arguments?: Record<string, unknown>;
}
type LlmMessage =
  | { role: "user"; content: string | ContentBlock[] }
  | { role: "assistant"; content: ContentBlock[] }
  | { role: "toolResult"; content: ContentBlock[] };

const TOOL_RESULT_MAX_CHARS = 2000;

function textOf(content: string | ContentBlock[]): string {
  if (typeof content === "string") return content;
  return content
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text!)
    .join("\n");
}

function truncateToolResult(text: string): string {
  if (text.length <= TOOL_RESULT_MAX_CHARS) return text;
  return `${text.slice(0, TOOL_RESULT_MAX_CHARS)}\n\n[... ${text.length - TOOL_RESULT_MAX_CHARS} more characters truncated]`;
}

/**
 * Convert pi's structured messages to the role/text pairs Morph's compaction
 * endpoint expects.
 *
 * This replaces a round-trip through `serializeConversation` followed by a
 * line-prefix parser. The parser treated any line in a tool result that began
 * with `[User]:` (or another marker) as a fresh message with a caller-chosen
 * role — a prompt-injection primitive that survived compaction by
 * construction. Reading the structured messages removes the ambiguity: a tool
 * result is always one `tool` message, whatever its body contains.
 */
export function compactMessages(messages: readonly LlmMessage[]): Array<{ role: string; content: string }> {
  const out: Array<{ role: string; content: string }> = [];
  for (const message of messages) {
    if (message.role === "user") {
      const text = textOf(message.content);
      if (text.trim()) out.push({ role: "user", content: text });
      continue;
    }
    if (message.role === "assistant") {
      const thinking = message.content
        .filter((block) => block.type === "thinking" && typeof block.thinking === "string")
        .map((block) => block.thinking!)
        .join("\n");
      const text = textOf(message.content);
      const calls = message.content
        .filter((block) => block.type === "toolCall")
        .map((block) => {
          const args = block.arguments ?? {};
          const rendered = Object.entries(args)
            .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
            .join(", ");
          return `${block.name ?? "tool"}(${rendered})`;
        })
        .join("; ");
      // One message per section, matching what the parser produced before.
      if (thinking.trim()) out.push({ role: "assistant", content: thinking });
      if (text.trim()) out.push({ role: "assistant", content: text });
      if (calls) out.push({ role: "assistant", content: calls });
      continue;
    }
    if (message.role === "toolResult") {
      const text = textOf(message.content);
      if (text.trim()) out.push({ role: "tool", content: truncateToolResult(text) });
    }
  }
  return out;
}

/**
 * Upstream-compatible entry point: accept pi's AgentMessage[] and convert.
 * The conversion itself lives in `compactMessages`, which the tests exercise
 * directly with LLM-shaped messages.
 */
export function compactMessagesFromPi(input: Parameters<typeof convertToLlm>[0]): Array<{ role: string; content: string }> {
  return compactMessages(convertToLlm(input) as LlmMessage[]);
}

export default function morphSearch(pi: ExtensionAPI): void {
  // Config is loaded at registration; /reload applies changes without a process restart.
  let config: MorphSearchConfig | undefined;
  let configError: unknown;
  try { config = loadConfig(); } catch (error) { configError = error; }
  if (configError) {
    pi.on("session_start", (_event, ctx) => ctx.ui.notify(`Morph search configuration error: ${String(configError)}`, "warning"));
  }
  const client = () => {
    if (!config) throw configError;
    if (!config.apiKey) throw new Error("Morph apiKey is missing in ~/.pi/agent/morph-search.json");
    return new WarpGrepClient({ morphApiKey: config.apiKey, morphApiUrl: config.baseUrl, timeout: config.searchTimeoutMs });
  };
  const output = (result: WarpGrepResult, prefix = "") => {
    const formatted = truncateHead(prefix + formatResults(result), { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
    return { content: [{ type: "text" as const, text: formatted.content + (formatted.truncated ? "\n[Output truncated]" : "") }], details: { contextCount: result.contexts?.length ?? 0 } };
  };

  pi.registerTool({
    name: "warpgrep_codebase_search",
    label: "Morph Codebase Search",
    description: "Search the current local codebase by intent. Use rg for exact names and verify results by reading source files.",
    promptSnippet: "Search local code by intent with Morph WarpGrep",
    promptGuidelines: ["Use warpgrep_codebase_search for exploratory local code questions; use rg for exact identifiers."],
    parameters: Type.Object({ search_term: Type.String() }),
    async execute(_id, params, signal, _update, ctx) {
      signal?.throwIfAborted();
      const result = await client().execute({ searchTerm: params.search_term, repoRoot: ctx.cwd });
      signal?.throwIfAborted();
      return output(result);
    },
  });

  pi.registerTool({
    name: "warpgrep_github_search",
    label: "Morph GitHub Search",
    description: "Search source in a specified public GitHub repository. Provide exactly one repository locator.",
    promptSnippet: "Search public GitHub source with Morph WarpGrep",
    promptGuidelines: ["Use warpgrep_github_search for a known public GitHub repository; use local search for the current checkout."],
    parameters: Type.Object({
      search_term: Type.String(),
      owner_repo: Type.Optional(Type.String()),
      github_url: Type.Optional(Type.String()),
      branch: Type.Optional(Type.String()),
    }),
    async execute(_id, params, signal) {
      const repo = resolveGitHubRepo(params.owner_repo, params.github_url);
      signal?.throwIfAborted();
      const result = await client().searchGitHub({ searchTerm: params.search_term, github: repo, branch: params.branch });
      signal?.throwIfAborted();
      return output(result, `Repository: ${repo}\n\n`);
    },
  });

  if (config?.compact.enabled) {
    const compactConfig = config;
    const redactor = installRedactBridge(pi);
    pi.on("session_before_compact", async (event) => {
      if (event.signal.aborted) return { cancel: true };
      if (!compactConfig.apiKey) return;
      const { messagesToSummarize, turnPrefixMessages, firstKeptEntryId, tokensBefore, previousSummary } = event.preparation;
      const messages = compactMessagesFromPi([...messagesToSummarize, ...turnPrefixMessages]);
      // Pi supplies earlier compacted history separately from the new messages.
      // Keep it intact instead of parsing its role-like lines as fresh turns.
      if (previousSummary?.trim()) messages.unshift({ role: "user", content: previousSummary });
      if (messages.length === 0) return;
      try {
        const result = await compactWithSignal({ apiKey: compactConfig.apiKey, baseURL: compactConfig.baseUrl, timeout: compactConfig.compact.timeoutMs }, {
          messages: redactor.redact(messages),
          compressionRatio: compactConfig.compact.ratio,
          preserveRecent: compactConfig.compact.preserveRecent,
        }, event.signal);
        const summary = result.messages?.length === messages.length
          ? result.messages.map((message) => message.content).join("\n\n")
          : result.output;
        if (!summary?.trim()) return;
        return { compaction: { summary, firstKeptEntryId, tokensBefore } };
      } catch {
        if (event.signal.aborted) return { cancel: true };
        return; // Let pi's default compaction run.
      }
    });
  }
}
