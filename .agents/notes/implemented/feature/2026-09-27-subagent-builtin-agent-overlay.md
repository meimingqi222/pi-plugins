# Agent Note: A built-in agent can be overridden one field at a time

Status: implemented

## Problem

Agents are markdown files under `~/.pi/agent/agents/*.md`, and until now a
same-name file **replaced** the built-in wholesale: its frontmatter supplied the
description, tools and model, and its body supplied the whole prompt. Discovery
kept the built-in only when no user file named it.

That made the smallest useful customisation — "run `explore` on a cheaper model"
— the most expensive one to express. The user had to copy the built-in's
description, its `read/grep/find/ls` allowlist and its four-line prompt into
their own file, and from then on the copy was unreviewed fork of the catalog: a
change to the built-in's prompt or tool list could not reach it, and nothing
signalled the divergence.

The copy was also the only *safe* form. `tools` omitted means pi's default tool
set everywhere else in the module, so a user file that wanted to change just the
model and left `tools` out did not narrow anything — it handed `explore`, a
read-only agent by construction, write and shell access. The override that looked
like a one-line change was a silent capability escalation.

## Decision

`src/agents.ts` splits reading a file from defining an agent:

- `readAgentFields(filePath)` returns a `UserAgentFields` — the fields exactly as
  written, every field below `name` optional. It keeps the strictness a merge
  must not relax: a file with no usable `name`, or with an explicit `tools`
  allowlist that parses to nothing (`tools: []`, `tools: 3`), is unusable whatever
  it names.
- `readAgentFile(filePath)` is the standalone reading: `readAgentFields` plus a
  required description, which is what a file naming a new agent needs. Its
  behaviour is unchanged, so callers of the old reader see the old contract.
- `discoverAgents` resolves each file against the built-in it names
  (`resolveUserAgent`): a present field wins, an absent field is inherited.

Inheritance fills `description`, `tools`, `model`, and the prompt (an empty body
leaves the built-in's prompt in place). Two properties are load-bearing:

- **`tools` inherits the built-in's allowlist, never pi's default set.** This is
  the fail-closed half and the reason a partial override is allowed at all. A
  name with no built-in keeps the old meaning of an omitted `tools`: pi's
  default set.
- **Inheritance always reads from `BUILTIN_AGENTS`, never from another user
  file.** Two files claiming one name cannot leak fields into each other; the
  readdir-order winner overlays the built-in on its own.

A file naming a new agent must still stand alone: a description is what the model
chooses between, and nothing supplies one.

The result is that retargeting a built-in's model is three lines and no copy:

```markdown
---
name: explore
model: provider/small-model
---
```

README's "Overriding a built-in's model" section documents the field-by-field
rule, both fail-closed rules, and the still-standing one-file-per-agent
discovery; `catalog.ts`'s comment now says "field by field"; the two notes that
described the old semantics were corrected in the same change.

## Alternatives considered

**Keep whole-file replacement and tell users to copy.** Rejected: it makes the
common case the costly one and turns every override into a fork that cannot
receive catalog fixes. The prompt is the part that must not drift.

**Require the file to restate `tools` explicitly for built-in names.** Rejected:
it re-adds the copy for the field where getting it wrong is a capability change.
Inheriting is the fail-closed default, and an explicit list still wins.

**Refuse to inherit, and treat an omitted `tools` as "pi's default" for
overrides too.** Rejected: it is the escalation above, and it fails silently — a
wrong model is visible in the tool details, a widened tool list is not.

**A `~/.pi/agent/subagents.json` map of agent → model.** Rejected: it is a second
definition path, a fourth precedence level (`call` > json > md > parent) and a
single point of failure — one malformed bracket would disable every override,
against this module's one-bad-file-must-not-win rule. A whole-file format also
cannot carry the prompt, so it would exist only to hold the field a three-line
markdown file already holds. It stays the right container if a cross-agent lever
ever appears (a default model for all agents, per-agent timeout), and that would
be one new file with one precedence rule — not a second way to define an agent.

## Consequences

A user file naming a built-in is now read even without a description of its own,
so "unusable file" means nameless or malformed-allowlist and no longer includes
"no description" for that case; the malformed-file note was corrected to say so.
`UserAgentFields` and `readAgentFields` join the module's exports, because the
standalone reader can no longer be the only reader of a file.

Partial overrides are visible where they matter: the resolved model is already
reported in the tool details, and the guide the model reads still lists the
catalog's built-ins, so a changed description reaches the human reading the file
rather than the model choosing an agent. Two user files claiming one name remain
last-wins by readdir order; the change makes their inheritance deterministic
(from the built-in) but does not make the duplicate itself diagnosable.

Pinning a model also drops the parent's thinking level for that agent, because
`tool.ts` forwards `ctx.effort` only when neither override is set. That is the
existing rule rather than a new one, but this feature is what makes it reachable
by accident: an agent given its own `model` runs at that model's default effort.
An `effort` field in the overlay is the obvious follow-up if a pinned model that
should keep a non-default level becomes a real case.

## Verification

- `plugins/subagent/test/agents.test.ts` — "a model-only file retargets a
  built-in and inherits the rest" (model replaced, description/tools/prompt
  identical to the built-in, other built-ins untouched); "an override that omits
  tools keeps the built-in allowlist instead of pi's default" (the escalation
  guard, plus a name with no built-in still falling through to pi's default);
  "a malformed allowlist still skips the file rather than inheriting";
  "an override may name a new agent only with a description of its own".
- `plugins/subagent/test/agents.test.ts` — the earlier "a user definition with
  the same name replaces the built-in" test still passes, because a file that
  states every field has nothing to inherit.

Proved: reverting `resolveUserAgent`'s `tools: fields.tools ?? builtin.tools` to
`tools: fields.tools` failed "a model-only file retargets a built-in and inherits
the rest" and "an override that omits tools keeps the built-in allowlist instead
of pi's default", then passed again once restored (14 pass, 0 fail).
