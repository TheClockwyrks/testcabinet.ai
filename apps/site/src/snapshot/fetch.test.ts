import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createSnapshotFetcher,
  forEachOrdered,
  SnapshotFetchError,
  type SnapshotFetch,
} from "./fetch";

const URL_A = "https://snapshot.example/runs/a.json";

function ok(body: unknown): Response {
  return Response.json(body, { status: 200 });
}

function status(code: number, text: string): Response {
  return new Response("nope", { status: code, statusText: text });
}

/** A `fetch` that answers each call with the next scripted step. */
function scripted(steps: (() => Promise<Response>)[]): {
  fetch: SnapshotFetch;
  calls: () => number;
} {
  let calls = 0;
  return {
    fetch: () => {
      const step = steps[Math.min(calls, steps.length - 1)];
      calls += 1;
      if (step === undefined) throw new Error("no scripted step");
      return step();
    },
    calls: () => calls,
  };
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

/**
 * `Promise`, typed with `withResolvers`, which every runtime the tests run in
 * has though the compiled library (ES2022) does not declare it.
 */
const PromiseWithResolvers = Promise as PromiseConstructor & {
  withResolvers: <T>() => Deferred<T>;
};

/** A promise settled by hand, for tasks that must finish out of order. */
function deferred<T>(): Deferred<T> {
  return PromiseWithResolvers.withResolvers<T>();
}

/** A promise that never settles. */
function never<T>(): Promise<T> {
  return deferred<T>().promise;
}

/** A consumer that ignores what it is given. */
function ignore(): void {
  // Nothing to consume.
}

/** The outcome of a promise, captured so a rejection is never left unhandled. */
async function settle<T>(promise: Promise<T>): Promise<T | Error> {
  try {
    return await promise;
  } catch (error: unknown) {
    return error as Error;
  }
}

/** A response whose body sends half a document and then stalls. */
function stalled(): Promise<Response> {
  return Promise.resolve(
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"half":'));
        },
      }),
      { status: 200 },
    ),
  );
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("createSnapshotFetcher", () => {
  it("retries a dropped connection and a 503, then returns the document", async () => {
    const script = scripted([
      () => Promise.reject(new TypeError("terminated")),
      () => Promise.resolve(status(503, "Service Unavailable")),
      () => Promise.resolve(ok({ id: "a" })),
    ]);
    const fetcher = createSnapshotFetcher({
      fetch: script.fetch,
      random: () => 1,
    });

    const result = settle(fetcher.json<{ id: string }>(URL_A));
    await vi.advanceTimersByTimeAsync(0);
    expect(script.calls()).toBe(1);
    // The first wait is the base, the second twice it.
    await vi.advanceTimersByTimeAsync(499);
    expect(script.calls()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(script.calls()).toBe(2);
    await vi.advanceTimersByTimeAsync(999);
    expect(script.calls()).toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(script.calls()).toBe(3);

    expect(await result).toEqual({ id: "a" });
    expect(fetcher.fetched).toBe(1);
    expect(fetcher.retried).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("counts a document fetched on its first attempt as not retried", async () => {
    const script = scripted([() => Promise.resolve(ok([1, 2]))]);
    const fetcher = createSnapshotFetcher({ fetch: script.fetch });

    expect(await fetcher.json(URL_A)).toEqual([1, 2]);
    expect(fetcher.fetched).toBe(1);
    expect(fetcher.retried).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("fails after its last attempt, naming the URL and the attempts", async () => {
    const script = scripted([
      () => Promise.resolve(status(503, "Service Unavailable")),
    ]);
    const fetcher = createSnapshotFetcher({ fetch: script.fetch });

    const result = settle(fetcher.json(URL_A));
    await vi.runAllTimersAsync();
    const error = await result;

    expect(error).toBeInstanceOf(SnapshotFetchError);
    expect((error as SnapshotFetchError).message).toBe(
      `503 Service Unavailable for ${URL_A} after 5 attempts`,
    );
    expect((error as SnapshotFetchError).status).toBe(503);
    expect(script.calls()).toBe(5);
    expect(fetcher.fetched).toBe(0);
    expect(fetcher.retried).toBe(0);
  });

  it("reports the transport's own reason when the connection keeps dropping", async () => {
    const script = scripted([
      () =>
        Promise.reject(
          new TypeError("fetch failed", { cause: new Error("ECONNRESET") }),
        ),
    ]);
    const fetcher = createSnapshotFetcher({ fetch: script.fetch, attempts: 2 });

    const result = settle(fetcher.json(URL_A));
    await vi.runAllTimersAsync();

    expect(((await result) as Error).message).toBe(
      `fetch failed (ECONNRESET) for ${URL_A} after 2 attempts`,
    );
  });

  it("does not retry a 404", async () => {
    const script = scripted([() => Promise.resolve(status(404, "Not Found"))]);
    const fetcher = createSnapshotFetcher({ fetch: script.fetch });

    const error = await settle(fetcher.json(URL_A));

    expect(error).toBeInstanceOf(SnapshotFetchError);
    expect((error as SnapshotFetchError).status).toBe(404);
    expect((error as SnapshotFetchError).message).toBe(
      `404 Not Found for ${URL_A} after 1 attempt`,
    );
    expect(script.calls()).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([408, 429, 500, 502, 504])("retries a %i", async (code) => {
    const script = scripted([
      () => Promise.resolve(status(code, "Busy")),
      () => Promise.resolve(ok("fine")),
    ]);
    const fetcher = createSnapshotFetcher({ fetch: script.fetch });

    const result = settle(fetcher.json(URL_A));
    await vi.runAllTimersAsync();

    expect(await result).toBe("fine");
    expect(script.calls()).toBe(2);
  });

  it.each([400, 401, 403, 410])("does not retry a %i", async (code) => {
    const script = scripted([() => Promise.resolve(status(code, "No"))]);
    const fetcher = createSnapshotFetcher({ fetch: script.fetch });

    const error = await settle(fetcher.json(URL_A));

    expect((error as SnapshotFetchError).status).toBe(code);
    expect(script.calls()).toBe(1);
  });

  it("does not retry a body that is not JSON", async () => {
    const script = scripted([
      () => Promise.resolve(new Response("<html>", { status: 200 })),
    ]);
    const fetcher = createSnapshotFetcher({ fetch: script.fetch });

    const error = await settle(fetcher.json(URL_A));

    expect((error as Error).message).toContain("malformed JSON body");
    expect((error as Error).message).toContain(`for ${URL_A} after 1 attempt`);
    expect(script.calls()).toBe(1);
  });

  it("times out an attempt whose request never answers, aborting it", async () => {
    const signals: AbortSignal[] = [];
    let calls = 0;
    const fetcher = createSnapshotFetcher({
      fetch: (_url, init) => {
        calls += 1;
        signals.push(init.signal);
        return calls === 1 ? never<Response>() : Promise.resolve(ok("late"));
      },
      random: () => 1,
    });

    const result = settle(fetcher.json(URL_A));
    await vi.advanceTimersByTimeAsync(59_999);
    expect(calls).toBe(1);
    expect(signals[0]?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(signals[0]?.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(500);

    expect(await result).toBe("late");
    expect(calls).toBe(2);
    expect(fetcher.retried).toBe(1);
  });

  it("times out an attempt whose body never finishes", async () => {
    const script = scripted([stalled]);
    const fetcher = createSnapshotFetcher({
      fetch: script.fetch,
      attempts: 2,
      attemptTimeoutMs: 1000,
    });

    const result = settle(fetcher.json(URL_A));
    await vi.runAllTimersAsync();

    expect(((await result) as Error).message).toBe(
      `timed out after 1000 ms for ${URL_A} after 2 attempts`,
    );
    expect(script.calls()).toBe(2);
  });

  it("doubles the wait per attempt up to the cap", async () => {
    const script = scripted([
      () => Promise.reject(new TypeError("terminated")),
    ]);
    const fetcher = createSnapshotFetcher({
      fetch: script.fetch,
      attempts: 7,
      random: () => 1,
    });
    const started = Date.now();

    const result = settle(fetcher.json(URL_A));
    await vi.runAllTimersAsync();
    await result;

    // 500 + 1000 + 2000 + 4000 + 8000 + 8000 between seven attempts.
    expect(Date.now() - started).toBe(23_500);
    expect(script.calls()).toBe(7);
  });

  it("jitters a wait down to half its ceiling", async () => {
    const script = scripted([
      () => Promise.reject(new TypeError("terminated")),
      () => Promise.resolve(ok(1)),
    ]);
    const fetcher = createSnapshotFetcher({
      fetch: script.fetch,
      random: () => 0,
    });

    const result = settle(fetcher.json(URL_A));
    await vi.advanceTimersByTimeAsync(249);
    expect(script.calls()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(script.calls()).toBe(2);
    expect(await result).toBe(1);
  });
});

describe("forEachOrdered", () => {
  it("consumes in item order when the tasks finish in reverse", async () => {
    const items = ["a", "b", "c", "d"];
    const gates = items.map(() => deferred<string>());
    const consumed: string[] = [];

    const done = forEachOrdered(
      items,
      4,
      (_item, index) => {
        const gate = gates[index];
        if (gate === undefined) throw new Error(`no gate ${String(index)}`);
        return gate.promise;
      },
      (result, item, index) => {
        consumed.push(`${String(index)}:${item}:${result}`);
      },
    );
    for (const index of [3, 2, 1]) {
      gates[index]?.resolve(`r${String(index)}`);
      await vi.advanceTimersByTimeAsync(0);
    }
    // Nothing is consumed while the first item is outstanding.
    expect(consumed).toEqual([]);
    gates[0]?.resolve("r0");
    await done;

    expect(consumed).toEqual(["0:a:r0", "1:b:r1", "2:c:r2", "3:d:r3"]);
  });

  it("consumes each result as soon as every earlier one is consumed", async () => {
    const gates = [0, 1, 2].map(() => deferred<number>());
    const consumed: number[] = [];

    const done = forEachOrdered(
      gates,
      3,
      (gate) => gate.promise,
      (result) => {
        consumed.push(result);
      },
    );
    gates[0]?.resolve(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(consumed).toEqual([0]);
    gates[2]?.resolve(2);
    await vi.advanceTimersByTimeAsync(0);
    expect(consumed).toEqual([0]);
    gates[1]?.resolve(1);
    await done;
    expect(consumed).toEqual([0, 1, 2]);
  });

  it("never runs more tasks at once than the bound", async () => {
    const items = Array.from({ length: 40 }, (_unused, index) => index);
    let inFlight = 0;
    let peak = 0;
    const consumed: number[] = [];

    const done = forEachOrdered(
      items,
      3,
      async (item) => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        // Earlier items take longer, so completions run against the order.
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 10 + ((items.length - item) % 7) * 10);
        });
        inFlight -= 1;
        return item;
      },
      (result) => {
        consumed.push(result);
      },
    );
    await vi.runAllTimersAsync();
    await done;

    expect(peak).toBe(3);
    expect(consumed).toEqual(items);
  });

  it("runs one at a time with a bound of one", async () => {
    const started: number[] = [];
    const finished: number[] = [];

    await forEachOrdered(
      [0, 1, 2],
      1,
      async (item) => {
        started.push(item);
        expect(started.length - finished.length).toBe(1);
        await Promise.resolve();
        finished.push(item);
        return item;
      },
      ignore,
    );

    expect(started).toEqual([0, 1, 2]);
  });

  it("resolves at once for no items", async () => {
    const task = vi.fn<() => Promise<number>>();
    await forEachOrdered([], 8, task, ignore);
    expect(task).not.toHaveBeenCalled();
  });

  it("rejects on the first failure and starts nothing after it", async () => {
    const gates = [0, 1, 2, 3, 4].map(() => deferred<number>());
    const started: number[] = [];
    const consumed: number[] = [];

    const done = settle(
      forEachOrdered(
        gates,
        2,
        (gate, index) => {
          started.push(index);
          return gate.promise;
        },
        (result) => {
          consumed.push(result);
        },
      ),
    );
    gates[1]?.reject(new Error("boom"));
    const error = await done;
    gates[0]?.resolve(0);
    await vi.advanceTimersByTimeAsync(0);

    expect((error as Error).message).toBe("boom");
    expect(started).toEqual([0, 1]);
    expect(consumed).toEqual([]);
  });

  it("rejects when the consumer throws", async () => {
    const error = await settle(
      forEachOrdered(
        [1, 2, 3],
        2,
        (item) => Promise.resolve(item),
        (result) => {
          if (result === 2) throw new Error("bad result");
        },
      ),
    );

    expect((error as Error).message).toBe("bad result");
  });
});
