# Agent Note: Expose Pi execution progress without depending on TUI widgets

Status: implemented

## Problem

Paseo runs Pi in RPC mode and does not execute extension TUI renderers or widgets. Subagents, workflows, background shell jobs and goals can therefore execute correctly while showing little or no progress in the host. Answer delivery and child transcript settlement do not cover live execution state.

## Decision

Keep native Pi TUI surfaces and independently publish bounded readable RPC work status. The shared host reporter deduplicates changes, coalesces active progress at two seconds, bypasses delay for terminal states and cancels queued work on session changes. Subagent progress retains native host identity and transcript messages, and foreground tool updates stream readable activity before completion. All status messages use triggerTurn false. Background messages default to Pi passive delivery at safe turn boundaries; PI_RPC_PROGRESS_TRANSPORT=notify explicitly opts into immediate notifications on capable hosts.

An optional client companion in integrations/paseo-ui renders the status protocol using Paseo's public timeline SDK and theme. It requires Paseo 0.11.0 or later. It has no dependency from Pi runtime packages and does not patch Paseo or replace its ordinary answers, tools or child navigation.

## Alternatives considered

- Modify Paseo source or patch the installation: conflicts with third-party ownership and introduces an upgrade maintenance burden.
- Make TUI widgets the shared interface: RPC hosts do not invoke those renderers.
- Use progress messages to trigger model turns: turns would change execution and consume tokens merely to update the display.
- Use notifications by default: older Paseo versions do not display RPC notifications; readable passive messages preserve compatibility.

## Consequences

Pi extensions remain independently usable. Unmodified hosts can show plain text, and capable Paseo clients can opt into cards. Passive background progress may wait for the parent turn to settle. The companion does not backport live child transcripts to Paseo 0.10.3. Timeline cards retain history rather than forming a mutable dashboard. Session cleanup prevents queued progress from reaching another session.

## Verification

- `plugins/workflow/test/plugin-wiring.test.ts::RPC workflow publishes launch and final state independently of its answer`
- `plugins/bg-bash/test/plugin.test.ts::RPC background jobs publish running and exited state even with quiet notifications`
- `plugins/goal/test/lifecycle.test.ts::RPC goal exposes active and paused state without replacing TUI status behavior`
- `plugins/subagent/test/paseo.test.ts::RPC launch reports readable progress before the child finishes`
- `plugins/run-core/test/host-work.test.ts`
- `plugins/subagent/test/host-progress.test.ts`
- `integrations/paseo-ui/test/status.test.ts`
- `integrations/paseo-ui/test/card.test.tsx`

Proved: Temporarily disabled the shared reporter RPC publication guard; all three plugin RPC integration tests failed at their missing running/active status assertions. Restored the guard and reran the same tests green. Output: `regression-evidence/rpc-work-red.txt`.

Proved: Temporarily forced subagent progress visibility off; foreground and background held-open-child integration tests failed at the readable progress assertion before child completion. Restored visibility and reran both tests green. Output: `regression-evidence/subagent-progress-red.txt`.
