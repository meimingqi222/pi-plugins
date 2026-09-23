# Agent Note: Give the user the liveness surface the model already had

Status: implemented

## Problem

Four gaps, all at the same seam: a run that lasts minutes had no surface the
user could see it on.

1. **The rich renderer was model-only.** `workflow_status` rendered phase, agent
   counts by status, per-agent ages, tokens, the age of the last progress event
   and the declared cap. `/workflows` printed one `formatRun` line per active
   run — `wf_x  running  name  18.8s` — because `formatRun` has no detail to add
   while a run is still going (`result` and `message` are both unset). The human
   surface was strictly worse than the machine one, and `live-status.ts` said so
   in prose: *"/workflows is the human surface and only reports that runs
   exist."* Which is the wrong way round: the model is told when a run settles,
   the user is the one sitting in front of it.

2. **The same run was listed twice, the second time misleadingly.** The disk
   summary came from a journal still being written, so a live run appeared again
   as `unfinished  no calls  0s` — a worse description of the run already
   described above it.

3. **The only announcement scrolled away.** A launch produced a `notify`, which
   is gone within seconds. Nothing then indicated that anything was running, so
   the normal experience of a working plugin was a session that looked idle.

4. **Exceeding a declared cap was reported as silence.** `agentTimeoutMs` is
   enforced in `pi-executor` by a real timer that SIGKILLs the child, so an
   agent still marked running past its own cap is not a slow agent — the bound
   did not fire. That is the one silence with evidence behind it, and the status
   left it in the same bucket as "no progress recently".

## Decision

**One renderer, two callers.** `/workflows` now renders active runs with
`renderLiveStatus`, the same function `workflow_status` uses. A run id stays on
the first line, so `stop <runId>` still reads the same. Two renderers for one
truth is how they drift apart; the footer and the command now cannot disagree.

**A live run is not repeated from disk.** The disk listing is filtered by the
run ids this registry holds. Only this registry: a run left on disk by another
process is still listed, because its summary is the only evidence there is.

**A footer slot, not a notification.** `formatFooterStatus` produces
`wf 3m 12s · 1-repos · 3 running` (or `wf 2 runs · …`), and
`createFooterReporter` owns the timer. It claims the slot only while something
runs, writes only when the text changed, ticks once a second, and gives the slot
back with `setStatus(key, undefined)` on the last settlement and on shutdown.
The interval is created on the first launch and cleared on the last settlement —
a permanent interval is a timer that outlives its reason, and in a one-shot mode
it is a process that will not exit — and it is `unref`'d as well.

**`/workflows live`, a panel rather than a snapshot.** The notification is
correct when printed and stale a second later. The panel re-renders itself,
clips every line with `truncateToWidth` (labels and phases can contain wide
characters, which cutting by code units would corrupt), and handles
`q`/`Esc` to close, `s` to stop all runs, `r` to repaint — ignoring key-release
events, which the Kitty protocol sends for the same key. TUI only: RPC clients
cannot render a component, and there the command degrades to the listing. It is
deliberately not the default `/workflows` behaviour — taking over the screen is
a different interaction, and one the user asks for by name.

**`/workflows <runId>`, one run in full.** The listing answers "what has been
running here"; the question about one run is asked about one run, and the run id
is already the handle the user holds for `stop`.

**Overdue agents are named.** `overdueAgents` compares each running agent's age
against the run's declared cap and reports the ones past it. No declared cap
means nothing to compare against, so the age is still reported and the
judgement still left to the reader.

## Consequences

`/workflows` output grew from one line per active run to the block
`workflow_status` already produced, and a live run appears once instead of
twice. A run is visible from the footer without asking, and the slot is
indistinguishable from untouched when nothing runs. The plugin now depends on
`@earendil-works/pi-tui` (devDependency, matching `pi-ace-search`) for the panel
and its width handling. `formatRunSummary` exposes the per-run lines of the
disk listing, which `formatWorkflowStatus` used to keep private.

## Alternatives considered

**Give `/workflows` its own richer one-liner and leave the notification.** A
per-run line with phase and counts costs about the same code. Rejected because
the two surfaces then describe the same run in two formats, and the block
`workflow_status` already produces is the one with room for a failed agent's id
and reason — the thing that decides whether to stop the run.

**Keep the active run in the disk listing, marked "live above".** It preserves
the start clock the live line omits. Rejected: the row's own fields
(`unfinished`, `no calls`, `0s`) are computed from a journal that is still
being written, so the annotation would be fighting the line it is attached to.

**Write the footer on every progress event instead of ticking.** Progress is
emitted per phase and per agent call, so a run whose agents each take four
minutes would show a frozen age for four minutes — the symptom the footer
exists to remove. The tick is what keeps the number honest, and the
change-only write is what keeps it cheap.

**Make `/workflows` open the panel whenever something is running.** Fewer
commands to remember. Rejected: a command that printed a listing should keep
printing a listing; seizing the screen is a different interaction, and one the
user should ask for.

**Strip the panel down to plain strings instead of depending on `pi-tui`.**
Avoids a dependency. Rejected on correctness: agent labels and phases carry
wide characters, and clipping a wide character in half desynchronises the
frame the overlay is drawn in. `pi-ace-search` already takes this dependency
for the same reason.

## Verification

- `plugins/workflow/test/plugin-wiring.test.ts` — "describes the active run
  instead of naming it" (phase, agent counts, tokens, cap, and the run id
  appearing exactly once across the whole output); "<runId> answers about that
  one run"; "the footer entry appears while a run is live and is handed back at
  shutdown"; "live falls back to a listing where no component can be drawn".
- `plugins/workflow/test/footer.test.ts` — silent until something runs; the slot
  is handed back and the ticker stops on the last settlement; a tick that cannot
  have changed the text does not write; `dispose` is idempotent; a second sink
  is written to even when the text is unchanged.
- `plugins/workflow/test/panel.test.ts` — renders the same text as the status
  tool; every line fits at widths 10/24/40 with a wide-character label; `q` and
  `Esc` close; `s` stops without closing; a key release does not close it.
- `plugins/workflow/test/live-status.test.ts` — the `formatFooterStatus` cases
  (undefined when idle, phase and in-flight count, multiple runs, `past
  timeout`, nothing dropped in when unknown) and "flags an agent that outlived
  its own timeout", which also pins that an agent inside its cap and a run with
  no cap are not flagged.

Proved: reverting the active section to `formatRun` fails "describes the active
run instead of naming it" on `phase: review` — the line has no phase in it.
Removing the `activeIds` filter fails the same test's occurrence count (2, not
1): the live run is described again below as `unfinished`. Making the footer
write unconditionally fails "writes only when the text changes" on a second
tick with a frozen clock.

Full workspace: 702 pass, 0 fail; typecheck clean on every package; the
regression-notes verifier accepts this tree.
