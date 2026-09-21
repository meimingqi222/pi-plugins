import { describe, expect, test } from "bun:test";
import { chunkFileContent, createExcludeMatcher, sha256Hex } from "../src/walk.ts";

const CHUNKING = { maxLinesPerBlob: 3, maxLineBytes: 64 };

describe("chunkFileContent", () => {
  test("a file at or under the limit is a single chunk named after the path", () => {
    const chunks = chunkFileContent("a.ts", "1\n2\n3", CHUNKING);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.name).toBe("a.ts");
    expect(chunks[0]!.content).toBe("1\n2\n3");
  });

  test("a file over the limit splits with `#chunk{N}of{TOTAL}` names", () => {
    const chunks = chunkFileContent("a.ts", "1\n2\n3\n4\n5\n6\n7", CHUNKING);
    expect(chunks.map((chunk) => chunk.name)).toEqual([
      "a.ts#chunk1of3",
      "a.ts#chunk2of3",
      "a.ts#chunk3of3",
    ]);
    expect(chunks[0]!.content).toBe("1\n2\n3");
    expect(chunks[2]!.content).toBe("7");
  });

  test("the hash is sha256 over name + content, not content alone", () => {
    const chunks = chunkFileContent("a.ts", "hello", CHUNKING);
    expect(chunks[0]!.hash).toBe(sha256Hex("a.tshello"));
    expect(chunks[0]!.hash).not.toBe(sha256Hex("hello"));
  });

  test("two files with identical bodies hash differently", () => {
    const left = chunkFileContent("a.ts", "same", CHUNKING)[0]!;
    const right = chunkFileContent("b.ts", "same", CHUNKING)[0]!;
    expect(left.hash).not.toBe(right.hash);
  });

  test("over-long lines are truncated with the same ellipsis acemcp appends", () => {
    const long = "x".repeat(200);
    const chunks = chunkFileContent("a.ts", long, { maxLinesPerBlob: 3, maxLineBytes: 10 });
    expect(chunks[0]!.content).toBe(`${"x".repeat(10)}…`);
  });

  test("an empty file still produces one chunk", () => {
    const chunks = chunkFileContent("a.ts", "", CHUNKING);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.content).toBe("");
  });

  test("splitting is line-based, so a trailing newline lands in the last chunk", () => {
    const chunks = chunkFileContent("a.ts", "1\n2\n3\n4", CHUNKING);
    expect(chunks).toHaveLength(2);
    expect(chunks[1]!.content).toBe("4");
  });
});

describe("createExcludeMatcher", () => {
  const matcher = createExcludeMatcher("/root", [
    "node_modules",
    ".git",
    "dist",
    "build",
    "*.pyc",
    ".venv",
  ]);

  test("a bare name excludes that directory at any depth", () => {
    expect(matcher.isIgnored("node_modules", true)).toBe(true);
    expect(matcher.isIgnored("packages/ui/node_modules", true)).toBe(true);
    expect(matcher.isIgnored("a/b/dist/x.js", false)).toBe(true);
  });

  test("a wildcard pattern matches by suffix", () => {
    expect(matcher.isIgnored("a/b/mod.pyc", false)).toBe(true);
    expect(matcher.isIgnored("a/b/mod.py", false)).toBe(false);
  });

  test("unrelated paths are kept", () => {
    expect(matcher.isIgnored("packages/provider/src/resolver.ts", false)).toBe(false);
  });

  test("a path pattern only matches at the root", () => {
    const rooted = createExcludeMatcher("/root", ["packages/desktop/dist-*"]);
    expect(rooted.isIgnored("packages/desktop/dist-main", true)).toBe(true);
    expect(rooted.isIgnored("other/packages/desktop/dist-main", true)).toBe(false);
  });
});
