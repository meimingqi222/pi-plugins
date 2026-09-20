import { describe, expect, test } from "bun:test";
import { createRedactor, type Redactor } from "../src/engine.ts";
import { SECRET_PATTERNS } from "../src/patterns.ts";
import { redactJson } from "../src/pi-bridge.ts";
import * as FX from "./fixtures.ts";

const redactor: Redactor = createRedactor(SECRET_PATTERNS);
const GHP = FX.GITHUB_PAT;
const GLPAT = FX.GITLAB_PAT;

describe("pi-bridge redactJson", () => {
  test("redacts strings nested in objects and arrays", () => {
    const input = {
      model: "gpt-4o",
      messages: [
        { role: "user", content: `my token is ${GHP}` },
        { role: "assistant", content: [{ type: "text", text: `and ${GLPAT}` }] },
      ],
    };
    const { value, hits } = redactJson(input, redactor);
    const serialized = JSON.stringify(value);

    expect(hits).toBe(2);
    expect(serialized).not.toContain(GHP);
    expect(serialized).not.toContain(GLPAT);
    expect(serialized).toContain("[REDACTED:github-pat]");
  });

  test("preserves references for unchanged branches (copy-on-write)", () => {
    const untouched = { deep: { nested: "nothing to see" } };
    const input = { secret: GHP, untouched };
    const { value } = redactJson(input, redactor) as { value: Record<string, unknown> };

    expect(value.untouched).toBe(untouched);
    expect(value.secret).not.toBe(GHP);
  });

  test("leaves base64 image payloads alone", () => {
    // A fake base64 blob that would otherwise look like a JWT / token.
    const data = FX.JWT;
    const input = {
      messages: [
        {
          role: "user",
          content: [{ type: "image", data, mimeType: "image/png" }],
        },
      ],
    };
    const { value, hits } = redactJson(input, redactor) as { value: any; hits: number };

    expect(hits).toBe(0);
    expect(value).toBe(input);
    expect(value.messages[0].content[0].data).toBe(data);
  });

  test("leaves isImage/content payloads alone", () => {
    const input = { isImage: true, content: GHP, mimeType: "image/png" };
    const { hits } = redactJson(input, redactor);
    expect(hits).toBe(0);
  });

  test("tolerates non-plain objects without dropping them", () => {
    class Marker {
      constructor(readonly secret: string) {}
    }
    const marker = new Marker(GHP);
    const input = { marker, ok: "clean" };
    const { value } = redactJson(input, redactor) as { value: Record<string, unknown> };

    expect(value.marker).toBe(marker);
    expect((value.marker as Marker).secret).toBe(GHP);
  });

  test("survives cycles by not recursing into class instances", () => {
    const input: Record<string, unknown> = { name: "x", token: GHP };
    input.self = input;
    const { value } = redactJson(input, redactor) as { value: Record<string, unknown> };
    expect(value.token).not.toBe(GHP);
    expect(value.self).toBe(input);
  });

  test("returns same reference when nothing matches", () => {
    const input = { a: [1, 2, { b: "clean text" }], c: null };
    const { value, hits } = redactJson(input, redactor);
    expect(hits).toBe(0);
    expect(value).toBe(input);
  });

  test("handles null/undefined/number roots", () => {
    expect(redactJson(null, redactor)).toEqual({ value: null, hits: 0 });
    expect(redactJson(undefined, redactor)).toEqual({ value: undefined, hits: 0 });
    expect(redactJson(42, redactor)).toEqual({ value: 42, hits: 0 });
  });

  test("redacts a realistic pi provider payload", () => {
    const payload = {
      model: "deepseek-v4.1-flash",
      stream: true,
      messages: [
        { role: "system", content: "You are a coding agent." },
        {
          role: "user",
          content: `deploy with ${GLPAT} please`,
        },
        {
          role: "assistant",
          content: [
            { type: "text", text: "Running bash" },
            {
              type: "toolCall",
              id: "call_1",
              name: "bash",
              arguments: { command: `curl -H 'Authorization: Bearer ${GHP}' https://api.github.com` },
            },
          ],
        },
        {
          role: "tool",
          content: `{"ok":true,"token":"${GHP}"}`,
        },
      ],
    };

    const { value, hits } = redactJson(payload, redactor) as { value: any; hits: number };
    const serialized = JSON.stringify(value);

    expect(hits).toBeGreaterThanOrEqual(3);
    expect(serialized).not.toContain(GHP);
    expect(serialized).not.toContain(GLPAT);
    expect(value.model).toBe("deepseek-v4.1-flash");
    expect(value.messages).toHaveLength(4);
  });
});
