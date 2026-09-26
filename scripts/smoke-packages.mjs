import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const plugins = join(root, "plugins");
const packages = readdirSync(plugins).filter((name) => existsSync(join(plugins, name, "package.json")));
const extensionNames = packages.filter((name) => {
  const manifest = JSON.parse(readFileSync(join(plugins, name, "package.json"), "utf8"));
  return manifest.pi?.extensions?.length > 0;
});
const temporary = mkdtempSync(join(tmpdir(), "pi-packages-smoke-"));

try {
  const archives = packages.map((name) => {
    const archive = execFileSync("bun", ["pm", "pack", "--destination", temporary, "--quiet"], {
      cwd: join(plugins, name),
      encoding: "utf8",
    }).trim();
    if (!existsSync(archive)) throw new Error(`Pack produced no archive for ${name}: ${archive}`);
    return archive;
  });

  const installRoot = join(temporary, "installed");
  execFileSync("npm", ["install", "--prefix", installRoot, "--ignore-scripts", "--legacy-peer-deps", "--no-audit", "--no-fund", ...archives], {
    stdio: "inherit",
  });

  const entries = extensionNames.map((name) => {
    const packageRoot = join(installRoot, "node_modules", `pi-${name}`);
    const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
    const entry = resolve(packageRoot, manifest.pi.extensions[0]);
    if (!existsSync(entry)) throw new Error(`Packed extension entry missing: ${entry}`);
    return entry;
  });

  const loader = new DefaultResourceLoader({
    cwd: temporary,
    agentDir: temporary,
    settingsManager: SettingsManager.inMemory(),
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    additionalExtensionPaths: entries,
  });
  await loader.reload();
  const { extensions, errors } = loader.getExtensions();
  if (errors.length > 0 || extensions.length !== entries.length ||
      entries.some((entry) => !extensions.some((extension) => extension.path === entry))) {
    throw new Error(`Packed extensions failed to load: ${JSON.stringify({ errors, loaded: extensions.map((extension) => extension.path), entries })}`);
  }
  console.log(`Loaded ${extensions.length} packed extensions from an isolated install.`);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
