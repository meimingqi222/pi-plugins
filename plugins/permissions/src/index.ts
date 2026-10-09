/**
 * pi-permissions: a small permission layer over pi's `tool_call` hook.
 *
 * Four tiers (safe / grey / dangerous / forbidden) × four modes
 * (read-only / ask / auto / yolo, default yolo). Forbidden is always denied
 * and dangerous asks in guarded modes; YOLO allows it unless explicit rules
 * ask or deny. Delegated
 * children (PI_AGENT_CHILD=1) cannot be asked; their asks become denials.
 */

import { getAgentDir, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, ToolCallEventResult } from "@earendil-works/pi-coding-agent";
import * as path from "node:path";
import { classifyToolCall, networkExfilShaped, type ShellDialect } from "./classify.ts";
import { mergeConfig, appendProjectAllowRule, appendAdditionalDirectory, saveGlobalMode, saveGlobalSandboxEnabled, type MergedConfig } from "./config.ts";
import { decide } from "./decide.ts";
import { createPolicyEnv } from "./env.ts";
import { isInside } from "./paths.ts";
import { createReviewer, type Reviewer } from "./reviewer.ts";
import { detectSandbox, resolveSandboxPolicy, sandboxDeps, wrapSandboxed, type SandboxAvailability } from "./sandbox/index.ts";
import { parseRule, type UserRule } from "./rules.ts";
import { buildAllowRules, createPrompter, describeInput, summarizeInput } from "./prompt.ts";
import { approvalKey, decodeSessionContext, encodeSessionContext, INHERITED_CONTEXT_ENV } from "./session-context.ts";
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

/**
 * The one directory a user could add to `additionalDirectories` to make this
 * call ordinary. Offered only for a dangerous `rm` whose offending targets all
 * sit in the same directory, so the grant can never be broader than the deletion
 * the user is looking at; `undefined` means there is nothing coherent to grant.
 */
function grantableDirectory(classification: Classification, env: PolicyEnv): string | undefined {
  const scratch = [env.cwd, ...env.additionalDirs, ...env.tempDirs];
  const offending = new Set<number>();
  classification.intents.forEach((intent, index) => {
    if (intent.kind === "exec" && intent.ruleId === "rm-recursive-force") offending.add(index);
  });
  if (offending.size === 0) return undefined;
  const parents = new Set<string>();
  for (const intent of classification.intents) {
    if (intent.sourceIndex === undefined || !offending.has(intent.sourceIndex)) continue;
    if (intent.kind !== "write" || !intent.path) continue;
    if (scratch.some((dir) => isInside(intent.path!, dir, env))) continue;
    parents.add(path.posix.dirname(intent.path));
  }
  return parents.size === 1 ? [...parents][0] : undefined;
}

export default function permissionsExtension(pi: ExtensionAPI): void {
  let env: PolicyEnv | undefined;
  let merged: MergedConfig | undefined;
  let sessionMode: Mode | undefined;
  let sessionRules: UserRule[] = [];
  let exactCalls = new Set<string>();
  let policyRevision = 0;
  let policyAbort = new AbortController();
  const invalidateApprovals = (): void => {
    policyRevision += 1;
    policyAbort.abort();
    policyAbort = new AbortController();
  };
  let reviewer: Reviewer | undefined | null = null; // null = not yet created
  let sandboxOverride: boolean | undefined;
  let sandboxAvailability: SandboxAvailability | undefined;
  const prompter = createPrompter();

  const globalFile = (): string => path.join(getAgentDir(), "permissions.json");
  const projectFile = (cwd: string): string => path.join(cwd, ".pi", "permissions.json");

  /**
   * The `projects[<cwd>]` key. It must be the realpath'd cwd — the same value
   * `env.cwd` carries — because grants are written under `env.cwd` and read back
   * under this key: with a symlinked cwd (`/tmp` → `/private/tmp`, a linked
   * checkout) a raw `ctx.cwd` would write one key and read another, so an
   * "always allow" would silently never apply.
   */
  const canonicalCwd = (cwd: string): string => createPolicyEnv(cwd, []).cwd;

  /** (Re)load config and rebuild the policy env. Idempotent. */
  const loadState = (ctx: ExtensionContext): { env: PolicyEnv; merged: MergedConfig } => {
    let trusted = false;
    try {
      trusted = ctx.isProjectTrusted();
    } catch {
      // Context without trust info → untrusted.
    }
    const mergedConfig = mergeConfig(globalFile(), projectFile(ctx.cwd), trusted, canonicalCwd(ctx.cwd));
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
    reviewer = null; // rebuilt lazily from the new config
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

  // §11.2: with no reviewer section the reviewer still activates when a Jev
  // key exists — jev is the fast default backend. "none" disables it.
  const reviewerFor = (ctx: ExtensionContext, mergedConfig: MergedConfig): Reviewer | undefined => {
    if (!env || mergedConfig.reviewer?.model === "none") return undefined;
    if (reviewer === null) {
      reviewer = createReviewer(mergedConfig.reviewer, env, getAgentDir(), (message) => {
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

  /** One resolver for enforcement, display and child inheritance. */
  const effectiveMode = (mergedConfig: MergedConfig): { mode: Mode; source: string } => {
    if (isChild()) {
      const inherited = process.env.PI_PERMISSIONS_INHERITED_MODE;
      return { mode: MODES.has(inherited as Mode) ? inherited as Mode : "yolo", source: "inherited (child)" };
    }
    const envMode = process.env.PI_PERMISSIONS_MODE;
    if (MODES.has(envMode as Mode)) return { mode: envMode as Mode, source: "PI_PERMISSIONS_MODE" };
    if (sessionMode) return { mode: sessionMode, source: "session" };
    if (mergedConfig.projectMode) return { mode: mergedConfig.projectMode, source: "project" };
    if (mergedConfig.globalMode) return { mode: mergedConfig.globalMode, source: "global" };
    return { mode: "yolo", source: "default" };
  };
  const resolveMode = (config: MergedConfig): Mode => effectiveMode(config).mode;

  const publishContext = (): void => {
    if (isChild() || !env || !merged) return;
    process.env.PI_PERMISSIONS_INHERITED_MODE = resolveMode(merged);
    const encoded = encodeSessionContext({
      version: 1, cwd: env.cwd, rules: sessionRules.map(rule => rule.raw),
      exactCalls: [...exactCalls], sandboxOverride,
    });
    if (encoded) process.env[INHERITED_CONTEXT_ENV] = encoded;
    else delete process.env[INHERITED_CONTEXT_ENV];
  };

  const callKey = (ctx: ExtensionContext, tool: string, input: Record<string, unknown>): string =>
    approvalKey(tool, input, canonicalCwd(ctx.cwd), shellSettings(ctx.cwd));

  const setStatus = (ctx: ExtensionContext, mode: Mode): void => {
    if (isChild() || !ctx.hasUI) return;
    try {
      const sbx = merged && sandboxOn(merged) ? (sandboxAvailability?.available ? " sbx:on" : " sbx:n/a") : "";
      ctx.ui.setStatus("pi-permissions", `perm: ${mode}${sbx}`);
    } catch {
      // Torn-down UI.
    }
  };

  const shellSettings = (cwd: string): { dialect: ShellDialect; shellPath?: string; commandPrefix?: string } => {
    try {
      const settings = SettingsManager.create(cwd, getAgentDir());
      const shellPath = settings.getShellPath();
      return { dialect: shellDialect(shellPath), shellPath, commandPrefix: settings.getShellCommandPrefix() };
    } catch {
      return { dialect: "bash" };
    }
  };

  const classify = (ctx: ExtensionContext, toolName: string, input: Record<string, unknown>): Classification => {
    const { env: policyEnv, merged: mergedConfig } = state(ctx);
    const shell = shellSettings(ctx.cwd);
    return classifyToolCall(toolName, input, {
      env: policyEnv,
      pathPolicy: {
        protectedRead: mergedConfig.protectedRead,
        protectedWrite: mergedConfig.protectedWrite,
        protectedReadExclude: mergedConfig.protectedReadExclude,
      },
      shellDialect: shell.dialect,
      commandPrefix: shell.commandPrefix,
    });
  };

  const decideFor = (ctx: ExtensionContext, classification: Classification, key?: string) => {
    const { env: policyEnv, merged: mergedConfig } = state(ctx);
    const mode = resolveMode(mergedConfig);
    publishContext();
    const rules = [
      ...mergedConfig.rules.map((rule) => parseRule(rule.text, rule.kind, rule.source)),
      ...sessionRules,
    ];
    const decision = decide(classification, mode, rules, policyEnv);
    if (key && exactCalls.has(key) && decision.action === "ask" && decision.tier !== "dangerous" && !decision.askedByRule) {
      return { decision: { ...decision, action: "allow" as const, reason: "exact call approved for this session" }, mode };
    }
    return { decision, mode };
  };

  pi.on("session_start", (_event, ctx) => {
    invalidateApprovals();
    sessionMode = undefined;
    sessionRules = [];
    exactCalls = new Set();
    sandboxOverride = undefined;
    const { env: policyEnv, merged: mergedConfig } = loadState(ctx);
    if (isChild()) {
      const inherited = decodeSessionContext(process.env[INHERITED_CONTEXT_ENV], policyEnv.cwd);
      if (inherited) {
        sessionRules = inherited.rules.map(text => parseRule(text, "allow", "session"));
        exactCalls = new Set(inherited.exactCalls);
        sandboxOverride = inherited.sandboxOverride;
      }
    }
    publishContext();
    setStatus(ctx, resolveMode(mergedConfig));
  });

  pi.on("session_shutdown", () => {
    invalidateApprovals();
    sessionRules = [];
    exactCalls.clear();
    if (!isChild()) {
      delete process.env[INHERITED_CONTEXT_ENV];
      delete process.env.PI_PERMISSIONS_INHERITED_MODE;
    }
  });

  pi.on("tool_call", async (event, ctx): Promise<ToolCallEventResult | undefined> => {
    const toolEvent = event as unknown as { toolName: string; input: Record<string, unknown> };
    const revision = policyRevision;
    const signal = ctx.signal ? AbortSignal.any([ctx.signal, policyAbort.signal]) : policyAbort.signal;
    const stale = (): boolean => revision !== policyRevision || signal.aborted;
    const staleResult = (): ToolCallEventResult => ({ block: true, reason: "Blocked: permission request cancelled or policy changed; retry under the current policy." });
    try {
      if (stale()) return staleResult();
      const classification = classify(ctx, event.toolName, event.input as Record<string, unknown>);
      const key = callKey(ctx, event.toolName, event.input as Record<string, unknown>);
      const { decision, mode } = decideFor(ctx, classification, key);
      setStatus(ctx, mode);

      if (decision.action === "allow") {
        applySandbox(toolEvent);
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
          applySandbox(toolEvent);
          return undefined;
        }
        const active = reviewerFor(ctx, merged!);
        if (active) {
          const verdict = await active.review({
            ctx,
            toolName: event.toolName,
            // The reviewer gets the whole call, newlines included; reviewer.ts
            // bounds the payload itself. The 240-char dialog summary would cut
            // long commands and erase the block structure of embedded code.
            toolInput: describeInput(event.toolName, event.input as Record<string, unknown>),
            staticAnalysis: reason,
            signal,
          });
          if (stale() || resolveMode(merged!) !== mode || callKey(ctx, event.toolName, event.input as Record<string, unknown>) !== key) return staleResult();
          if (verdict?.verdict === "allow") {
            applySandbox(toolEvent);
            return undefined;
          }
          if (verdict) reason = `${reason} — reviewer: ${verdict.reason}`;
        }
      }

      // ask — but children can never be asked (§6.3).
      const canAsk = ctx.hasUI && !isChild();
      const grantDirectory = decision.tier === "dangerous" && env ? grantableDirectory(classification, env) : undefined;
      if (grantDirectory) {
        reason = `${reason} — add ${grantDirectory} to additionalDirectories to allow this permanently`;
      }
      if (!canAsk) {
        return {
          block: true,
          reason: `Blocked by pi-permissions (${decision.tier}, ${decision.ruleId ?? "policy"}): ${reason}. No approval is possible in this run (headless). Ask the user to run it, or adjust .pi/permissions.json.`,
        };
      }

      return await prompter.withApproval(async ask => {
        if (stale() || callKey(ctx, event.toolName, event.input as Record<string, unknown>) !== key) return staleResult();
        const currentClassification = classify(ctx, event.toolName, event.input as Record<string, unknown>);
        const current = decideFor(ctx, currentClassification, key);
        if (current.decision.action === "deny") return { block: true, reason: current.decision.reason, ...(current.decision.tier === "forbidden" ? { terminate: true } : {}) };
        if (current.decision.action === "allow") {
          applySandbox(toolEvent);
          return undefined;
        }
        const allowRules = current.decision.allowAlwaysOffered ? buildAllowRules(currentClassification, env!) : [];
        const outcome = await ask({
          dangerous: current.decision.tier === "dangerous",
          readOnly: current.mode === "read-only",
          toolName: event.toolName,
          reason,
          summary: summarizeInput(event.toolName, event.input as Record<string, unknown>),
          allowRules,
          allowSession: !current.decision.askedByRule,
          ...(grantDirectory ? { grantDirectory } : {}),
          deps: { select: (t, o, d) => ctx.ui.select(t, o, d), input: (t, p, d) => ctx.ui.input(t, p, d), signal },
        });

        if (stale() || resolveMode(merged!) !== current.mode || callKey(ctx, event.toolName, event.input as Record<string, unknown>) !== key) return staleResult();
        // Config and classification may have changed while the dialog was open.
        const after = decideFor(ctx, classify(ctx, event.toolName, event.input as Record<string, unknown>), key);
        if (after.decision.action === "deny") return { block: true, reason: after.decision.reason, ...(after.decision.tier === "forbidden" ? { terminate: true } : {}) };
        if (after.decision.tier !== current.decision.tier || after.decision.askedByRule !== current.decision.askedByRule) return staleResult();
        switch (outcome.outcome) {
          case "allow-once":
            applySandbox(toolEvent);
            return undefined;
          case "allow-session":
            if (outcome.rules.length === 0) exactCalls.add(key);
            for (const text of outcome.rules) sessionRules.push(parseRule(text, "allow", "session"));
            publishContext();
            applySandbox(toolEvent);
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
            publishContext();
            applySandbox(toolEvent);
            return undefined;
          }
          case "allow-directory": {
            if (outcome.directory) {
              try {
                appendAdditionalDirectory(globalFile(), env!.cwd, outcome.directory);
                loadState(ctx); // pick the new directory up for the next call
                publishContext();
              } catch (error) {
                try {
                  ctx.ui.notify(
                    `pi-permissions: could not persist ${outcome.directory} (${String(error)}); allowed once.`,
                    "warning",
                  );
                } catch {
                  // ignore
                }
              }
            }
            applySandbox(toolEvent);
            return undefined;
          }
          case "deny": {
            const feedback = outcome.feedback ? ` — user said: ${outcome.feedback}` : "";
            return { block: true, reason: `Denied by the user: ${reason}${feedback}` };
          }
        }
      });
    } catch (error) {
      // Fail closed: ask if possible, deny otherwise; never let a plugin bug
      // silently execute or crash pi.
      try {
        ctx.ui.notify(`pi-permissions internal error: ${String(error)}`, "error");
      } catch {
        // ignore
      }
      const canAsk = ctx.hasUI && !isChild() && !stale() && merged && resolveMode(merged) !== "read-only";
      if (canAsk) {
        try {
          return await prompter.withApproval(async ask => {
            if (stale() || !merged || resolveMode(merged) === "read-only") return staleResult();
            const outcome = await ask({
              dangerous: true, readOnly: false, toolName: event.toolName,
              reason: `internal error — approve anyway? ${String(error)}`, summary: "",
              allowRules: [], allowSession: false,
              deps: { select: (t, o, d) => ctx.ui.select(t, o, d), input: (t, p, d) => ctx.ui.input(t, p, d), signal },
            });
            if (outcome.outcome === "allow-once" && !stale() && resolveMode(merged) !== "read-only") return undefined;
            return { block: true, reason: `Blocked by pi-permissions (internal error): ${String(error)}` };
          });
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
        const { source } = effectiveMode(mergedConfig);
        setStatus(ctx, mode);
        publishContext();
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
            `rules: ${mergedConfig.rules.length} (+${sessionRules.length} session, ${exactCalls.size} exact calls)${invalid.length ? `\ninvalid: ${invalid.join(", ")}` : ""}`,
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
        invalidateApprovals();
        sessionMode = wanted;
        let saved = false;
        if (save) {
          try {
            saveGlobalMode(globalFile(), wanted);
            saved = true;
          } catch (error) {
            ctx.ui.notify(`pi-permissions: could not save mode (${String(error)})`, "warning");
          }
        }
        const effective = effectiveMode(mergedConfig);
        publishContext();
        setStatus(ctx, effective.mode);
        const override = effective.mode !== wanted ? `; requested ${wanted} is overridden by ${effective.source}` : "";
        ctx.ui.notify(`pi-permissions mode: ${effective.mode} (${effective.source})${saved ? "; saved globally" : ""}${override}`, "info");
        return;
      }

      if (sub === "rules") {
        const lines = [
          ...mergedConfig.rules.map((rule) => `${rule.kind.padEnd(5)} ${rule.source.padEnd(13)} ${rule.text}`),
          ...sessionRules.map((rule) => `${rule.kind.padEnd(5)} ${"session".padEnd(13)} ${rule.raw}`),
        ];
        if (exactCalls.size > 0) lines.push(`session: ${exactCalls.size} exact-call approval(s), scoped to cwd and shell settings`);
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
        const { decision } = decideFor(ctx, classification, callKey(ctx, tool, inputObj));
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
          invalidateApprovals();
          sandboxOverride = action === "on";
          if (save) {
            try {
              saveGlobalSandboxEnabled(globalFile(), sandboxOverride);
            } catch (error) {
              ctx.ui.notify(`pi-permissions: could not save sandbox setting (${String(error)})`, "warning");
            }
          }
          publishContext();
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
        invalidateApprovals();
        loadState(ctx);
        publishContext();
        const after = merged!;
        setStatus(ctx, resolveMode(after));
        ctx.ui.notify("pi-permissions: configuration reloaded", "info");
        return;
      }

      ctx.ui.notify("Usage: /permissions [mode <m> [--save] | sandbox [on|off [--save]|status] | rules | check <tool> <input> | reload]", "warning");
    },
  });
}
