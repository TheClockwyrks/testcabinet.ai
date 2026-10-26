/**
 * The preview-tag Worker, routed in front of the gallery's run routes.
 *
 * It answers `/runs/<id>` and every path beneath it with the Pages shell: for a
 * published run with the run's title, description and image written into the
 * document head as preview tags and a 200, and for an unknown id with a 404,
 * inside which the application renders its not-found page. The Serving page of
 * the documentation site, section "Preview tags and status", states the
 * contract, and its "Caching" section the cache headers each answer carries.
 */

import { previewTags, writeTags, type RunCard, type RunDocument } from "./tags";

/** The one method of an R2 binding this Worker calls. */
export interface SnapshotBucket {
  get(key: string): Promise<{ text(): Promise<string> } | null>;
}

/** The bindings `wrangler.toml` declares. */
export interface Env {
  /** The public bucket, bound read-only. */
  SNAPSHOT: SnapshotBucket;
  /** The Pages project's origin, which the shell is fetched from. */
  SHELL_ORIGIN: string;
  /** The bucket's public origin, which a preview image is served from. */
  SNAPSHOT_ORIGIN: string;
}

/** What the Worker reads besides its bindings, replaced by the tests. */
export interface Deps {
  fetch: (input: string) => Promise<Response>;
  now: () => number;
}

/**
 * A published run's page: the same document for every visitor, held briefly
 * because the next publish or deploy may change it.
 */
export const PAGE_CACHE = "public, max-age=60";

/** An unknown id is left uncached, because the next publish may add it. */
export const MISS_CACHE = "no-store";

/**
 * How long the pointer and the shell are held in memory: the pointer's own
 * freshness window in the bucket.
 */
export const POINTER_TTL_MS = 60_000;

/** The run documents held at once, each immutable under its key. */
const DOCUMENTS_HELD = 256;

/** A run route and its id. */
const RUN_ROUTE = /^\/runs\/([^/]+)(?:\/.*)?$/;

/**
 * The static segments the gallery mounts beneath `/runs/` beside a run's id,
 * whose pages are the shell untagged.
 */
const STATIC_SEGMENTS = new Set(["comparisons"]);

interface Pointer {
  runsKey: string;
}

interface Held<T> {
  value: Promise<T>;
  until: number;
}

/** What the bucket says of a run id. */
type Lookup =
  | { found: RunCard }
  | { found: undefined }
  // The bucket could not be read, so the run's status is not known.
  | { unavailable: true };

async function readJson<T>(env: Env, key: string): Promise<T | null> {
  const object = await env.SNAPSHOT.get(key);
  return object === null ? null : (JSON.parse(await object.text()) as T);
}

async function readRunIndex(
  env: Env,
  key: string,
): Promise<Map<string, RunCard>> {
  const index = await readJson<{ runs: RunCard[] }>(env, key);
  // A pointer naming no index is a bucket in disorder, not a set of published
  // runs, so it is read again rather than held as empty.
  if (index === null) throw new Error(`${key} is missing`);
  return new Map(index.runs.map((run) => [run.id, run]));
}

/** `read`, calling `forget` first when it fails. */
async function forgetOnFailure<T>(
  read: Promise<T>,
  forget: () => void,
): Promise<T> {
  try {
    return await read;
  } catch (error) {
    forget();
    throw error;
  }
}

/**
 * A Worker with its own in-memory caches, so each isolate holds one set and a
 * test starts from none.
 *
 * Each cache holds the read in flight rather than its result, so concurrent
 * requests share one read, and a read that fails is dropped so the next
 * request reads again.
 */
export function createWorker(deps: Deps) {
  let pointer: Held<Pointer | null> | undefined;
  let shell: Held<string> | undefined;
  // A generation's run index is never rewritten, so it is held for as long as
  // the pointer names it.
  let runs: { key: string; byId: Promise<Map<string, RunCard>> } | undefined;
  const documents = new Map<string, Promise<RunDocument | null>>();

  function currentPointer(env: Env): Promise<Pointer | null> {
    if (pointer === undefined || pointer.until <= deps.now()) {
      const value = forgetOnFailure(
        readJson<Pointer>(env, "index.json"),
        () => {
          if (pointer?.value === value) pointer = undefined;
        },
      );
      pointer = { value, until: deps.now() + POINTER_TTL_MS };
    }
    return pointer.value;
  }

  function runIndex(env: Env, key: string): Promise<Map<string, RunCard>> {
    if (runs?.key !== key) {
      const byId = forgetOnFailure(readRunIndex(env, key), () => {
        if (runs?.byId === byId) runs = undefined;
      });
      runs = { key, byId };
    }
    return runs.byId;
  }

  async function lookup(env: Env, id: string): Promise<Lookup> {
    try {
      const live = await currentPointer(env);
      if (live === null) return { found: undefined };
      const byId = await runIndex(env, live.runsKey);
      return { found: byId.get(id) };
    } catch {
      return { unavailable: true };
    }
  }

  async function runDocument(
    env: Env,
    key: string | null | undefined,
  ): Promise<RunDocument | null> {
    if (key === undefined || key === null) return null;
    let held = documents.get(key);
    if (held === undefined) {
      if (documents.size >= DOCUMENTS_HELD) {
        const oldest = documents.keys().next();
        if (oldest.done !== true) documents.delete(oldest.value);
      }
      const read = forgetOnFailure(readJson<RunDocument>(env, key), () => {
        if (documents.get(key) === read) documents.delete(key);
      });
      held = read;
      documents.set(key, read);
    }
    try {
      return await held;
    } catch {
      // A failed read takes no image this once, and is read again next time.
      return null;
    }
  }

  async function shellDocument(env: Env): Promise<string | Response> {
    if (shell === undefined || shell.until <= deps.now()) {
      let response: Response;
      try {
        response = await deps.fetch(`${env.SHELL_ORIGIN.replace(/\/+$/, "")}/`);
      } catch {
        return new Response("Bad Gateway", { status: 502 });
      }
      if (!response.ok) return response;
      const value = forgetOnFailure(response.text(), () => {
        if (shell?.value === value) shell = undefined;
      });
      shell = { value, until: deps.now() + POINTER_TTL_MS };
    }
    try {
      return await shell.value;
    } catch {
      return new Response("Bad Gateway", { status: 502 });
    }
  }

  async function handle(request: Request, env: Env): Promise<Response> {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method Not Allowed", {
        status: 405,
        headers: { allow: "GET, HEAD", "cache-control": MISS_CACHE },
      });
    }
    const url = new URL(request.url);
    const html = await shellDocument(env);
    if (typeof html !== "string") return html;
    const segment = segmentOf(url.pathname);
    if (segment === "" || STATIC_SEGMENTS.has(segment ?? "")) {
      return page(html, 200, PAGE_CACHE);
    }
    const id = decoded(segment);
    const run = id === undefined ? { found: undefined } : await lookup(env, id);
    if ("unavailable" in run) {
      // The application reads the bucket itself, so the page can still load.
      return page(html, 200, MISS_CACHE);
    }
    if (run.found === undefined) {
      return page(html, 404, MISS_CACHE);
    }
    const document = await runDocument(env, run.found.documentKey);
    const tags = previewTags(run.found, document, {
      snapshotOrigin: env.SNAPSHOT_ORIGIN,
      url: `${url.origin}${url.pathname}`,
    });
    return page(writeTags(html, tags), 200, PAGE_CACHE);
  }

  return { fetch: handle };
}

/**
 * The first segment beneath `/runs/`: `""` for `/runs/` itself, and undefined
 * for a path the Worker's route matched that is not a run route.
 */
function segmentOf(pathname: string): string | undefined {
  return pathname === "/runs/" || pathname === "/runs"
    ? ""
    : RUN_ROUTE.exec(pathname)?.[1];
}

function decoded(segment: string | undefined): string | undefined {
  if (segment === undefined) return undefined;
  try {
    return decodeURIComponent(segment);
  } catch {
    return undefined;
  }
}

function page(html: string, status: number, cache: string): Response {
  return new Response(html, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": cache,
    },
  });
}

export default createWorker({
  fetch: (input) => fetch(input),
  now: () => Date.now(),
});
