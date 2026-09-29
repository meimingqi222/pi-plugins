import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverAgents, parseToolList, readAgentFile } from "../src/agents.ts";

async function withTemp(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "pi-subagent-agents-"));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

describe("agent frontmatter", () => {
  test("accepts both YAML spellings of tools", () => {
    expect(parseToolList("read, grep , ls")).toEqual(["read", "grep", "ls"]);
    expect(parseToolList(["read", "bash"])).toEqual(["read", "bash"]);
  });

  test("rejects a value that is neither a string nor a list", () => {
    expect(parseToolList(3)).toBeUndefined();
    expect(parseToolList(["read", 4])).toEqual(["read"]);
    expect(parseToolList([])).toBeUndefined();
  });

  test("reads name, description, tools, model, and the body", async () => {
    const { dir, cleanup } = await withTemp();
    try {
      const file = join(dir, "scout.md");
      await writeFile(
        file,
        ["---", "name: scout", "description: fast recon", "tools: [read, grep]", "model: provider/small", "---", "", "You are a scout."].join("\n"),
      );
      const agent = readAgentFile(file);
      expect(agent).toEqual({
        name: "scout",
        description: "fast recon",
        tools: ["read", "grep"],
        model: "provider/small",
        systemPrompt: "You are a scout.",
        filePath: file,
      });
    } finally {
      await cleanup();
    }
  });

  test("ignores a file with no name or description", async () => {
    const { dir, cleanup } = await withTemp();
    try {
      const file = join(dir, "broken.md");
      await writeFile(file, "---\nname: broken\n---\nbody");
      expect(readAgentFile(file)).toBeUndefined();
    } finally {
      await cleanup();
    }
  });

  test("rejects an explicit malformed tool allowlist instead of granting default tools", async () => {
    const { dir, cleanup } = await withTemp();
    try {
      const file = join(dir, "restricted.md");
      await writeFile(file, "---\nname: restricted\ndescription: read only\ntools: []\n---\nRead files.");
      expect(readAgentFile(file)).toBeUndefined();
    } finally {
      await cleanup();
    }
  });
});

describe("discoverAgents", () => {
  test("returns usable agents sorted by name, and ignores other files", async () => {
    const { dir, cleanup } = await withTemp();
    try {
      await writeFile(join(dir, "worker.md"), "---\nname: worker\ndescription: writes\n---\nwork");
      await writeFile(join(dir, "planner.md"), "---\nname: planner\ndescription: plans\n---\nplan");
      await writeFile(join(dir, "notes.txt"), "not an agent");
      const agents = discoverAgents(dir);
      expect(agents.map((agent) => agent.name)).toEqual(["explore", "general", "planner", "review", "worker"]);
    } finally {
      await cleanup();
    }
  });

  test("a missing user directory still exposes explore", () => {
    expect(discoverAgents("/nonexistent/pi-subagent/agents").map((agent) => agent.name)).toEqual(["explore", "review", "general"]);
  });

  test("the built-in explore uses only Pi's read-only inspection tools", () => {
    const explore = discoverAgents("/nonexistent/pi-subagent/agents")[0]!;
    expect(explore.name).toBe("explore");
    expect(explore.tools).toEqual(["read", "grep", "find", "ls"]);
    expect(explore.model).toBeUndefined();
  });

  test("a malformed frontmatter file does not take discovery down with it", async () => {
    // `parseFrontmatter` runs a real YAML parser, which throws on a syntax
    // error. Discovery runs on every tool call, so an unguarded throw here made
    // one broken user file fail the whole `subagent` tool and hide every other
    // agent — the opposite of the module's one-bad-file-must-not-win rule.
    const { dir, cleanup } = await withTemp();
    try {
      await writeFile(join(dir, "good.md"), "---\nname: good\ndescription: fine\n---\nbody");
      await writeFile(join(dir, "broken.md"), "---\nname: [unclosed\n---\nbody");
      expect(readAgentFile(join(dir, "broken.md"))).toBeUndefined();
      expect(discoverAgents(dir).map((agent) => agent.name)).toEqual(["explore", "general", "good", "review"]);
    } finally {
      await cleanup();
    }
  });

  test("a user definition with the same name replaces the built-in", async () => {
    const { dir, cleanup } = await withTemp();
    try {
      await writeFile(join(dir, "explore.md"), "---\nname: explore\ndescription: custom exploration\ntools: read\n---\nCustom prompt.");
      const agents = discoverAgents(dir);
      expect(agents).toHaveLength(3);
      expect(agents[0]?.description).toBe("custom exploration");
      expect(agents[0]?.tools).toEqual(["read"]);
    } finally {
      await cleanup();
    }
  });

  test("a model-only file retargets a built-in and inherits the rest", async () => {
    // The whole point of a partial override: retargeting a built-in's model must
    // not require copying its prompt and tool list into the user's file, where
    // they would drift from the catalog.
    const { dir, cleanup } = await withTemp();
    try {
      const builtin = discoverAgents("/nonexistent/pi-subagent/agents");
      const before = builtin.find((agent) => agent.name === "explore")!;
      await writeFile(join(dir, "explore.md"), "---\nname: explore\nmodel: provider/small\n---\n");
      const agents = discoverAgents(dir);
      const explore = agents.find((agent) => agent.name === "explore")!;
      expect(agents).toHaveLength(3);
      expect(explore.model).toBe("provider/small");
      expect(explore.description).toBe(before.description);
      expect(explore.tools).toEqual(before.tools);
      expect(explore.systemPrompt).toBe(before.systemPrompt);
      expect(agents.find((agent) => agent.name === "review")?.model).toBeUndefined();
    } finally {
      await cleanup();
    }
  });

  test("an override that omits tools keeps the built-in allowlist instead of pi's default", async () => {
    // Omitting `tools` means "pi's default set" for a standalone definition, and
    // that default includes write and shell access. A model-only override must
    // not be able to widen `explore` into a writing agent by leaving the field
    // out — the failure would be silent, and it would be a capability change
    // nobody asked for.
    const { dir, cleanup } = await withTemp();
    try {
      await writeFile(join(dir, "explore.md"), "---\nname: explore\nmodel: provider/small\n---\n");
      await writeFile(join(dir, "worker.md"), "---\nname: worker\ndescription: writes\n---\nwork");
      const agents = discoverAgents(dir);
      const explore = agents.find((agent) => agent.name === "explore")!;
      expect(explore.tools).toEqual(["read", "grep", "find", "ls"]);
      // A name with no built-in is a standalone definition, so an omitted
      // `tools` keeps its existing meaning of pi's default set.
      expect(agents.find((agent) => agent.name === "worker")?.tools).toBeUndefined();
    } finally {
      await cleanup();
    }
  });

  test("a malformed allowlist still skips the file rather than inheriting", async () => {
    const { dir, cleanup } = await withTemp();
    try {
      await writeFile(join(dir, "explore.md"), "---\nname: explore\ntools: []\n---\n");
      const agents = discoverAgents(dir);
      const explore = agents.find((agent) => agent.name === "explore")!;
      expect(agents).toHaveLength(3);
      expect(explore.tools).toEqual(["read", "grep", "find", "ls"]);
      expect(explore.model).toBeUndefined();
    } finally {
      await cleanup();
    }
  });

  test("an override may name a new agent only with a description of its own", async () => {
    const { dir, cleanup } = await withTemp();
    try {
      await writeFile(join(dir, "scout.md"), "---\nname: scout\nmodel: provider/small\n---\nScout.");
      expect(discoverAgents(dir).map((agent) => agent.name)).toEqual(["explore", "general", "review"]);
      await writeFile(join(dir, "scout.md"), "---\nname: scout\ndescription: recon\nmodel: provider/small\n---\nScout.");
      const scout = discoverAgents(dir).find((agent) => agent.name === "scout")!;
      expect(scout.model).toBe("provider/small");
      expect(scout.tools).toBeUndefined();
    } finally {
      await cleanup();
    }
  });
});
