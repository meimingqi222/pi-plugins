/**
 * A run's spend limit, tracked on two axes at once.
 *
 * Token budget alone is not enough to bound a fan-out: a hundred agents that
 * each return one line cost almost nothing in tokens and still saturate the
 * provider and the host. Agent budget alone is not enough either, and that is
 * the sharper failure — a single agent handed a large context can outspend a
 * whole panel of small ones, so a cap on *calls* does not bound *cost*.
 *
 * Both axes therefore exist, and the first one exhausted stops new work. The
 * check is fail-closed: `admit()` throws rather than warning, so a caller cannot
 * accidentally continue by ignoring a return value. A `parallel()` panel must
 * call it for every item before launching any child, so a panel that would
 * cross the limit is refused whole instead of half-run.
 *
 * Accounting is passive for tokens, because usage is only known after a call
 * settles. The limit therefore bounds *admission*, and a call already admitted
 * may overshoot; `record()` reports the overrun so the run can settle as
 * budget-limited rather than pretending it finished inside the limit.
 */

export interface RunBudgetLimits {
  /** Provider input+output tokens. `undefined` means unbounded. */
  tokens?: number | null;
  /** Admitted child-agent calls. `undefined` means unbounded. */
  agents?: number | null;
}

export interface RunBudgetState {
  tokens: number;
  agents: number;
  /** One past the token limit, when the limit was crossed after admission. */
  overspentTokens: number | null;
}

export class RunBudgetExceeded extends Error {
  readonly axis: "tokens" | "agents";
  readonly limit: number;
  readonly spent: number;

  constructor(axis: "tokens" | "agents", limit: number, spent: number) {
    super(
      axis === "agents"
        ? `Run agent budget exhausted (${spent}/${limit}); no budget remains for another agent call`
        : `Run token budget exhausted (${spent}/${limit}); no budget remains for another model call`,
    );
    this.name = "RunBudgetExceeded";
    this.axis = axis;
    this.limit = limit;
    this.spent = spent;
  }
}

function bound(value: number | null | undefined, label: string): number | null {
  if (value === null || value === undefined) return null;
  if (!Number.isFinite(value) || value < 0) throw new Error(`Run budget ${label} must be null or a non-negative finite number`);
  return Math.floor(value);
}

export class RunBudget {
  private readonly tokenLimit: number | null;
  private readonly agentLimit: number | null;
  private tokens = 0;
  private agents = 0;
  private overspentFlag = false;
  private refusedFlag = false;

  constructor(limits: RunBudgetLimits = {}) {
    this.tokenLimit = bound(limits.tokens, "tokens");
    this.agentLimit = bound(limits.agents, "agents");
  }

  /** Whether any axis is bounded. A run with no limits skips the admission check. */
  get bounded(): boolean {
    return this.tokenLimit !== null || this.agentLimit !== null;
  }

  /** Limit for one axis, or null when unbounded. */
  limit(axis: "tokens" | "agents"): number | null {
    return axis === "tokens" ? this.tokenLimit : this.agentLimit;
  }

  /**
   * Admit one agent call, or throw.
   *
   * Call this for every item of a panel *before* starting any child; the throw
   * is the panel's signal to refuse the whole panel rather than run a prefix of
   * it. Tokens are not checked here against the next call's unknown cost — only
   * against budget already spent, since admitting work that might overshoot is
   * the documented behaviour of a passive token budget.
   */
  admit(agentCalls = 1): void {
    if (agentCalls < 0) throw new Error("Agent call count cannot be negative");
    if (this.agentLimit !== null && this.agents + agentCalls > this.agentLimit) {
      this.refusedFlag = true;
      throw new RunBudgetExceeded("agents", this.agentLimit, this.agents + agentCalls);
    }
    if (this.tokenLimit !== null && this.tokens >= this.tokenLimit) {
      this.refusedFlag = true;
      throw new RunBudgetExceeded("tokens", this.tokenLimit, this.tokens);
    }
    this.agents += agentCalls;
  }

  /**
   * Whether `agentCalls` more agents could be admitted, without reserving them.
   *
   * `admit()` is the enforcement point and reserves one call at a time. This is
   * the panel's preview: a `parallel()` panel asks once for its whole width
   * before starting any child, so a panel that would cross the limit is refused
   * whole rather than half-run. It does not reserve, because the panel's tasks
   * each admit their own call — a reservation here would double-count them.
   * Between the check and the admits another panel can consume the budget, so
   * this narrows the window rather than closing it; the admits remain the bound.
   */
  check(agentCalls = 1): void {
    if (agentCalls < 0) throw new Error("Agent call count cannot be negative");
    if (this.agentLimit !== null && this.agents + agentCalls > this.agentLimit) {
      this.refusedFlag = true;
      throw new RunBudgetExceeded("agents", this.agentLimit, this.agents + agentCalls);
    }
    if (this.tokenLimit !== null && this.tokens >= this.tokenLimit) {
      this.refusedFlag = true;
      throw new RunBudgetExceeded("tokens", this.tokenLimit, this.tokens);
    }
  }

  /**
   * Give an admitted call back, because it turned out to cost nothing.
   *
   * A resumed call served from the journal is admitted by the host before the
   * orchestrator knows it is a cache hit, so without this a resume would spend
   * agent budget on work it did not do.
   */
  release(agentCalls = 1): void {
    if (agentCalls < 0) throw new Error("Agent call count cannot be negative");
    this.agents = Math.max(0, this.agents - agentCalls);
  }

  /**
   * Whether the budget turned any work away.
   *
   * The complement of `overspent`: an overspent run crossed its token limit
   * after admission, and a refused one was stopped before starting. A caller
   * that reports a run without these two facts leaves the user to reconstruct
   * them from the journal, which is the same as not reporting them.
   */
  get refused(): boolean {
    return this.refusedFlag;
  }

  /** Record settled usage. Tokens may push the total past the limit; that is reported, not undone. */
  record(tokens: number): void {
    if (!Number.isFinite(tokens) || tokens < 0) return;
    this.tokens += Math.floor(tokens);
    if (this.tokenLimit !== null && this.tokens > this.tokenLimit) this.overspentFlag = true;
  }

  /**
   * Whether the run crossed its token limit after admission.
   *
   * Distinguished from `exhausted` because the two settle differently: an
   * overspunt run stopped mid-work, while an exhausted one stopped before
   * starting. A caller that reports them the same way tells the user the run
   * finished inside a budget it actually exceeded.
   */
  get overspent(): boolean {
    return this.overspentFlag;
  }

  /** Whether no further call can be admitted. */
  get exhausted(): boolean {
    if (this.agentLimit !== null && this.agents >= this.agentLimit) return true;
    return this.tokenLimit !== null && this.tokens >= this.tokenLimit;
  }

  /** Current counters, for persistence and display. */
  state(): RunBudgetState {
    return {
      tokens: this.tokens,
      agents: this.agents,
      overspentTokens: this.overspentFlag ? this.tokens : null,
    };
  }

  /**
   * Seed counters from a persisted snapshot without re-admitting them.
   *
   * The counters are a budget's whole state, so a caller that wants one budget to
   * span a resume chain restores the previous run's. A workflow run does not:
   * each execution's budget bounds the work that execution does, and a reused
   * call releases the slot it was admitted, because it costs nothing. This method
   * is the seam for the other choice rather than a claim that it was made —
   * choosing it also needs the counters persisted per run, since the previous
   * run's result does not outlive the session.
   */
  restore(state: Partial<RunBudgetState>): void {
    if (state.tokens !== undefined && Number.isFinite(state.tokens) && state.tokens > 0) {
      this.tokens = Math.floor(state.tokens);
    }
    if (state.agents !== undefined && Number.isFinite(state.agents) && state.agents > 0) {
      this.agents = Math.floor(state.agents);
    }
    if (this.tokenLimit !== null && this.tokens > this.tokenLimit) this.overspentFlag = true;
  }
}
