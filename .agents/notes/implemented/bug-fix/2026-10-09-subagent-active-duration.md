# Agent Note: Subagent duration excludes reply waiting

Status: implemented

## Problem

Fleet widgets, panels and tool status measured child process age. A completed
turn kept accumulating work time while its child was awaiting a reply. Shared
summaries also included time after settled tasks had finished.

## Decision

LaneRegistry accumulates completed active intervals and resumes a fresh
interval for each reply. Repeated idle/start signals leave the clock unchanged.
A rejected reply restores its original idle timestamp without spending the
attempted interval. laneElapsedMs feeds all fleet surfaces. Shared summaries
report the longest actual duration, including supplied active time. Tool status
renders waiting as idle/awaiting a reply instead of finishing.

## Alternatives considered

- Freeze at first completion forever: later reply turns would never count.
- Subtract only the current idle gap: earlier waits would return on resume.
- Fix just the widget: panel and tool text would still disagree.

## Consequences

startedAt remains the creation time; elapsedMs holds completed active intervals.
Legacy records use idle/finish timestamps. Deadline and keepalive semantics
remain the same. The paused duration also stays frozen after retirement.

## Verification

- `plugins/subagent/test/lane.test.ts::reply turns count active time and exclude every idle gap`
- `plugins/subagent/test/fleet.test.ts::idle work duration freezes across every fleet surface`

Proved: Before implementation, the interval test received undefined instead
of 20000, and the fleet assertion received 30s instead of 20s. Output is saved
in `.agents/notes-evidence/2026-10-09-task-timing-red.txt`. Both pass with the fix.
