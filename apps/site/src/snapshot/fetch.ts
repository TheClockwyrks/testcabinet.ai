// How the gallery reaches the public snapshot: one JSON document per request,
// each request retried through transient failures, and many of them in flight at
// once without changing the order their results are consumed in.
//
// A visitor's page reads the bucket over the open internet, so a dropped
// connection or a passing 5xx from the edge is an expected event rather than a
// sign of a broken snapshot. This module is what keeps one from failing the page.
// It has no dependency beyond the platform's `fetch` and timers, both injectable,
// so its tests run on fake timers with no network.

/** The `fetch` this module needs: a URL and an abort signal in, a response out. */
export type SnapshotFetch = (
  url: string,
  init: { signal: AbortSignal },
) => Promise<Response>;

/** How many requests a document is given before the fetch fails. */
export const DEFAULT_ATTEMPTS = 5;

/**
 * How long one attempt may take, from the request to the last byte of the body.
 *
 * The largest snapshot document, the gg corpus, is tens of megabytes, and a
 * healthy transfer of it takes a few seconds on a home connection; a minute is
 * far outside that.
 */
export const DEFAULT_ATTEMPT_TIMEOUT_MS = 60_000;

/** The wait before the second attempt; each later wait doubles it. */
export const DEFAULT_BACKOFF_BASE_MS = 500;

/** The longest wait between two attempts. */
export const DEFAULT_BACKOFF_MAX_MS = 8000;

/**
 * How many documents are in flight at once: the case files the catalog is built
 * from are fetched this many at a time. Six is what a browser opens to one host
 * over HTTP/1.1, and an HTTP/2 connection multiplexes them.
 */
export const DEFAULT_CONCURRENCY = 6;

/** A response whose status is not a success. */
class HttpStatusError extends Error {
  constructor(
    readonly status: number,
    statusText: string,
  ) {
    super(`${status} ${statusText}`.trim());
    this.name = "HttpStatusError";
  }
}

/** A successful response whose body is not JSON. */
class MalformedBodyError extends Error {
  constructor(reason: string) {
    super(`malformed JSON body (${reason})`);
    this.name = "MalformedBodyError";
  }
}

/** An attempt that outlived its timeout. */
class AttemptTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`timed out after ${timeoutMs} ms`);
    this.name = "AttemptTimeoutError";
  }
}

/**
 * A document that could not be fetched, after every attempt it was owed.
 *
 * The message names the URL and the number of attempts, which is what a page
 * that could not read the snapshot reports. `status` is the HTTP status of the last attempt when the server
 * answered at all, so a caller can tell an absent object (404) from a failure.
 */
export class SnapshotFetchError extends Error {
  readonly status: number | undefined;

  constructor(
    readonly url: string,
    readonly attempts: number,
    cause: unknown,
  ) {
    super(
      `${describe(cause)} for ${url} after ${attempts} ${attempts === 1 ? "attempt" : "attempts"}`,
      { cause },
    );
    this.name = "SnapshotFetchError";
    this.status = cause instanceof HttpStatusError ? cause.status : undefined;
  }
}

/** An error's message, with its cause's: a transport may report the reason only there. */
function describe(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause: unknown = error.cause;
  const reason =
    cause instanceof Error
      ? cause.message
      : typeof cause === "string"
        ? cause
        : "";
  return reason !== "" && reason !== error.message
    ? `${error.message} (${reason})`
    : error.message;
}

/**
 * Whether another attempt could succeed where this one failed.
 *
 * A status the server chose deliberately (a 404 above all) and a body that is
 * not JSON are answers, and asking again returns the same one. Everything else
 * is transient: a timeout, the statuses a server or proxy uses to say "not now"
 * (408, 429 and every 5xx), and any failure of the transport itself, such as
 * the "Failed to fetch" a browser raises when a connection drops mid-body.
 */
function isTransient(error: unknown): boolean {
  if (error instanceof MalformedBodyError) return false;
  return error instanceof HttpStatusError
    ? error.status === 408 || error.status === 429 || error.status >= 500
    : true;
}

export interface SnapshotFetcherOptions {
  /** The `fetch` to use; the platform's by default. */
  fetch?: SnapshotFetch;
  attempts?: number;
  attemptTimeoutMs?: number;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  /** The source of backoff jitter, in `[0, 1)`; `Math.random` by default. */
  random?: () => number;
}

export interface SnapshotFetcher {
  /**
   * Fetch one JSON document, retrying transient failures.
   *
   * Rejects with a {@link SnapshotFetchError} once an attempt fails in a way no
   * retry can fix, or the last attempt fails at all.
   */
  json<T>(url: string): Promise<T>;
  /** How many documents were fetched, counted when each one succeeds. */
  readonly fetched: number;
  /** How many of the fetched documents needed more than one attempt. */
  readonly retried: number;
}

export function createSnapshotFetcher(
  options: SnapshotFetcherOptions = {},
): SnapshotFetcher {
  const fetchImpl: SnapshotFetch =
    options.fetch ?? ((url, init) => globalThis.fetch(url, init));
  const attempts = options.attempts ?? DEFAULT_ATTEMPTS;
  const attemptTimeoutMs =
    options.attemptTimeoutMs ?? DEFAULT_ATTEMPT_TIMEOUT_MS;
  const backoffBaseMs = options.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS;
  const backoffMaxMs = options.backoffMaxMs ?? DEFAULT_BACKOFF_MAX_MS;
  const random = options.random ?? Math.random;

  let fetched = 0;
  let retried = 0;

  // One request and its whole body, under one deadline. The deadline aborts the
  // request and also settles the attempt on its own, so a transport that is slow
  // to honor the abort cannot hold the attempt open past it.
  async function attempt(url: string): Promise<unknown> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        const error = new AttemptTimeoutError(attemptTimeoutMs);
        reject(error);
        controller.abort(error);
      }, attemptTimeoutMs);
    });
    const body = (async () => {
      const response = await fetchImpl(url, { signal: controller.signal });
      if (!response.ok) {
        // Release the connection; the body of an error is of no use here.
        void response.body?.cancel().catch(() => {});
        throw new HttpStatusError(response.status, response.statusText);
      }
      return await response.text();
    })();
    // The loser of the race may still reject after the winner settled it.
    body.catch(() => {});
    let text: string;
    try {
      text = await Promise.race([body, deadline]);
    } finally {
      clearTimeout(timer);
    }
    try {
      return JSON.parse(text) as unknown;
    } catch (error) {
      throw new MalformedBodyError(
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  // The wait after the `failed`-th attempt: the base doubled per failure, capped,
  // then scaled into its upper half so requests that failed together (a
  // connection pool dropped at once) do not all come back at the same instant.
  function backoff(failed: number): number {
    const ceiling = Math.min(backoffMaxMs, backoffBaseMs * 2 ** (failed - 1));
    return Math.round(ceiling * (0.5 + 0.5 * random()));
  }

  return {
    async json<T>(url: string): Promise<T> {
      for (let made = 1; ; made += 1) {
        try {
          const value = await attempt(url);
          fetched += 1;
          if (made > 1) retried += 1;
          return value as T;
        } catch (error) {
          if (made >= attempts || !isTransient(error)) {
            throw new SnapshotFetchError(url, made, error);
          }
        }
        await new Promise<void>((resolve) => {
          setTimeout(resolve, backoff(made));
        });
      }
    },
    get fetched() {
      return fetched;
    },
    get retried() {
      return retried;
    },
  };
}

/**
 * Run `task` over every item with at most `limit` in flight, and hand each result
 * to `consume` in the items' own order.
 *
 * The tasks finish in whatever order the network gives; `consume` is called
 * exactly as a sequential loop would call it, item 0 first, each call made as
 * soon as every earlier item has been consumed. A result is released once it is
 * consumed, so the results held at any moment are the ones waiting on an earlier
 * item rather than all of them.
 *
 * The first failure, of a task or of `consume`, rejects the returned promise at
 * once and stops new tasks from starting. `consume` is not called again after
 * it; tasks already in flight run to their end unobserved.
 */
export function forEachOrdered<T, R>(
  items: readonly T[],
  limit: number,
  task: (item: T, index: number) => Promise<R>,
  consume: (result: R, item: T, index: number) => void,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const total = items.length;
    if (total === 0) {
      resolve();
      return;
    }
    const waiting = new Map<number, R>();
    let nextToStart = 0;
    let nextToConsume = 0;
    let failed = false;

    const fail = (error: unknown): void => {
      if (failed) return;
      failed = true;
      waiting.clear();
      reject(error instanceof Error ? error : new Error(String(error)));
    };

    const flush = (): void => {
      while (!failed && waiting.has(nextToConsume)) {
        const index = nextToConsume;
        const result = waiting.get(index) as R;
        waiting.delete(index);
        nextToConsume += 1;
        try {
          consume(result, items[index] as T, index);
        } catch (error) {
          fail(error);
          return;
        }
      }
      if (!failed && nextToConsume === total) resolve();
    };

    const worker = async (): Promise<void> => {
      while (!failed && nextToStart < total) {
        const index = nextToStart;
        nextToStart += 1;
        try {
          const result = await task(items[index] as T, index);
          if (failed) return;
          waiting.set(index, result);
          flush();
        } catch (error) {
          fail(error);
          return;
        }
      }
    };

    const workers = Math.max(1, Math.min(Math.floor(limit), total));
    for (let started = 0; started < workers; started += 1) void worker();
  });
}
