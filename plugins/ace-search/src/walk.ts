/**
 * Workspace walker + blob chunker.
 *
 * Deliberately reproduces acemcp's decisions rather than inventing a better
 * ones, because the server-side index is keyed by blob name and the cache is
 * keyed by blob hash:
 *
 *   include a file  ⇔ extension is in TEXT_EXTENSIONS
 *                     ∧ size ≤ 1 MiB
 *                     ∧ not excluded (built-in names + .gitignore)
 *   skip a file     ⇔ size ≥ 100 KiB and contains no newline in the first 8 KiB
 *   chunk name      ⇔ `path` when ≤ MAX_LINES_PER_BLOB lines,
 *                     else `path#chunk{N}of{TOTAL}`
 *   chunk hash      ⇔ sha256(hex, of `chunkName + chunkContent`)
 *
 * `buildBlobInventory` then intersects the names against a hash store so the
 * caller uploads only chunks the server has never seen. That intersection is
 * what turns a cold 68s upload into a warm zero-upload search.
 */

import { createHash } from "node:crypto";
import { open, readdir, readFile, stat } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import ignore, { type Ignore } from "ignore";
import type { AceSearchConfig } from "./config.ts";

export interface BlobChunk {
  /** `path` or `path#chunk2of5` — the name the server indexes under. */
  readonly name: string;
  /** Workspace-relative POSIX path, without the `#chunk…` suffix. */
  readonly filePath: string;
  readonly content: string;
  readonly hash: string;
}

export interface InventoryEntry {
  readonly filePath: string;
  readonly chunks: readonly BlobChunk[];
}

export interface BlobInventory {
  /** Every chunk name for every included file, in walk order. */
  readonly entries: readonly InventoryEntry[];
  /** Flat list of chunk names; what `/batch-upload` keys on. */
  readonly names: readonly string[];
  /** Flat list of chunk hashes; what retrieval and `/find-missing` expect. */
  readonly hashes: readonly string[];
  /** Hashes absent from the hash store, i.e. bodies the server lacks. */
  readonly missing: readonly BlobChunk[];
  readonly includedFiles: number;
  readonly skippedFiles: number;
}

export interface BuildBlobInventoryResult extends BlobInventory {
  readonly durationMs: number;
}

export interface BuildBlobInventoryOptions {
  readonly projectRoot: string;
  readonly config: AceSearchConfig;
  /** Known blob hashes, keyed by chunk name. Empty ⇒ everything is "missing". */
  readonly hashesByPath: ReadonlyMap<string, string>;
  readonly signal: AbortSignal;
}

export async function buildBlobInventory(
  options: BuildBlobInventoryOptions,
): Promise<BuildBlobInventoryResult> {
  const startedAt = Date.now();
  const { projectRoot, config, hashesByPath, signal } = options;
  const extensions = new Set(config.textExtensions.map((ext) => ext.toLowerCase()));
  const walker = createExcludeMatcher(projectRoot, config.excludePatterns);

  const files = await collectCandidateFiles(projectRoot, { extensions, walker, signal });
  const entries: InventoryEntry[] = [];
  const names: string[] = [];
  const hashes: string[] = [];
  const missing: BlobChunk[] = [];
  let skippedFiles = 0;

  for (const file of files) {
    signal.throwIfAborted();
    if (file.size > config.maxFileBytes) {
      skippedFiles += 1;
      continue;
    }
    let content: string;
    try {
      content = await readFileText(file.absolutePath);
    } catch {
      skippedFiles += 1;
      continue;
    }
    if (await isMinifiedCandidate(file.absolutePath, file.size)) {
      skippedFiles += 1;
      continue;
    }
    const chunks = chunkFileContent(file.relativePath, content, config);
    if (chunks.length === 0) {
      skippedFiles += 1;
      continue;
    }
    entries.push({ filePath: file.relativePath, chunks });
    for (const chunk of chunks) {
      names.push(chunk.name);
      hashes.push(chunk.hash);
      if (hashesByPath.get(chunk.name) !== chunk.hash) missing.push(chunk);
    }
  }

  return {
    entries,
    names,
    hashes,
    missing,
    includedFiles: entries.length,
    skippedFiles,
    durationMs: Date.now() - startedAt,
  };
}

export function chunkFileContent(
  relativePath: string,
  content: string,
  config: Pick<AceSearchConfig, "maxLinesPerBlob" | "maxLineBytes">,
): BlobChunk[] {
  const maxLines = config.maxLinesPerBlob > 0 ? config.maxLinesPerBlob : 800;
  const maxBytes = config.maxLineBytes > 0 ? config.maxLineBytes : 10 * 1024;
  const lines = content.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    // Byte-accurate truncation is unnecessary: the suffix makes the two
    // clients' chunk bodies identical, so the hashes match.
    if (Buffer.byteLength(line, "utf8") > maxBytes) {
      lines[index] = `${line.slice(0, maxBytes)}…`;
    }
  }

  if (lines.length <= maxLines) {
    const body = lines.join("\n");
    return [makeChunk(relativePath, relativePath, relativePath, body)];
  }

  const total = Math.ceil(lines.length / maxLines);
  const chunks: BlobChunk[] = [];
  for (let index = 0; index < total; index += 1) {
    const start = index * maxLines;
    const body = lines.slice(start, start + maxLines).join("\n");
    const name = `${relativePath}#chunk${index + 1}of${total}`;
    chunks.push(makeChunk(name, relativePath, relativePath, body));
  }
  return chunks;
}

function makeChunk(name: string, filePath: string, _displayPath: string, content: string): BlobChunk {
  return Object.freeze({
    name,
    filePath,
    content,
    hash: sha256Hex(`${name}${content}`),
  });
}

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

// ---------------------------------------------------------------------------
// File collection
// ---------------------------------------------------------------------------

interface CandidateFile {
  readonly absolutePath: string;
  readonly relativePath: string;
  readonly size: number;
}

interface GitIgnoreScope {
  directory: string;
  matcher: Ignore;
}

async function readGitIgnore(directory: string): Promise<GitIgnoreScope | undefined> {
  try {
    const content = await readFile(join(directory, ".gitignore"), "utf8");
    return { directory, matcher: ignore({ ignorecase: false }).add(content) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    // An unreadable exclusion file must not silently authorize uploads.
    throw error;
  }
}

function gitIgnored(scopes: readonly GitIgnoreScope[], path: string, isDirectory: boolean): boolean {
  let ignored = false;
  for (const scope of scopes) {
    const localPath = toPosix(relative(scope.directory, path)) + (isDirectory ? "/" : "");
    const match = scope.matcher.test(localPath);
    if (match.ignored) ignored = true;
    else if (match.unignored) ignored = false;
  }
  return ignored;
}

async function collectCandidateFiles(
  projectRoot: string,
  context: {
    readonly extensions: ReadonlySet<string>;
    readonly walker: ExcludeMatcher;
    readonly signal: AbortSignal;
  },
): Promise<CandidateFile[]> {
  const results: CandidateFile[] = [];
  const queue: { directory: string; scopes: GitIgnoreScope[] }[] = [{ directory: projectRoot, scopes: [] }];

  while (queue.length > 0) {
    context.signal.throwIfAborted();
    const { directory, scopes: inherited } = queue.pop()!;
    const local = await readGitIgnore(directory);
    const scopes = local ? [...inherited, local] : inherited;
    let dirents;
    try {
      dirents = await readdir(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const dirent of dirents) {
      const absolutePath = join(directory, dirent.name);
      const relativePath = toPosix(relative(projectRoot, absolutePath));
      if (gitIgnored(scopes, absolutePath, dirent.isDirectory())) continue;
      if (dirent.isDirectory()) {
        if (!context.walker.isIgnored(relativePath, true)) queue.push({ directory: absolutePath, scopes });
        continue;
      }
      if (!dirent.isFile()) continue;
      const extension = extensionOf(dirent.name);
      if (!extension || !context.extensions.has(extension)) continue;
      if (context.walker.isIgnored(relativePath, false)) continue;
      let info;
      try {
        info = await stat(absolutePath);
      } catch {
        continue;
      }
      results.push({ absolutePath, relativePath, size: info.size });
    }
  }

  results.sort((left, right) => (left.relativePath < right.relativePath ? -1 : 1));
  return results;
}

function extensionOf(name: string): string | undefined {
  const index = name.lastIndexOf(".");
  if (index <= 0) return undefined;
  return name.slice(index).toLowerCase();
}

function toPosix(path: string): string {
  return path.split("\\").join("/");
}

/**
 * Minified bundles are unsearchable and enormous; acemcp drops files ≥ 100 KiB
 * with no newline in the first 8 KiB. The same rule is applied here so both
 * clients agree on which blobs exist.
 */
async function isMinifiedCandidate(absolutePath: string, size: number): Promise<boolean> {
  if (size < 100 * 1024) return false;
  let handle;
  try {
    handle = await open(absolutePath, "r");
    const buffer = Buffer.alloc(8192);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return !buffer.subarray(0, bytesRead).includes(0x0a);
  } catch {
    return false;
  } finally {
    await handle?.close();
  }
}

async function readFileText(absolutePath: string): Promise<string> {
  const { readFile } = await import("node:fs/promises");
  return readFile(absolutePath, "utf8");
}

// ---------------------------------------------------------------------------
// Excludes
// ---------------------------------------------------------------------------

export interface ExcludeMatcher {
  isIgnored(relativePath: string, isDirectory: boolean): boolean;
}

export function createExcludeMatcher(
  projectRoot: string,
  patterns: readonly string[],
): ExcludeMatcher {
  const names: string[] = [];
  const wildcards: string[] = [];
  const paths: string[] = [];
  for (const raw of patterns) {
    const pattern = raw.trim();
    if (!pattern) continue;
    if (pattern.includes("/")) paths.push(pattern.replace(/^\.\//, "").replace(/\/+$/, ""));
    else if (pattern.includes("*")) wildcards.push(pattern);
    else names.push(pattern);
  }
  const nameSet = new Set(names);

  return {
    isIgnored(relativePath, isDirectory) {
      const base = basename(relativePath);
      const segments = relativePath.split("/");
      // A bare name excludes any path *segment* named that, at any depth —
      // acemcp's `Contains('/' + pattern + '/')` rule. Applies to files and
      // directories alike.
      for (const segment of segments) {
        if (nameSet.has(segment)) return true;
        if (wildcards.some((pattern) => matchWildcard(segment, pattern))) return true;
      }
      // A path pattern is anchored at the project root, like .gitignore.
      // Un-anchoring it would exclude a nested `packages/desktop/dist-foo`
      // even though only the root-level one was configured.
      if (paths.length > 0) {
        const target = isDirectory ? `${relativePath}/` : relativePath;
        for (const pattern of paths) {
          if (matchPathPattern(target, pattern)) return true;
        }
      }
      void base;
      return false;
    },
  };
}

/**
 * Match a relative path against a rooted pattern.
 *
 * A `*` segment cannot cross a `/` boundary, so a two-segment wildcard pattern
 * does not match a three-segment path. This is a small subset of .gitignore —
 * enough for the names acemcp's own `EXCLUDE_PATTERNS` contains, none of which
 * use `**`.
 */
function matchPathPattern(path: string, pattern: string): boolean {
  const pathParts = path.split("/");
  const patternParts = pattern.split("/");
  let pathIndex = 0;
  for (let patternIndex = 0; patternIndex < patternParts.length; patternIndex += 1) {
    const part = patternParts[patternIndex]!;
    if (part === "**") {
      // Consume zero or more segments; if last, match the rest.
      if (patternIndex === patternParts.length - 1) return true;
      const next = patternParts[patternIndex + 1]!;
      while (pathIndex < pathParts.length && !matchWildcard(pathParts[pathIndex]!, next)) pathIndex += 1;
      if (pathIndex >= pathParts.length) return false;
      patternIndex += 1;
      pathIndex += 1;
      continue;
    }
    if (pathIndex >= pathParts.length) return false;
    if (!matchWildcard(pathParts[pathIndex]!, part)) return false;
    pathIndex += 1;
  }
  // A pattern only matching a prefix is still a match: a `dist-*` pattern must
  // exclude the *directory* `packages/desktop/dist-main`, whose children are
  // never visited because the walker prunes the directory first. Requiring full
  // consumption made such a pattern match nothing at all.
  return true;
}

/** Only `*` and `?` are honoured, which covers the configured patterns. */
function matchWildcard(name: string, pattern: string): boolean {
  if (pattern === "*") return true;
  const expression = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]");
  return new RegExp(`^${expression}$`).test(name);
}
