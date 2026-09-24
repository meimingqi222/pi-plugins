import { Type } from "typebox";
import { CompactClient, WarpGrepClient, type WarpGrepResult } from "@morphllm/morphsdk";
import {
  convertToLlm,
  serializeConversation,
  truncateHead,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { loadConfig } from "./config.ts";

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

export function compactMessagesFromText(text: string): Array<{ role: string; content: string }> {
  const messages: Array<{ role: string; content: string }> = [];
  let role: string | undefined;
  let lines: string[] = [];
  const flush = () => {
    const content = lines.join("\n").trim();
    if (role && content) messages.push({ role, content });
  };
  for (const line of text.split("\n")) {
    const match = line.match(/^\[(User|Assistant thinking|Assistant tool calls|Assistant|Tool result)\]:\s*/);
    if (match) {
      flush();
      role = match[1] === "User" ? "user" : match[1] === "Tool result" ? "tool" : "assistant";
      lines = [line.slice(match[0].length)];
    } else {
      lines.push(line);
    }
  }
  flush();
  return messages;
}

export default function morphSearch(pi: ExtensionAPI): void {
  // Config is loaded at registration; /reload applies changes without a process restart.
  const config = loadConfig();
  const client = () => {
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

  if (config.compact.enabled) {
    pi.on("session_before_compact", async (event) => {
      if (!config.apiKey) return;
      const { messagesToSummarize, turnPrefixMessages, firstKeptEntryId, tokensBefore } = event.preparation;
      const text = serializeConversation(convertToLlm([...messagesToSummarize, ...turnPrefixMessages]));
      const messages = compactMessagesFromText(text);
      if (messages.length === 0) return;
      try {
        const result = await new CompactClient({ morphApiKey: config.apiKey, morphApiUrl: config.baseUrl, timeout: config.compact.timeoutMs }).compact({
          messages,
          compressionRatio: config.compact.ratio,
          preserveRecent: config.compact.preserveRecent,
        });
        const summary = result.messages?.length === messages.length
          ? result.messages.map((message) => message.content).join("\n\n")
          : result.output;
        if (!summary?.trim()) return;
        return { compaction: { summary, firstKeptEntryId, tokensBefore } };
      } catch {
        return; // Let pi's default compaction run.
      }
    });
  }
}
