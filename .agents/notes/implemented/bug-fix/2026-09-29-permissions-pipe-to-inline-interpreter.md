# Agent Note: A pipe into an inline-program interpreter delivers data, not code

Status: implemented

## Problem

A routine diagnostic command was graded dangerous:

```
ps -p 25898,25900 -o pid,stat,etime,command | cut -c1-80; kill -USR1 25900; sleep 3; for p in 9229 9230 9231; do printf "%s: " $p; curl -s --max-time 2 http://127.0.0.1:$p/json/list | node -e "let d='';process.stdin.on('data',…JSON.parse(d)…"; done
```

```
[pi-permissions] DANGEROUS bash
remote download piped into a shell/interpreter
```

`pipe-to-shell` matched `curl … | node …` and never looked at how `node` gets its
program. `node -e '<literal>'` takes the program from argv; the pipe carries only
data. The shape is `curl | jq` with a different parser, and the inline program
is visible in the command line where the classifier could already read it.

Cost: the pipeline cannot run unattended at all. `dangerous` is an ask, and an
ask in a delegated child or `--mode json` run becomes a hard block
(`index.ts` — "No approval is possible in this run"), so a subagent probing a
local DevTools endpoint was stopped, not prompted.

## Decision

Relax a pipeline only when **every** interpreter after the fetch takes its
program from a literal argv operand:

```ts
const sinksAfterFetch = pipeline.filter(
  (commandIndex, position) => position > fetchIndex && SHELL_SINKS.has(execNameAt(commandIndex)),
);
if (!sinksAfterFetch.every((commandIndex) => hasInlineProgram(analysis.commands[commandIndex]!))) { …dangerous… }
```

`hasInlineProgram` accepts `-c`, `-e`, `--eval`, `-p`, `--print`, `-m`,
`--module` followed by a literal operand. Three guards keep the relaxation from
swallowing the shape the rule exists for:

- a dynamic operand parses as `undefined`, so `node -e "$(cat p.js)"` and
  `python3 -c "$PROG"` stay dangerous;
- a flag-shaped operand is refused, so `bash -e -s` and `python3 -` — which put
  the program back on stdin — stay dangerous;
- the check covers every sink after the fetch, so `curl … | node -e '<literal>' | sh`
  stays dangerous rather than being cleared by its first sink.

`-s`, `-i` and bare `-` are deliberately absent from the flag set.

## Alternatives considered

**Relax only when the fetch target is loopback.** It would clear the reported
command without touching the interpreter question, but a local server is not
more trustworthy than a remote one (`curl 127.0.0.1:… | sh` is a real shape), and
it would leave `glab api … | python3 -c …` prompting.

**Relax any pipe whose sink is an interpreter that received any literal
argument.** `bash -e -s` and `python3 -` pass that test while reading the program
from stdin — a hole for a one-line saving.

**Adopt minimax-code's rule verbatim.** `allPipeToShellAreInlineLiteralC`
(`classifier/dangerous-patterns.ts`, used by `tools/bash-permission.ts`) accepts
only `-c '<literal>'`, with the same reasoning ("stdin is data and the program is
a fixed argv string … Raw `... | bash` / `... | python` still ASK"). It is the
precedent for this relaxation, but `-c` alone leaves `node -e` — node's spelling
of the same shape — prompting, so the flag set was widened rather than copied.

**Treat the whole pipeline as safe.** Step-Code carries no pipe-to-shell rule at
all (`step/command-policy.ts` has eight approval rules and none of them is curl),
and generates `curl -fsSL <url> | sh` itself for MCP installs. That removes the
false positive and the guard with it.

## Consequences

`curl … | node -e '<literal>'`, `… | python3 -c '<literal>'` and
`… | python3 -m json.tool` grade grey: allowed in yolo, judged by the reviewer in
auto, still asked in ask mode. Every raw form keeps asking.

The trade-off: a literal program that itself executes stdin
(`bash -c 'eval "$(cat)"'`, `node -e 'eval(fs.readFileSync(0,"utf8"))'`) is
relaxed too. A deterministic classifier cannot decide whether a visible program
treats its stdin as data or as code, and the program is in the command line for
the human or the reviewer to read — the same trade minimax-code documents.

## Verification

- `plugins/permissions/test/decide.test.ts` — cases 42–45, added with this fix. Case 42 is the reported shape (`curl … | node -e` with a literal program) and grades grey; case 43 keeps the guard for a program assembled at runtime; case 44 pins that `-s` is not an inline-program flag; case 45 pins that the last sink decides. Case 8 (`curl … | sh`) still pins the original dangerous shape.

Proved: stubbed `hasInlineProgram` to `return false` → `bun test plugins/permissions/test/decide.test.ts`
reported `47 pass, 1 fail` with case 42 failing (`Expected: "allow" / Received: "deny"`)
while 43/44/45 kept passing, then restored → `48 pass, 0 fail`.
