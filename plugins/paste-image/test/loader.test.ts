import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";

test("pi loads the published entry point without errors", async () => {
	const isolated = await mkdtemp(join(tmpdir(), "pi-paste-image-loader-"));
	try {
		const entry = resolve(dirname(fileURLToPath(import.meta.url)), "../src/index.ts");
		const loader = new DefaultResourceLoader({
			cwd: isolated,
			agentDir: isolated,
			settingsManager: SettingsManager.inMemory(),
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
			additionalExtensionPaths: [entry],
		});
		await loader.reload();
		const result = loader.getExtensions();
		// A thrown factory or an `on("input")` this pi does not know about shows up
		// here rather than as a silently dead extension.
		expect(result.errors).toEqual([]);
		expect(result.extensions.find((extension) => extension.path === entry)).toBeDefined();
	} finally {
		await rm(isolated, { recursive: true, force: true });
	}
});
