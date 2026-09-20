/**
 * Vendored from `fast-jev-compaction` v0.2.0 (MIT, tamaratran) so this plugin
 * stays self-contained — that package is not on npm. See ATTRIBUTION.md.
 *
 * Types for the Jev decision model: a transcript, the tool calls inside it, and
 * the keep/drop answers Jev returns for each one.
 */

export type Role = 'user' | 'assistant';

/**
 * A tool_use block of an assistant message. `text` and `isError` mirror the
 * outcome once the transcript holds it.
 */
export interface ToolUse {
  tool_use_id: string;
  tool: string;
  input: Record<string, unknown>;
  text?: string;
  isError?: boolean;
  /**
   * True when the decision engine dropped this call's **output** but the call
   * itself is retained as a one-line trace.
   *
   * This is a deliberate divergence from `fast-jev-compaction`, which removes a
   * dropped call entirely. For a coding agent that is the wrong trade: knowing
   * *which* file or command was examined is what makes "re-run the tool" an
   * actionable instruction rather than an empty suggestion. A call-only
   * assistant message (34% of the messages in a real session) would otherwise
   * vanish without trace, losing the path as well as the output.
   */
  removed?: boolean;
}

/** A tool_result block. */
export interface ToolResult {
  tool_use_id: string;
  text: string;
  isError?: boolean;
}

/**
 * One transcript message. Deliberately a *subset* of both Claude Code's
 * `SessionMessage` and pi's agent messages, so either can be adapted in.
 */
export interface Message {
  role: Role;
  text: string;
  toolUses: ToolUse[];
  toolResults?: ToolResult[];
}

/** A tool call paired with its result by `tool_use_id`. */
export interface ToolCall {
  /** Short id used in the Jev state and question names (`t1`, `t2`, ...). */
  id: string;
  tool_use_id: string;
  tool: string;
  input: Record<string, unknown>;
  /** Index of the message holding the tool_use block. */
  callIndex: number;
  /** Index of the message holding the tool_result block. */
  resultIndex: number;
  resultChars: number;
  isError: boolean;
  /** In the first or the newest preserved messages; never a candidate. */
  pinned: boolean;
}

export interface CallAnswer {
  /** Jev's probability that the call itself still matters. */
  keepCall: number;
  /** Jev's probability that the full result still needs to stay verbatim. */
  keepResult: number;
}

export type CallAction = 'keep' | 'drop_result' | 'drop_call';

export interface CallDecision extends CallAnswer {
  id: string;
  tool: string;
  action: CallAction;
  reason: 'pinned' | 'kept' | 'result_dropped' | 'call_dropped' | 'not_smaller';
}

export interface HistoryToolCall {
  id: string;
  tool: string;
  input: string;
  result: string;
}

export interface HistoryEntry {
  i: number;
  role: Role;
  text: string;
  /** Structured per call, or one compact line per call once the state has to shrink. */
  tool_calls?: HistoryToolCall[] | string[];
}

/** The state sent with every Jev request: the whole history, results omitted. */
export interface CompactionState {
  context: string;
  goal: string;
  history: HistoryEntry[];
}

export interface FittedState {
  state: CompactionState;
  tokens: number;
  /** Which fitting stage produced the state, for diagnostics. */
  stage: string;
}

/**
 * One contiguous window of the conversation, small enough to send to Jev, plus
 * the tool calls that window is responsible for deciding.
 *
 * Chunking exists because Jev's token ceiling bounds **one request's state**,
 * not the conversation. A long session becomes several windows, and every call
 * is judged inside the window that contains it — so the model always sees the
 * context around the call it is deciding about. The alternative, shrinking the
 * whole history into one budget, made Jev judge calls it could no longer see.
 */
export interface StateChunk {
  state: CompactionState;
  tokens: number;
  /** How this window was fitted; `full` when no shrink was needed. */
  stage: string;
  /** Unpinned candidate calls whose `callIndex` falls inside this window. */
  calls: ToolCall[];
}

export interface CompactOptions {
  /** Ongoing task description; defaults to the last few user prompts. */
  goal?: string;
  /**
   * Aborts the in-flight Jev requests. pi passes one per compaction, and it is
   * honoured rather than checked afterwards: a 400k-token session issues many
   * requests, and letting them run to completion after the user cancels burns
   * tokens for a result that will be thrown away.
   */
  signal?: AbortSignal;
  /** Minimum keep probability for a call or result to stay. Default 0.5. */
  keepThreshold?: number;
  /** Newest messages never touched (the first message is always kept). Default 6. */
  preserveRecentMessages?: number;
  /** Estimated token ceiling for one window of state. Default 28000. */
  maxStateTokens?: number;
  /** Estimated token ceiling for state plus one batch of questions. Default 64000. */
  maxRequestTokens?: number;
  /** Maximum simultaneous Jev requests across all windows and batches. Default 4. */
  maxConcurrentRequests?: number;
  /** Characters of a dropped tool result to retain. Default 300. */
  truncateHeadChars?: number;
}

export interface ResolvedCompactOptions {
  goal: string;
  keepThreshold: number;
  preserveRecentMessages: number;
  maxStateTokens: number;
  maxRequestTokens: number;
  maxConcurrentRequests: number;
  truncateHeadChars: number;
}

export interface CompactStats {
  messagesBefore: number;
  messagesAfter: number;
  charsBefore: number;
  charsAfter: number;
  calls: number;
  kept: number;
  resultsDropped: number;
  callsDropped: number;
  pinned: number;
  /** Tokens in the largest state window (the representative cost per request). */
  stateTokens: number;
  /** Which fitting stage the largest window needed, '' when no request was made. */
  stateStage: string;
  /** How many contiguous windows the conversation was split into. */
  chunks: number;
  requests: number;
  ms: number;
}

export interface CompactResult {
  /** The compacted transcript; untouched messages are the input objects. */
  messages: Message[];
  decisions: CallDecision[];
  stats: CompactStats;
}

/** The `state` of a Jev request: a string or any JSON-serialisable object. */
export type JevState = string | object;

export interface NoulQuestion {
  type: 'noul';
  instructions: string;
  criteria?: {
    true?: string;
    false?: string;
  };
}

export interface ChoiceQuestion {
  type: 'choice';
  instructions: string;
  criteria: Record<string, string | null>;
}

export interface ScoreQuestion {
  type: 'score';
  instructions: string;
  criteria: string[];
}

export type JevQuestion = NoulQuestion | ChoiceQuestion | ScoreQuestion;
export type JevQuestions = Record<string, JevQuestion>;

export interface NoulAnswer {
  type?: 'noul';
  noul: number;
}

export interface ChoiceAnswer {
  type?: 'choice';
  choice: string;
  confidence: number;
  probabilities: Record<string, number>;
}

export interface ScoreAnswer {
  type?: 'score';
  score: number;
  confidence: number;
  probabilities: Record<string, number>;
}

export type JevAnswer = NoulAnswer | ChoiceAnswer | ScoreAnswer;

export interface JevResponse {
  model?: string;
  answers: Record<string, JevAnswer>;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
  };
  [key: string]: unknown;
}

/** Anything that can answer Jev questions: `JevClient`, or a host-provided adapter. */
export interface JevAsker {
  ask(state: JevState, questions: JevQuestions, options?: AskOptions): Promise<JevResponse>;
}

/** Per-request controls an asker may honour. */
export interface AskOptions {
  /** Abort the HTTP request. */
  signal?: AbortSignal;
}
