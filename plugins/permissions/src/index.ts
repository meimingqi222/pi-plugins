/**
 * pi-permissions: a small permission layer over pi's `tool_call` hook.
 *
 * Four tiers (safe / grey / dangerous / forbidden) × four modes
 * (read-only / ask / auto / yolo, default yolo). Forbidden is always denied
 * and dangerous always asks — no mode or rule can downgrade them. Delegated
 * children (PI_AGENT_CHILD=1) cannot be asked; their asks become denials.
 */

import { getAgentDir, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, ToolCallEventResult } from "@earendil-works/pi-coding-agent";
import * as path from "node:path";
import { classifyToolCall, networkExfilShaped, type ShellDialect } from "./classify.ts";
import { mergeConfig, appendProjectAllowRule, saveGlobalMode, saveGlobalSandboxEnabled, type MergedConfig } from "./config.ts";
import { decide } from "./decide.ts";
import { createPolicyEnv } from "./env.ts";
import { createReviewer, type Reviewer } from "./reviewer.ts";
import { detectSandbox, resolveSandboxPolicy, sandboxDeps, wrapSandboxed, type SandboxAvailability } from "./sandbox/index.ts";
import { parseRule, type UserRule } from "./rules.ts";
import { buildAllowRules, createPrompter, summarizeInput } from "./prompt.ts";
import type { Classification, Mode, PolicyEnv } from "./types.ts";

const MODES = new Set<Mode>(["read-only", "ask", "auto", "yolo"]);
const BOURNE_SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh"]);
const POWER_SHELLS = new Set(["powershell", "pwsh"]);

function isChild(): boolean {
  return process.env.PI_AGENT_CHILD === "1";
}

function shellDialect(shellPath: string | undefined): ShellDialect {
  if (!shellPath) return "bash";
  const base = shellPath.split(/[\\/]/u).at(-1)!.toLowerCase().replace(/\.exe$/u, "");
  if (BOURNE_SHELLS.has(base)) return "bash";
  if (POWER_SHELLS.has(base)) return "powershell";
  return "unsupported";
}

export default function permissionsExtension(pi: ExtensionAPI): void {
  let env: PolicyEnv | undefined;
  let merged: MergedConfig | undefined;
  let sessionMode: Mode | undefined;
  let sessionRules: UserRule[] = [];
  let reviewer: Reviewer | undefined;
  let sandboxOverride: boolean | undefined;
  let sandboxAvailability: SandboxAvailability | undefined;
  const prompter = createPrompter();

  const globalFile = (): string => path.join(getAgentDir(), "permissions.json");
  const projectFile = (cwd: string): string => path.join(cwd, ".pi", "permissions.json");

  /** (Re)load config and rebuild the policy env. Idempotent. */
  const loadState = (ctx: ExtensionContext): { env: PolicyEnv; merged: MergedConfig } => {
    let trusted = false;
    try {
      trusted = ctx.isProjectTrusted();
    } catch {
      // Context without trust info → untrusted.
    }
    const mergedConfig = mergeConfig(globalFile(), projectFile(ctx.cwd), trusted, ctx.cwd);
    const builtEnv = createPolicyEnv(ctx.cwd, mergedConfig.additionalDirectories);
    for (const warning of mergedConfig.warnings) {
      try {
        ctx.ui.notify(`pi-permissions: ignoring config (${warning})`, "warning");
      } catch {
        // No UI to warn on.
      }
    }
    env = builtEnv;
    merged = mergedConfig;
    reviewer = undefined; // rebuilt lazily from the new config
    sandboxAvailability = detectSandbox(builtEnv);
    return { env: builtEnv, merged: mergedConfig };
  };

  const sandboxOn = (mergedConfig: MergedConfig): boolean => sandboxOverride ?? mergedConfig.sandbox.enabled;

  const sandboxUsable = (mergedConfig: MergedConfig): boolean =>
    sandboxOn(mergedConfig) && sandboxAvailability?.available === true;

  /** Rewrite an allowed bash command into its sandboxed form (§12.3). */
  const applySandbox = (event: { toolName: string; input: Record<string, unknown> }): void => {
    if (event.toolName !== "bash" || !env || !merged || !sandboxAvailability || !sandboxUsable(merged)) return;
    const command = typeof event.input.command === "string" ? event.input.command : undefined;
    if (command === undefined) return;
    const wrapped = wrapSandboxed(command, env, merged.sandbox, sandboxAvailability, sandboxDeps());
    if (wrapped) event.input.command = wrapped;
  };

  const reviewerFor = (ctx: ExtensionContext, mergedConfig: MergedConfig): Reviewer | undefined => {
    if (!mergedConfig.reviewer || !env) return undefined;
    if (!reviewer) {
      reviewer = createReviewer(mergedConfig.reviewer, env, (message) => {
        try {
          ctx.ui.notify(message, "warning");
        } catch {
          // No UI to warn on.
        }
      });
    }
    return reviewer;
  };

  const state = (ctx: ExtensionContext): { env: PolicyEnv; merged: MergedConfig } =>
    env && merged ? { env, merged } : loadState(ctx);

  /** §5.2 #6: inherited(child) > PI_PERMISSIONS_MODE > session > project > global > yolo. */
  const resolveMode = (mergedConfig: MergedConfig): Mode => {
    if (isChild()) {
      const inherited = process.env.PI_PERMISSIONS_INHERITED_MODE;
      return MODES.has(inherited as Mode) ? (inherited as Mode) : "yolo";
    }
    const envMode = process.env.PI_PERMISSIONS_MODE;
    if (MODES.has(envMode as Mode)) return envMode as Mode;
    if (sessionMode) return sessionMode;
    if (mergedConfig.projectMode) return mergedConfig.projectMode;
    if (mergedConfig.globalMode) return mergedConfig.globalMode;
    return "yolo";
  };

  const setStatus = (ctx: ExtensionContext, mode: Mode): void => {
    if (isChild() || !ctx.hasUI) return;
    try {
      const sbx = merged && sandboxOn(merged) ? (sandboxAvailability?.available ? " sbx:on" : " sbx:n/a") : "";
      ctx.ui.setStatus("pi-permissions", `perm: ${mode}${sbx}`);
    } catch {
      // Torn-down UI.
    }
  };

  const shellSettings = (cwd: string): { dialect: ShellDialect; commandPrefix?: string } => {
    try {
      const settings = SettingsManager.create(cwd, getAgentDir());
      return { dialect: shellDialect(settings.getShellPath()), commandPrefix: settings.getShellCommandPrefix() };
    } catch {
      return { dialect: "bash" };
    }
  };

  const classify = (ctx: ExtensionContext, toolName: string, input: Record<string, unknown>): Classification => {
    const { env: policyEnv, merged: mergedConfig } = state(ctx);
    const shell = shellSettings(ctx.cwd);
    return classifyToolCall(toolName, input, {
      env: policyEnv,
      pathPolicy: { protectedRead: mergedConfig.protectedRead, protectedWrite: mergedConfig.protectedWrite },
      shellDialect: shell.dialect,
      commandPrefix: shell.commandPrefix,
    });
  };

  const decideFor = (ctx: ExtensionContext, classification: Classification) => {
    const { env: policyEnv, merged: mergedConfig } = state(ctx);
    const mode = resolveMode(mergedConfig);
    if (!isChild()) {
      // Children spawned after this inherit the effective mode (§6.2).
      try {
        process.env.PI_PERMISSIONS_INHERITED_MODE = mode;
      } catch {
        // Read-only env: skip silently.
      }
    }
    const rules = [
      ...mergedConfig.rules.map((rule) => parseRule(rule.text, rule.kind, rule.source)),
      ...sessionRules,
    ];
    return { decision: decide(classification, mode, rules, policyEnv), mode };
  };

  pi.on("session_start", (_event, ctx) => {
    sessionMode = undefined;
    sessionRules = [];
    sandboxOverride = undefined;
    const { merged: mergedConfig } = loadState(ctx);
    setStatus(ctx, resolveMode(mergedConfig));
  });

  pi.on("tool_call", async (event, ctx): Promise<ToolCallEventResult | undefined> => {
    try {
      const classification = classify(ctx, event.toolName, event.input as Record<string, unknown>);
      const { decision, mode } = decideFor(ctx, classification);
      setStatus(ctx, mode);

      if (decision.action === "allow") {
        applySandbox(event as unknown as { toolName: string; input: Record<string, unknown> });
        return undefined;
      }

      if (decision.action === "deny") {
        if (decision.tier === "forbidden") {
          return {
            block: true,
            terminate: true,
            reason: `Blocked by pi-permissions (${decision.ruleId}): ${decision.reason}. This is never allowed.`,
          };
        }
        if (mode === "read-only") {
          return { block: true, reason: "Blocked: pi-permissions is in read-only mode." };
        }
        return { block: true, reason: `Blocked by pi-permissions: ${decision.reason}` };
      }

      // ask — in auto mode a grey call first tries to resolve without asking:
      // the sandbox covers bash (§12.6), else the reviewer model (§11). An
      // explicit ask rule (askedByRule) is never overridden.
      let reason = decision.reason;
      if (mode === "auto" && decision.tier === "grey" && !decision.askedByRule) {
        if (event.toolName === "bash" && merged && sandboxUsable(merged) && !networkExfilShaped(classification)) {
          applySandbox(event as unknown as { toolName: string; input: Record<string, unknown> });
          return undefined;
        }
        const active = reviewerFor(ctx, merged!);
        if (active) {
          const verdict = await active.review({
            ctx,
            toolName: event.toolName,
            toolInput: summarizeInput(event.toolName, event.input as Record<string, unknown>),
            staticAnalysis: reason,
            signal: ctx.signal,
          });
          if (verdict?.verdict === "allow") {
            applySandbox(event as unknown as { toolName: string; input: Record<string, unknown> });
            return undefined;
          }
          if (verdict) reason = `${reason} — reviewer: ${verdict.reason}`;
        }
      }

      // ask — but children can never be asked (§6.3).
      const canAsk = ctx.hasUI && !isChild();
      if (!canAsk) {
        return {
          block: true,
          reason: `Blocked by pi-permissions (${decision.tier}, ${decision.ruleId ?? "policy"}): ${reason}. No approval is possible in this run (headless). Ask the user to run it, or adjust .pi/permissions.json.`,
        };
      }

      const allowRules = decision.allowAlwaysOffered ? buildAllowRules(classification, env!) : [];
      const outcome = await prompter.ask({
        dangerous: decision.tier === "dangerous",
        readOnly: mode === "read-only",
        toolName: event.toolName,
        reason,
        summary: summarizeInput(event.toolName, event.input as Record<string, unknown>),
        allowRules,
        deps: { select: (t, o, d) => ctx.ui.select(t, o, d), input: (t, p, d) => ctx.ui.input(t, p, d), signal: ctx.signal },
      });

      switch (outcome.outcome) {
        case "allow-once":
          applySandbox(event as unknown as { toolName: string; input: Record<string, unknown> });
          return undefined;
        case "allow-session":
          for (const text of outcome.rules) sessionRules.push(parseRule(text, "allow", "session"));
          applySandbox(event as unknown as { toolName: string; input: Record<string, unknown> });
          return undefined;
        case "allow-always": {
          for (const text of outcome.rules) {
            try {
              appendProjectAllowRule(globalFile(), env!.cwd, text);
              sessionRules.push(parseRule(text, "allow", "session"));
            } catch (error) {
              try {
                ctx.ui.notify(`pi-permissions: could not persist the rule (${String(error)}); allowed once.`, "warning");
              } catch {
                // ignore
              }
            }
          }
          applySandbox(event as unknown as { toolName: string; input: Record<string, unknown> });
          return undefined;
        }
        case "deny": {
          const feedback = outcome.feedback ? ` — user said: ${outcome.feedback}` : "";
          return { block: true, reason: `Denied by the user: ${reason}${feedback}` };
        }
      }
    } catch (error) {
      // Fail closed: ask if possible, deny otherwise; never let a plugin bug
      // silently execute or crash pi.
      try {
        ctx.ui.notify(`pi-permissions internal error: ${String(error)}`, "error");
      } catch {
        // ignore
      }
      const canAsk = ctx.hasUI && !isChild();
      if (canAsk) {
        try {
          const choice = await ctx.ui.select(
            `[pi-permissions] internal error — approve anyway?\n${String(error)}`,
            ["Allow once", "Deny"],
            { signal: ctx.signal },
          );
          if (choice === "Allow once") return undefined;
        } catch {
          // fall through to deny
        }
      }
      return { block: true, reason: `Blocked by pi-permissions (internal error): ${String(error)}` };
    }
  });

  pi.registerCommand?.("permissions", {
    description: "Permission mode, rules and sandbox: /permissions [mode <m> [--save] | sandbox [on|off [--save]|status] | rules | check <tool> <input> | reload]",
    handler: async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
      const { merged: mergedConfig } = state(ctx);
      const input = args.trim();
      const [sub, ...rest] = input.split(/\s+/u).filter(Boolean);

      const mode = resolveMode(mergedConfig);
      if (!sub || sub === "status") {
        const source = isChild()
          ? "inherited (child)"
          : process.env.PI_PERMISSIONS_MODE && MODES.has(process.env.PI_PERMISSIONS_MODE as Mode)
            ? "PI_PERMISSIONS_MODE"
            : sessionMode
              ? "session"
              : mergedConfig.projectMode
                ? "project"
                : mergedConfig.globalMode
                  ? "global"
                  : "default";
        const invalid = mergedConfig.rules
          .map((rule) => parseRule(rule.text, rule.kind, rule.source))
          .filter((rule) => !rule.valid)
          .map((rule) => `${rule.raw} (${rule.invalidReason})`);
        ctx.ui.notify(
          `pi-permissions\n` +
            `mode: ${mode} (${source})\n` +
            `project trusted: ${mergedConfig.projectTrusted}\n` +
            `global: ${globalFile()}\n` +
            `project: ${projectFile(ctx.cwd)}\n` +
            `rules: ${mergedConfig.rules.length} (+${sessionRules.length} session)${invalid.length ? `\ninvalid: ${invalid.join(", ")}` : ""}`,
          "info",
        );
        return;
      }

      if (sub === "mode") {
        const save = rest.includes("--save");
        const wanted = rest.find((arg) => arg !== "--save") as Mode | undefined;
        if (!wanted || !MODES.has(wanted)) {
          ctx.ui.notify("Usage: /permissions mode <read-only|ask|auto|yolo> [--save]", "warning");
          return;
        }
        sessionMode = wanted;
        if (save) {
          try {
            saveGlobalMode(globalFile(), wanted);
          } catch (error) {
            ctx.ui.notify(`pi-permissions: could not save mode (${String(error)})`, "warning");
          }
        }
        setStatus(ctx, wanted);
        ctx.ui.notify(`pi-permissions mode: ${wanted}${save ? " (saved globally)" : " (this session)"}`, "info");
        return;
      }

      if (sub === "rules") {
        const lines = [
          ...mergedConfig.rules.map((rule) => `${rule.kind.padEnd(5)} ${rule.source.padEnd(13)} ${rule.text}`),
          ...sessionRules.map((rule) => `${rule.kind.padEnd(5)} ${"session".padEnd(13)} ${rule.raw}`),
        ];
        ctx.ui.notify(lines.length ? `pi-permissions rules:\n${lines.join("\n")}` : "pi-permissions: no rules configured", "info");
        return;
      }

      if (sub === "check") {
        const tool = rest[0];
        if (!tool) {
          ctx.ui.notify("Usage: /permissions check <tool> <command or path>", "warning");
          return;
        }
        const payload = rest.slice(1).join(" ");
        let inputObj: Record<string, unknown>;
        try {
          inputObj = JSON.parse(payload) as Record<string, unknown>;
        } catch {
          inputObj = tool === "bash" || tool === "powershell" ? { command: payload } : { path: payload };
        }
        const classification = classify(ctx, tool, inputObj);
        const { decision } = decideFor(ctx, classification);
        ctx.ui.notify(
          `${decision.action} / ${decision.tier}${decision.ruleId ? ` / ${decision.ruleId}` : ""}${decision.matchedRule ? ` / ${decision.matchedRule}` : ""}\n${decision.reason}`,
          "info",
        );
        return;
      }

      if (sub === "sandbox") {
        const on = sandboxOn(mergedConfig);
        const action = rest.find((arg) => arg !== "--save");
        const save = rest.includes("--save");
        if (action === "on" || action === "off") {
          sandboxOverride = action === "on";
          if (save) {
            try {
              saveGlobalSandboxEnabled(globalFile(), sandboxOverride);
            } catch (error) {
              ctx.ui.notify(`pi-permissions: could not save sandbox setting (${String(error)})`, "warning");
            }
          }
          setStatus(ctx, mode);
          ctx.ui.notify(`pi-permissions sandbox: ${action}${save ? " (saved globally)" : " (this session)"}`, "info");
          return;
        }
        if (action === "status" || !action) {
          const avail = sandboxAvailability;
          const policy = env && avail?.available ? resolveSandboxPolicy(env, mergedConfig.sandbox, sandboxDeps().exists) : undefined;
          ctx.ui.notify(
            `pi-permissions sandbox\n` +
              `enabled: ${on ? "yes" : "no"}${sandboxOverride !== undefined ? " (session override)" : ""}\n` +
              `mechanism: ${avail?.detail ?? "unknown"}\n` +
              `network: ${mergedConfig.sandbox.network}\n` +
              (policy ? `writable: ${policy.writable.length} paths\ndeny-read: ${policy.denyRead.length} paths` : "policy: inactive"),
            "info",
          );
          return;
        }
        ctx.ui.notify("Usage: /permissions sandbox [on|off [--save] | status]", "warning");
        return;
      }

      if (sub === "reload") {
        loadState(ctx);
        const after = merged!;
        setStatus(ctx, resolveMode(after));
        ctx.ui.notify("pi-permissions: configuration reloaded", "info");
        return;
      }

      ctx.ui.notify("Usage: /permissions [mode <m> [--save] | sandbox [on|off [--save]|status] | rules | check <tool> <input> | reload]", "warning");
    },
  });
}
