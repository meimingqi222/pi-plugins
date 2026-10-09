/**
 * tier × mode × rules → Action (§3.3, §5.2).
 *
 * Order matters: forbidden → deny rules → read-only floor → mode-specific dangerous floor → mode table →
 * ask rules tighten → allow rules lift. User rules can never downgrade
 * dangerous in guarded modes or forbidden tiers.
 */

import { ruleMatches, type UserRule } from "./rules.ts";
import type { Classification, Decision, Mode, PolicyEnv } from "./types.ts";

export function decide(classification: Classification, mode: Mode, rules: UserRule[], env: PolicyEnv): Decision {
  const { intents, tier, reason, ruleId } = classification;

  // 1. forbidden is an absolute floor.
  if (tier === "forbidden") {
    return { action: "deny", tier, reason, ruleId, allowAlwaysOffered: false };
  }

  // 2. Any intent matching a deny rule blocks the whole call.
  for (const rule of rules) {
    if (rule.kind !== "deny" || !rule.valid) continue;
    for (const intent of intents) {
      if (ruleMatches(rule, intent, env)) {
        return { action: "deny", tier, reason: `matched deny rule "${rule.raw}"`, matchedRule: rule.raw, ruleId, allowAlwaysOffered: false };
      }
    }
  }

  // Read-only is an enforcement boundary, not a confirmation preference.
  if (mode === "read-only" && (tier !== "safe" || classification.mutating)) {
    return { action: "deny", tier, reason: "pi-permissions is in read-only mode", ruleId, allowAlwaysOffered: false };
  }

  // 3. Guarded modes require confirmation; YOLO bypasses classifier prompts.
  if (tier === "dangerous" && mode !== "yolo") {
    return { action: "ask", tier, reason, ruleId, allowAlwaysOffered: false };
  }

  // 4. Mode table (YOLO includes dangerous; explicit rules still apply).
  let action: "allow" | "ask" | "deny";
  switch (mode) {
    case "read-only":
      action = tier === "safe" && !classification.mutating ? "allow" : "deny";
      break;
    case "ask":
      action = tier === "safe" && !classification.mutating ? "allow" : "ask";
      break;
    case "auto":
      action = tier === "safe" ? "allow" : "ask";
      break;
    case "yolo":
      action = "allow";
      break;
  }
  if (action === "deny") {
    return { action: "deny", tier, reason: "pi-permissions is in read-only mode", ruleId, allowAlwaysOffered: false };
  }

  // 5. Ask rules tighten (they outrank allow rules for the same intent).
  const askMatched = new Set<number>();
  const allowCovered = new Set<number>();
  for (let index = 0; index < intents.length; index += 1) {
    const intent = intents[index]!;
    for (const rule of rules) {
      if (!rule.valid) continue;
      if (rule.kind === "ask" && ruleMatches(rule, intent, env)) askMatched.add(index);
      if (rule.kind === "allow" && ruleMatches(rule, intent, env)) allowCovered.add(index);
    }
  }

  const needsAsk = (index: number): boolean => {
    if (askMatched.has(index)) return true;
    if (action !== "ask") return false;
    const intent = intents[index]!;
    return intent.tier !== "safe" || intent.mutating === true;
  };

  const asking = intents.map((_, index) => index).filter(needsAsk);
  if (asking.length === 0) {
    return { action: "allow", tier, reason, ruleId, allowAlwaysOffered: true };
  }
  const uncovered = asking.filter((index) => askMatched.has(index) || !allowCovered.has(index));
  if (uncovered.length === 0) {
    const matched = rules.find((rule) => rule.kind === "allow" && intents.some((intent) => ruleMatches(rule, intent, env)));
    return { action: "allow", tier, reason, ruleId, matchedRule: matched?.raw, allowAlwaysOffered: true };
  }
  return { action: "ask", tier, reason, ruleId, allowAlwaysOffered: tier !== "dangerous", askedByRule: asking.some((index) => askMatched.has(index)) };
}
