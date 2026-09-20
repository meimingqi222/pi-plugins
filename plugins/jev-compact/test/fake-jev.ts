/**
 * A scripted `JevAsker` so the engine can be tested without the network.
 *
 * `answers` maps a question name (`call_t3`) to a probability. A name with no
 * entry falls back to `defaultAnswer`, which lets a test say "everything else
 * is kept" or "everything else is dropped" in one line.
 */

import type {
  AskOptions,
  JevAsker,
  JevAnswer,
  JevQuestions,
  JevResponse,
  JevState,
} from '../src/jev/types.ts';

export interface FakeJevOptions {
  /** Probability used for any question not named in `answers`. Default 1. */
  defaultAnswer?: number;
  /** Throw on the nth (1-based) `ask` call. */
  failOnRequest?: number;
}

export interface FakeJev extends JevAsker {
  /** Every (state, questions) pair the engine sent, in call order. */
  calls: Array<{ state: JevState; questions: JevQuestions; options?: AskOptions }>;
  /** Total questions asked across all requests. */
  questionCount: number;
}

export function fakeJev(
  answers: Record<string, number>,
  options: FakeJevOptions = {},
): FakeJev {
  const calls: FakeJev['calls'] = [];
  let count = 0;
  const fallback = options.defaultAnswer ?? 1;

  return {
    calls,
    get questionCount() {
      return count;
    },
    async ask(
      state: JevState,
      questions: JevQuestions,
      askOptions: AskOptions = {},
    ): Promise<JevResponse> {
      calls.push({ state, questions, options: askOptions });
      if (options.failOnRequest !== undefined && calls.length === options.failOnRequest) {
        throw new Error('Jev request failed (500): simulated');
      }
      const out: Record<string, JevAnswer> = {};
      for (const name of Object.keys(questions)) {
        count += 1;
        out[name] = { type: 'noul', noul: answers[name] ?? fallback };
      }
      return { answers: out };
    },
  };
}
