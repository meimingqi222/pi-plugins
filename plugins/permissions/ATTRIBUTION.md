# Attribution

`pi-permissions`'s shell-analysis approach is adapted from
[`stepfun-ai/Step-Code`](https://github.com/stepfun-ai/Step-Code), MIT licensed.

| File here | Origin in Step-Code |
| --- | --- |
| `src/shell/parse.ts` | traversal/unwrap structure from `packages/coding-agent/src/step/shell-analysis.ts` and `command-policy.ts` (wrapper/flag tables, recursion into `bash -c`/`eval`/`find -exec`) |

Why adapted rather than vendored: Step-Code's analyzer tracks variable
assignments, heredoc boundaries, and stdin dataflow that this plugin does not
need — the port keeps the AST walk, wrapper unwrapping, and recursion while
dropping everything else.

## Deliberate divergence from upstream

| Behaviour | Step-Code | Here | Reason |
| --- | --- | --- | --- |
| Path checks | none — `read ~/.ssh/id_rsa` was unrestricted | `sensitive-path`/`protected-write` lists on every read/write intent | Largest gap in the upstream design; credentials were the point of this plugin. |
| Unresolved analysis | required confirmation | `grey` + raw-text fallback for catastrophic rules only | `yolo` is the default mode; confirming every dynamic command would drown the user. |
| Rule set | 7 dangerous patterns | forbidden/dangerous/safe lists per the design doc | Two-tier model borrowed from minimax-code's HARD/SOFT split. |
