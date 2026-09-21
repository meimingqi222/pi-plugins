import { describe, expect, test } from "bun:test";
import { createAceClient, isFatalAceError, AceApiError } from "../src/client.ts";

interface Recorded {
  readonly url: string;
  readonly body: Record<string, unknown>;
}

/** A fetch stub that records every request and replays scripted responses. */
function recordingFetch(responses: readonly (() => Response | Promise<Response>)[]) {
  const recorded: Recorded[] = [];
  let index = 0;
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    recorded.push({
      url: String(url),
      body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {},
    });
    const responder = responses[Math.min(index, responses.length - 1)]!;
    index += 1;
    return responder();
  }) as unknown as typeof fetch;
  return { impl, recorded, callCount: () => index };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const baseOptions = { baseUrl: "https://ace.test", token: "t0ken" };

describe("createAceClient", () => {
  test("uploadBlobs posts names under `path`, never hashes", async () => {
    const { impl, recorded } = recordingFetch([() => jsonResponse({})]);
    const client = createAceClient({ ...baseOptions, fetchImpl: impl });

    await client.uploadBlobs(
      [
        { path: "a.ts", content: "AAA" },
        { path: "b.ts#chunk2of3", content: "BBB" },
      ],
      new AbortController().signal,
    );

    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.url).toBe("https://ace.test/batch-upload");
    // The server identifies uploaded bodies by name; sending a hash here is a 400.
    expect(recorded[0]!.body).toEqual({
      blobs: [
        { path: "a.ts", content: "AAA" },
        { path: "b.ts#chunk2of3", content: "BBB" },
      ],
    });
  });

  test("findMissing posts hashes under `mem_object_names` and reads both lists", async () => {
    const { impl, recorded } = recordingFetch([
      () => jsonResponse({ unknown_memory_names: ["h1"], nonindexed_blob_names: ["h2", "h3"] }),
    ]);
    const client = createAceClient({ ...baseOptions, fetchImpl: impl });

    const result = await client.findMissing(["h1", "h2", "h3"], new AbortController().signal);

    expect(recorded[0]!.url).toBe("https://ace.test/find-missing");
    expect(recorded[0]!.body).toEqual({ mem_object_names: ["h1", "h2", "h3"] });
    expect(result).toEqual({ unknown: ["h1"], pending: ["h2", "h3"] });
  });

  test("search sends hashes in added_blobs and the exact legacy envelope", async () => {
    const { impl, recorded } = recordingFetch([
      () => jsonResponse({ formatted_retrieval: "Path: a.ts\n  1\tcode" }),
    ]);
    const client = createAceClient({ ...baseOptions, fetchImpl: impl });

    const text = await client.search(
      { informationRequest: "where is auth?", addedBlobs: ["h1", "h2"], deletedBlobs: ["h9"] },
      new AbortController().signal,
    );

    expect(text).toBe("Path: a.ts\n  1\tcode");
    expect(recorded[0]!.url).toBe("https://ace.test/agents/codebase-retrieval");
    expect(recorded[0]!.body).toEqual({
      information_request: "where is auth?",
      blobs: { checkpoint_id: null, added_blobs: ["h1", "h2"], deleted_blobs: ["h9"] },
      dialog: [],
      max_output_length: 0,
      disable_codebase_retrieval: false,
      enable_commit_retrieval: false,
    });
  });

  test("an empty formatted_retrieval becomes a readable message, not an empty string", async () => {
    const { impl } = recordingFetch([() => jsonResponse({ formatted_retrieval: "" })]);
    const client = createAceClient({ ...baseOptions, fetchImpl: impl });
    const text = await client.search(
      { informationRequest: "q", addedBlobs: [], deletedBlobs: [] },
      new AbortController().signal,
    );
    expect(text).toBe("No relevant code context found.");
  });

  test("a 401 fails immediately instead of burning retries", async () => {
    const { impl, callCount } = recordingFetch([
      () => jsonResponse({ error: "bad token" }, 401),
    ]);
    const client = createAceClient({ ...baseOptions, fetchImpl: impl });

    const error = await client
      .search({ informationRequest: "q", addedBlobs: [], deletedBlobs: [] }, new AbortController().signal)
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(AceApiError);
    expect(isFatalAceError(error)).toBe(true);
    expect(callCount()).toBe(1);
  });

  test("a 500 is retried and then succeeds", async () => {
    const { impl, callCount } = recordingFetch([
      () => jsonResponse({ error: "boom" }, 500),
      () => jsonResponse({ formatted_retrieval: "recovered" }),
    ]);
    const client = createAceClient({ ...baseOptions, fetchImpl: impl, maxAttempts: 3 });

    const text = await client.search(
      { informationRequest: "q", addedBlobs: [], deletedBlobs: [] },
      new AbortController().signal,
    );

    expect(text).toBe("recovered");
    expect(callCount()).toBe(2);
  });

  test("an aborted signal rejects instead of retrying", async () => {
    const controller = new AbortController();
    const { impl, callCount } = recordingFetch([
      () => {
        controller.abort(new Error("user cancelled"));
        return jsonResponse({ error: "boom" }, 500);
      },
    ]);
    const client = createAceClient({ ...baseOptions, fetchImpl: impl, maxAttempts: 3 });

    await expect(
      client.search({ informationRequest: "q", addedBlobs: [], deletedBlobs: [] }, controller.signal),
    ).rejects.toThrow("user cancelled");
    // A cancel must not be retried; this is the behaviour acemcp lacks because
    // its upload path never carried a context.
    expect(callCount()).toBe(1);
  });

  test("uploading zero blobs makes no request", async () => {
    const { impl, callCount } = recordingFetch([() => jsonResponse({})]);
    const client = createAceClient({ ...baseOptions, fetchImpl: impl });
    await client.uploadBlobs([], new AbortController().signal);
    expect(callCount()).toBe(0);
  });

  test("the bearer token is attached to every request", async () => {
    let authorization: string | null | undefined;
    const impl = (async (_url: unknown, init?: RequestInit) => {
      authorization = new Headers(init?.headers).get("Authorization");
      return jsonResponse({ formatted_retrieval: "x" });
    }) as unknown as typeof fetch;
    const client = createAceClient({ ...baseOptions, fetchImpl: impl });
    await client.search(
      { informationRequest: "q", addedBlobs: [], deletedBlobs: [] },
      new AbortController().signal,
    );
    expect(String(authorization)).toBe("Bearer t0ken");
  });
});
