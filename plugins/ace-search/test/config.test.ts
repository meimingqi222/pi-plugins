import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadAceSearchConfig, parseSettingsToml, toPosixAbsolutePath } from "../src/config.ts";

describe("parseSettingsToml", () => {
  test("parses the flat string/int/array/bool forms acemcp writes", () => {
    const parsed = parseSettingsToml(`
BATCH_SIZE = 8
MAX_LINES_PER_BLOB = 300
BASE_URL = "https://ace.example.test/"
TOKEN = "secret"
TEXT_EXTENSIONS = [ ".vue", ".ts", ".go",]
`);

    expect(parsed.BATCH_SIZE).toBe(8);
    expect(parsed.MAX_LINES_PER_BLOB).toBe(300);
    expect(parsed.BASE_URL).toBe("https://ace.example.test/");
    expect(parsed.TOKEN).toBe("secret");
    expect(parsed.TEXT_EXTENSIONS).toEqual([".vue", ".ts", ".go"]);
  });

  test("strips comments, including a `#` inside a string", () => {
    const parsed = parseSettingsToml(`
# a leading comment
TOKEN = "abc#def"  # trailing comment
`);
    expect(parsed.TOKEN).toBe("abc#def");
  });

  test("ignores malformed lines instead of failing the whole file", () => {
    const parsed = parseSettingsToml(`
not a key value line
= broken
OK = 1
`);
    expect(parsed.OK).toBe(1);
    expect(parsed[""]).toBeUndefined();
  });

  test("an unterminated array does not produce phantom entries", () => {
    const parsed = parseSettingsToml('TEXT_EXTENSIONS = [ ".ts", ".go"');
    // No closing bracket: the value is not treated as an array.
    expect(parsed.TEXT_EXTENSIONS).toBeUndefined();
  });
});

describe("loadAceSearchConfig", () => {
  test("reads BASE_URL/TOKEN/chunking from a settings file", async () => {
    const home = await mkdtemp(join(tmpdir(), "pi-ace-home-"));
    await mkdir(join(home, ".acemcp"), { recursive: true });
    await writeFile(
      join(home, ".acemcp", "settings.toml"),
      `
BATCH_SIZE = 8
MAX_LINES_PER_BLOB = 300
BASE_URL = "https://from-file.test/"
TOKEN = "file-token"
TEXT_EXTENSIONS = [ ".ts", ".go",]
`,
    );

    const config = loadAceSearchConfig({ home, env: {} });

    expect(config.settingsPath).toBe(join(home, ".acemcp", "settings.toml"));
    expect(config.baseUrl).toBe("https://from-file.test");
    expect(config.token).toBe("file-token");
    expect(config.batchSize).toBe(8);
    expect(config.maxLinesPerBlob).toBe(300);
    expect(config.textExtensions).toEqual([".ts", ".go"]);
  });

  test("no base URL at all is a loud error, not a silent placeholder", () => {
    // acecpm's own default is `https://api.example.com`, which never worked.
    // Failing here beats a confusing 404 from a fake host.
    expect(() => loadAceSearchConfig({ home: "/home/u", env: {} })).toThrow(/base URL/i);
  });

  test("an env override supplies the base URL and token", () => {
    const config = loadAceSearchConfig({
      home: "/home/u",
      env: { PI_ACE_BASE_URL: "https://ace.test/", PI_ACE_TOKEN: "env-token" },
    });
    expect(config.baseUrl).toBe("https://ace.test");
    expect(config.token).toBe("env-token");
  });

  test("defaults stay compatible with acemcp so the warm cache is reused", () => {
    const config = loadAceSearchConfig({
      home: "/home/u",
      env: { PI_ACE_BASE_URL: "https://ace.test" },
    });
    // 300 lines matches the settings.toml in use; the built-in acemcp default
    // is 800, and a mismatch would split files differently and invalidate
    // every cached hash.
    expect(config.maxLinesPerBlob).toBe(300);
    expect(config.maxLineBytes).toBe(10 * 1024);
    expect(config.maxFileBytes).toBe(1024 * 1024);
    expect(config.textExtensions).toContain(".ts");
    // The bug this plugin exists to fix: acemcp hard-codes concurrency at 4.
    expect(config.concurrency).toBeGreaterThan(4);
  });

  test("numeric env overrides are parsed and validated", () => {
    const config = loadAceSearchConfig({
      home: "/home/u",
      env: {
        PI_ACE_BASE_URL: "https://ace.test",
        PI_ACE_BATCH_SIZE: "50",
        PI_ACE_CONCURRENCY: "16",
        PI_ACE_MAX_LINES_PER_BLOB: "500",
      },
    });
    expect(config.batchSize).toBe(50);
    expect(config.concurrency).toBe(16);
    expect(config.maxLinesPerBlob).toBe(500);
  });

  test("a non-positive or non-numeric batch size is rejected loudly", () => {
    expect(() =>
      loadAceSearchConfig({
        home: "/home/u",
        env: { PI_ACE_BASE_URL: "https://ace.test", PI_ACE_BATCH_SIZE: "0" },
      }),
    ).toThrow(/BATCH_SIZE/);
    expect(() =>
      loadAceSearchConfig({
        home: "/home/u",
        env: { PI_ACE_BASE_URL: "https://ace.test", PI_ACE_CONCURRENCY: "lots" },
      }),
    ).toThrow(/CONCURRENCY/);
  });

  test("extensions are normalized to a leading dot and lower case", () => {
    const config = loadAceSearchConfig({
      home: "/home/u",
      env: { PI_ACE_BASE_URL: "https://ace.test", PI_ACE_TEXT_EXTENSIONS: "TS, .Go " },
    });
    expect(config.textExtensions).toEqual([".ts", ".go"]);
  });

  test("exclude patterns can be overridden from the environment too", () => {
    const config = loadAceSearchConfig({
      home: "/home/u",
      env: { PI_ACE_BASE_URL: "https://ace.test", PI_ACE_EXCLUDE_PATTERNS: "node_modules,dist" },
    });
    expect(config.excludePatterns).toEqual(["node_modules", "dist"]);
  });

  test("--data wins over the environment", () => {
    const config = loadAceSearchConfig({
      home: "/home/u",
      dataDir: "/explicit",
      env: { PI_ACE_BASE_URL: "https://ace.test", PI_ACE_DATA_DIR: "/from-env" },
    });
    expect(config.dataDir).toBe("/explicit");
  });

  test("an explicit settings path is honoured and isolates the caller from real credentials", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-ace-cfg-"));
    const settingsPath = join(directory, "settings.toml");
    await writeFile(
      settingsPath,
      'BASE_URL = "https://isolated.test/"\nTOKEN = "isolated-token"\n',
    );

    const config = loadAceSearchConfig({ settingsPath, env: {} });

    expect(config.settingsPath).toBe(settingsPath);
    expect(config.baseUrl).toBe("https://isolated.test");
    expect(config.token).toBe("isolated-token");
  });

  test("PI_ACE_SETTINGS redirects the settings file, not just the home directory", () => {
    // The point is that no code path can reach a developer's real ~/.acemcp
    // unless it was pointed there: every test above passes an explicit home or
    // settings path, and this pins the env route.
    const config = loadAceSearchConfig({
      env: { PI_ACE_SETTINGS: "/tmp/nowhere.toml", PI_ACE_BASE_URL: "https://ace.test" },
    });
    expect(config.settingsPath).toBe("/tmp/nowhere.toml");
  });
});

describe("toPosixAbsolutePath", () => {
  test("resolves a relative path against cwd and strips backslashes", () => {
    // The given cwd is the anchor, and the result is POSIX: on Windows the
    // native separator would otherwise survive as `\`.
    const base = resolve(process.cwd(), "base");
    const result = toPosixAbsolutePath("sub/dir", base);
    expect(result).toBe(`${base.split("\\").join("/")}/sub/dir`);
    expect(result).not.toContain("\\");
  });

  test("leaves an absolute path absolute", () => {
    // `/already/abs` is drive-relative on Windows, not absolute, so pinning
    // that literal would assert the wrong rule there. A platform-appropriate
    // absolute path (with an ignored cwd) is what the contract actually says.
    const absolute = process.platform === "win32" ? "C:\\already\\abs" : "/already/abs";
    const expected = process.platform === "win32" ? "C:/already/abs" : "/already/abs";
    expect(toPosixAbsolutePath(absolute, "/base")).toBe(expected);
  });
});
