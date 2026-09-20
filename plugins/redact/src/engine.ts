/**
 * Self-contained secret redaction engine.
 * Strips invisible Unicode, detects secrets via keyword+regex, and
 * recursively redacts objects/arrays — no external dependencies.
 *
 * Hot path: precompiled keywords, one toLowerCase per string, byte-bounded LRU
 * cache, copy-on-write deep walk, path clone only along the path.
 */

// Unicode Tags block (U+E0000–U+E007F) as UTF-16 surrogate pairs.
const UNICODE_TAGS_RE = /[\uDB40][\uDC00-\uDC7F]/g
const HIGH_SURROGATE = "\uDB40"

/**
 * Default redaction cache budget in bytes of UTF-16 string data.
 *
 * The cache is byte bounded rather than entry bounded so a handful of large
 * file reads cannot exhaust memory, and so no single entry can evict the whole
 * working set. 32 MB comfortably holds a long session's message history.
 */
export const DEFAULT_CACHE_BYTES = 32 * 1024 * 1024

/** UTF-16 strings cost 2 bytes per code unit. */
const BYTES_PER_CODE_UNIT = 2

let _logger: Pick<typeof console, "warn" | "info"> = console

export function setLogger(log: Pick<typeof console, "warn" | "info">): void {
  _logger = log
}

export interface SecretPattern {
  id: string
  category: string
  title: string
  pattern: string
  keywords: string[]
  caseInsensitive?: boolean
  /** @deprecated compiled internally; retained for source compatibility */
  _regex?: RegExp
}

interface CompiledPattern {
  readonly id: string
  readonly regex: RegExp
  readonly keywords: readonly string[]
  readonly keywordsLower: readonly string[]
  readonly caseInsensitive: boolean
}

const compiledByPatterns = new WeakMap<object, CompiledPattern[]>()

function compilePatterns(patterns: readonly SecretPattern[]): CompiledPattern[] {
  return patterns.map((entry) => {
    let regex: RegExp
    try {
      // `d` exposes per-group offsets so only the captured secret is censored
      // while keyword context inside the match survives.
      regex = new RegExp(entry.pattern, entry.caseInsensitive ? "gid" : "gd")
    } catch (err) {
      _logger.warn("Error compiling regex", { pattern: entry.id, error: err })
      // A never-matching pattern: a broken rule is skipped rather than
      // silently matching everything.
      regex = /(?!)/g
    }
    const keywords = entry.keywords ?? []
    return {
      id: entry.id,
      regex,
      keywords,
      keywordsLower: keywords.map((kw) => kw.toLowerCase()),
      caseInsensitive: entry.caseInsensitive === true,
    }
  })
}

function getCompiled(patterns: readonly SecretPattern[]): CompiledPattern[] {
  const existing = compiledByPatterns.get(patterns)
  if (existing) return existing
  const compiled = compilePatterns(patterns)
  compiledByPatterns.set(patterns, compiled)
  return compiled
}

export function stripInvisibleUnicode(input: string): string {
  if (!input.includes(HIGH_SURROGATE)) return input
  const stripped = input.replace(UNICODE_TAGS_RE, "")
  if (stripped.length !== input.length) {
    _logger.info("Invisible Unicode tag characters removed during sanitization", {
      removedCount: input.length - stripped.length,
    })
  }
  return stripped
}

function matchesKeyword(entry: CompiledPattern, original: string, lowered: string): boolean {
  const keywords = entry.caseInsensitive ? entry.keywordsLower : entry.keywords
  const haystack = entry.caseInsensitive ? lowered : original
  for (let i = 0; i < keywords.length; i++) {
    if (haystack.includes(keywords[i]!)) return true
  }
  return false
}

/**
 * Censor every match of `regex` in `input`.
 *
 * Group 1 is the secret by convention; the rest of the match is keyword
 * context that must survive (`KEY="secret"` keeps its `KEY="` prefix).
 *
 * Group offsets come from the `d` flag: `full.replace(captured, …)` is unsafe
 * because it rewrites the *first* textual occurrence of the secret, which may
 * sit inside the prefix — corrupting the output and leaving part of the
 * credential in cleartext. Group 1 being absent, empty, or spanning the whole
 * match means the entire match is censored.
 */
function censorMatches(regex: RegExp, input: string, id: string): string {
  const censor = `[REDACTED:${id}]`
  let out = ""
  let last = 0

  regex.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = regex.exec(input)) !== null) {
    // A zero-width match cannot be censored and would not advance `lastIndex`
    // on every engine, so skip past it instead of looping forever.
    if (match[0] === "") {
      if (regex.lastIndex <= match.index) regex.lastIndex = match.index + 1
      continue
    }

    out += input.slice(last, match.index)

    const group = (match as { indices?: Array<[number, number]> }).indices?.[1]
    if (
      group !== undefined &&
      group[1] > group[0] &&
      !(group[0] === match.index && group[1] === match.index + match[0].length)
    ) {
      const start = group[0] - match.index
      const end = group[1] - match.index
      out += match[0].slice(0, start) + censor + match[0].slice(end)
    } else {
      out += censor
    }

    last = match.index + match[0].length
  }

  out += input.slice(last)
  return out
}

/**
 * Apply every pattern to `input`.
 *
 * `lowered` is computed at most once per string and reused across all
 * case-insensitive patterns. It is only invalidated when a replacement
 * actually changes the text, because keyword offsets shift after that.
 */
function applyPatterns(input: string, compiled: readonly CompiledPattern[]): string {
  let lowered: string | undefined
  let out = input

  for (const entry of compiled) {
    if (entry.caseInsensitive && lowered === undefined) {
      lowered = out.toLowerCase()
    }

    if (!matchesKeyword(entry, out, lowered ?? out)) continue

    const next = censorMatches(entry.regex, out, entry.id)

    if (next !== out) {
      out = next
      // Lower snapshot is invalid after a replacement.
      lowered = undefined
    }
  }

  return out
}

/**
 * Map-compatible cache with byte accounting and LRU eviction.
 *
 * Large entries are no longer skipped: a 1 MB file read is exactly the case
 * that benefits most from caching across turns. Instead, entries that cannot
 * fit the budget are simply not stored, and stored entries are evicted
 * oldest-first rather than clearing the whole cache.
 */
export interface StringCache {
  get(key: string): string | undefined
  set(key: string, value: string): void
  clear(): void
  readonly size: number
}

class LruStringCache implements StringCache {
  private readonly map = new Map<string, string>()
  private bytes = 0

  constructor(private readonly maxBytes: number) {}

  get size(): number {
    return this.map.size
  }

  get(key: string): string | undefined {
    const value = this.map.get(key)
    if (value === undefined) return undefined
    // Refresh recency.
    this.map.delete(key)
    this.map.set(key, value)
    return value
  }

  set(key: string, value: string): void {
    const cost = (key.length + value.length) * BYTES_PER_CODE_UNIT
    // Too large to ever fit: skip rather than evicting everything else.
    if (cost > this.maxBytes) return

    const previous = this.map.get(key)
    if (previous !== undefined) {
      this.bytes -= (key.length + previous.length) * BYTES_PER_CODE_UNIT
      this.map.delete(key)
    }

    while (this.bytes + cost > this.maxBytes) {
      const oldest = this.map.keys().next().value
      if (oldest === undefined) break
      const oldValue = this.map.get(oldest)!
      this.map.delete(oldest)
      this.bytes -= (oldest.length + oldValue.length) * BYTES_PER_CODE_UNIT
    }

    this.map.set(key, value)
    this.bytes += cost
  }

  clear(): void {
    this.map.clear()
    this.bytes = 0
  }
}

function createStringCache(maxBytes: number): StringCache {
  return new LruStringCache(maxBytes)
}

function redactStringCompiled(
  input: string,
  compiled: readonly CompiledPattern[],
  cache: StringCache,
): string {
  const existing = cache.get(input)
  if (existing !== undefined) return existing

  const result = applyPatterns(stripInvisibleUnicode(input), compiled)
  cache.set(input, result)
  return result
}

export function redactStringValue(
  input: string | null | undefined,
  patterns: readonly SecretPattern[],
  cache: StringCache = createStringCache(DEFAULT_CACHE_BYTES),
): string | null | undefined {
  if (!input || typeof input !== "string") return input
  return redactStringCompiled(input, getCompiled(patterns), cache)
}

type DeepResult = { value: unknown; changed: boolean }

function unchanged(value: unknown): DeepResult {
  return { value, changed: false }
}

function redactDeepInner(
  value: unknown,
  compiled: readonly CompiledPattern[],
  cache: StringCache,
  inProgress: WeakSet<object> = new WeakSet(),
): DeepResult {
  if (value === null || value === undefined) return unchanged(value)

  if (typeof value === "string") {
    const next = redactStringCompiled(value, compiled, cache)
    return next === value ? unchanged(value) : { value: next, changed: true }
  }

  if (typeof value !== "object") return unchanged(value)

  if (Array.isArray(value)) {
    // Break cycles: a node is marked only while its own children are being
    // visited, so the same object in sibling positions is still redacted.
    if (inProgress.has(value)) return unchanged(value)
    inProgress.add(value)

    let changed = false
    const next = value.map((item) => {
      const r = redactDeepInner(item, compiled, cache, inProgress)
      if (r.changed) changed = true
      return r.value
    })

    inProgress.delete(value)
    return changed ? { value: next, changed: true } : unchanged(value)
  }

  const obj = value as Record<string, unknown>

  if ("type" in obj && (obj.type === "base64" || obj.type === "image") && "data" in obj) {
    return unchanged(value)
  }

  if ("isImage" in obj && obj.isImage === true && typeof obj.content === "string") {
    if (inProgress.has(value)) return unchanged(value)
    inProgress.add(value)

    let changed = false
    const result: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(obj)) {
      if (k === "content") {
        result[k] = v
        continue
      }
      const r = redactDeepInner(v, compiled, cache, inProgress)
      if (r.changed) changed = true
      result[k] = r.value
    }

    inProgress.delete(value)
    return changed ? { value: result, changed: true } : unchanged(value)
  }

  if (inProgress.has(value)) return unchanged(value)
  inProgress.add(value)

  let changed = false
  const entries: Array<[string, unknown]> = []
  for (const [k, v] of Object.entries(obj)) {
    const r = redactDeepInner(v, compiled, cache, inProgress)
    if (r.changed) changed = true
    entries.push([k, r.value])
  }

  inProgress.delete(value)
  return changed ? { value: Object.fromEntries(entries), changed: true } : unchanged(value)
}

/**
 * Recursively redact secrets. Returns the original reference when nothing
 * changed. Preserves image/base64 data untouched.
 */
export function redactDeep(
  value: unknown,
  patterns: readonly SecretPattern[],
  cache: StringCache = createStringCache(DEFAULT_CACHE_BYTES),
): unknown {
  return redactDeepInner(value, getCompiled(patterns), cache).value
}

export function redact(value: unknown, patterns: readonly SecretPattern[]): unknown {
  return redactDeep(value, patterns, createStringCache(DEFAULT_CACHE_BYTES))
}

const PATH_NOT_FOUND = Symbol("path_not_found")

function parsePath(path: string): string[] {
  const segs: string[] = []
  let current = ""
  let inBrackets = false
  let inQuotes = false
  let quoteChar = ""

  const flush = () => {
    if (current) {
      segs.push(current)
      current = ""
    }
  }

  for (const ch of path) {
    if (!inBrackets && ch === ".") {
      flush()
    } else if (ch === "[") {
      flush()
      inBrackets = true
    } else if (ch === "]" && inBrackets) {
      segs.push(current)
      current = ""
      inBrackets = false
      inQuotes = false
    } else if ((ch === '"' || ch === "'") && inBrackets) {
      if (!inQuotes) {
        inQuotes = true
        quoteChar = ch
      } else if (ch === quoteChar) {
        inQuotes = false
        quoteChar = ""
      } else {
        current += ch
      }
    } else {
      current += ch
    }
  }
  flush()
  return segs
}

function getAtPath(obj: unknown, segs: string[]): unknown | typeof PATH_NOT_FOUND {
  let current: unknown = obj
  for (const key of segs) {
    if (current === null || current === undefined || typeof current !== "object") {
      return PATH_NOT_FOUND
    }
    const record = current as Record<string, unknown>
    if (!(key in record)) return PATH_NOT_FOUND
    current = record[key]
  }
  return current
}

/** Shallow-copy only the nodes along `segs`; returns original if missing. */
function setAtPathCopy(root: unknown, segs: string[], val: unknown): unknown {
  if (segs.length === 0) return val
  if (root === null || typeof root !== "object") return root

  if (Array.isArray(root)) {
    const idx = Number(segs[0])
    if (!Number.isInteger(idx) || idx < 0 || idx >= root.length) return root
    const next = root.slice()
    next[idx] = setAtPathCopy(next[idx], segs.slice(1), val)
    return next
  }

  const obj = root as Record<string, unknown>
  const key = segs[0]!
  if (!(key in obj)) return root
  const next = { ...obj }
  next[key] = setAtPathCopy(obj[key], segs.slice(1), val)
  return next
}

export function redactByPaths(value: unknown, paths: string[], censor = "[REDACTED]"): unknown {
  if (value === null || typeof value !== "object") return value
  let result: unknown = value
  for (const path of paths) {
    const segs = parsePath(path)
    if (getAtPath(result, segs) === PATH_NOT_FOUND) continue
    result = setAtPathCopy(result, segs, censor)
  }
  return result
}

export interface RedactorPatternInfo {
  readonly id: string
  readonly category: string
  readonly title: string
}

export interface Redactor {
  readonly patternCount: number
  readonly pathCount: number
  /** Metadata for every active pattern, in evaluation order. */
  readonly patternList: readonly RedactorPatternInfo[]
  /** Number of strings currently held in the redaction cache. */
  readonly cacheEntries: number
  string(input: string | null | undefined): string | null | undefined
  deep(value: unknown): unknown
  paths(value: unknown): unknown
  clearCache(): void
}

export interface RedactorOptions {
  redactPaths?: string[]
  pathCensor?: string
  /** Cache budget in bytes of UTF-16 string data. Defaults to 32 MB. */
  cacheBytes?: number
}

export function createRedactor(patterns: readonly SecretPattern[], options: RedactorOptions = {}): Redactor {
  const compiled = compilePatterns(patterns)
  compiledByPatterns.set(patterns, compiled)
  const redactPaths = options.redactPaths ?? []
  const pathCensor = options.pathCensor ?? "[REDACTED]"
  const cache = createStringCache(options.cacheBytes ?? DEFAULT_CACHE_BYTES)

  return {
    patternCount: compiled.length,
    pathCount: redactPaths.length,
    patternList: patterns.map(({ id, category, title }) => ({ id, category, title })),
    get cacheEntries() {
      return cache.size
    },
    string(input) {
      if (!input || typeof input !== "string") return input
      return redactStringCompiled(input, compiled, cache)
    },
    deep(value) {
      return redactDeepInner(value, compiled, cache).value
    },
    paths(value) {
      if (redactPaths.length === 0) return value
      return redactByPaths(value, redactPaths, pathCensor)
    },
    clearCache() {
      cache.clear()
    },
  }
}
