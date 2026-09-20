import { describe, expect, test } from "bun:test";
import { createRedactor } from "../src/engine.ts";
import { SECRET_PATTERNS } from "../src/patterns.ts";
import * as FX from "./fixtures.ts";

const r = createRedactor(SECRET_PATTERNS);
const GHP = FX.GITHUB_PAT;
const MOCK_SK = FX.OPENAI_KEY_3;

describe("built-in patterns smoke test", () => {
  test("GitHub PAT", () => {
    expect(r.string(GHP)).toBe("[REDACTED:github-pat]");
  });

  test("sk-secret glued to CJK text", () => {
    expect(r.string(`${MOCK_SK}我输入了什么？`)).toBe("[REDACTED:sk-secret]我输入了什么？");
  });

  test("AWS access key id", () => {
    expect(r.string(FX.AWS_ACCESS_KEY_ID)).toBe("[REDACTED:aws-access-key-id]");
  });

  test("Anthropic key", () => {
    const key = FX.ANTHROPIC_KEY;
    expect(r.string(key)).toBe("[REDACTED:anthropic-api-key]");
  });

  test("Slack token", () => {
    expect(r.string(FX.SLACK_TOKEN)).toContain("[REDACTED:slack-access-token]");
  });

  test("private key block", () => {
    const pem = FX.PEM_PRIVATE_KEY;
    expect(r.string(pem)).toContain("[REDACTED:private-key]");
  });

  test("leaves ordinary code untouched", () => {
    const code = 'const total = items.reduce((a, b) => a + b.price, 0);';
    expect(r.string(code)).toBe(code);
  });

  test("patternList reports metadata for each active pattern", () => {
    expect(r.patternCount).toBe(SECRET_PATTERNS.length);
    expect(r.patternList).toHaveLength(SECRET_PATTERNS.length);
    expect(r.patternList[0]).toHaveProperty("id");
    expect(r.patternList[0]).toHaveProperty("category");
    expect(r.patternList[0]).toHaveProperty("title");
  });
});
