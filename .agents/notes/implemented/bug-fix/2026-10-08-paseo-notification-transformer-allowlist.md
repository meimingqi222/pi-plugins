# Agent Note: Keep the Paseo companion loadable by targeting only transformable timeline items

Status: implemented

## Problem

The companion registered a timeline transformer for `notification` items so that
`PI_RPC_PROGRESS_TRANSPORT=notify` status would render as a card. Paseo's app client validates every
transformer target against a closed allowlist and throws `Timeline transformer
pi-work-notification has invalid item type: notification` for anything outside it. The throw happens
inside the client contribution function, so Paseo marked the whole plugin failed and rolled back its
registrations: with the companion installed, no card rendered at all, including the ones the default
transport feeds.

The allowlist is `TIMELINE_ITEM_TYPES` in `packages/app/src/plugins/evaluate.ts`: `user_message`,
`assistant_message`, `reasoning`, `tool_call`, `todo`, `error`, `compaction`. It excluded
`notification` when transformers landed and still does, so the notification transformer could never
have worked; it went unnoticed because the companion had only been exercised against the daemon, not
against a running app client. Verified against the installed app 0.11.1 bundle and against the
`v0.10.3` and `v0.11.0` tags.

## Decision

Register only `assistant_message` and `tool_call` transformers; drop the `notification` transformer
and its `transformStatusNotification` export. Cards cover the default `message` transport, and
notify-transport status stays a native notification row, which already carries the same five
readable lines. `integrations/paseo-ui/test/contribution.test.ts` re-implements the app's
contribution host with the allowlist as its oracle and asserts that every registered target is
accepted, so widening a target without checking the app fails a test instead of failing the plugin
silently on install.

## Alternatives considered

- Register the transformer inside a guarded probe and ignore a rejected target: keeps a code path no
  Paseo release has ever allowed and swallows a host error whose text is not a stable contract, so it
  could also hide a genuine registration bug.
- Publish notify status through a daemon-appended plugin row, which the app does render: needs a
  server entry that observes the daemon's own notifications to republish them, a second rendering
  path for one host, and duplicate rows once the app allows transforming notifications.
- Raise `requirements.paseo` to exclude the versions that reject the target: every released version
  rejects it, so the manifest would have to exclude all of them, and the failure mode would stay an
  install-time error rather than a fix.
- Report the allowlist gap upstream and wait: the companion would stay broken for every installed
  user in the meantime.

## Consequences

Cards work on the supported hosts again, and the notify transport keeps its benefit of immediate
delivery with native rendering instead of cards. A future Paseo release that admits `notification`
does not light the transformer up again; re-adding it requires editing both the contribution and the
test's allowlist, which is the intended check. The companion README and the root README now state
that cards are limited to the `message` transport.

## Verification

- `integrations/paseo-ui/test/contribution.test.ts::the Paseo app client accepts every timeline transformer this companion registers`
- `integrations/paseo-ui/test/status.test.ts`
- `integrations/paseo-ui/test/card.test.tsx`

Proved: Before the fix, the new test failed with the host's own error, `Timeline transformer
pi-work-notification has invalid item type: notification`, because `contribute()` threw. After
removing the transformer, the same test passes and asserts the registered targets are exactly
`assistant_message` and `tool_call`. Output: `regression-evidence/paseo-notification-red.txt`.
