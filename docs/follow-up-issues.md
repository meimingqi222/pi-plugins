# Follow-up issues

These observations were reported by a separate review agent. They have not
been independently reproduced in this change and are intentionally deferred.

- **Agent runner parent death:** Detached POSIX child process groups may survive
  abrupt host termination, including SIGKILL, until their own timeout. Investigate
  portable parent-death handling and document any unavoidable orphan window.
- **Workflow semaphore handoff:** Check whether decrementing the active count
  before an awakened waiter increments it permits a new caller to barge and
  exceed the concurrency limit. Prefer direct slot transfer if reproduced.
- **Workflow history loading:** Check whether `listWorkflowRuns` reads every
  journal before applying the display limit. Consider sorting metadata and
  reading only the selected runs, without changing result ordering semantics.
- **Morph compaction redaction:** The Morph bridge still declares a local service
  interface and permits an unredacted upload when no redaction service is
  installed. Review importing the shared type and whether a fail-closed default
  is appropriate; document the compatibility and user-facing behavior.
