/**
 * The `tcab.ai` share-link Worker.
 *
 * `/r/<code>` redirects to the run's verdict page and `/p/<code>` to its play
 * page, reading the run id from the bucket's `codes/<code>` object. A code the
 * bucket holds no object for is a 404. The Serving page of the documentation
 * site, section "Share links", states the contract, and its "Caching" section
 * the cache headers each answer carries.
 */

/** The one method of an R2 binding this Worker calls. */
export interface SnapshotBucket {
  get(key: string): Promise<{ text(): Promise<string> } | null>;
}

/** The bindings `wrangler.toml` declares. */
export interface Env {
  /** The public bucket, bound read-only. */
  SNAPSHOT: SnapshotBucket;
  /** The gallery's public origin, the prefix of every redirect. */
  GALLERY_ORIGIN: string;
}

/**
 * A redirect never changes, because a code is assigned once and never
 * reassigned, so it is cached indefinitely.
 */
export const REDIRECT_CACHE = "public, max-age=31536000, immutable";

/**
 * The bare host's redirect to the gallery is no share link, and follows the
 * gallery if it moves, so it is held for an hour.
 */
export const HOME_CACHE = "public, max-age=3600";

/** A miss is left uncached, because the next publish may write the code. */
export const MISS_CACHE = "no-store";

/** A share link: the page it opens, and the code. */
const SHARE_LINK = /^\/([rp])\/([\w-]+)\/?$/;

/** Answer one request. */
export async function handle(request: Request, env: Env): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method Not Allowed", {
      status: 405,
      headers: { allow: "GET, HEAD", "cache-control": MISS_CACHE },
    });
  }
  const gallery = env.GALLERY_ORIGIN.replace(/\/+$/, "");
  const { pathname } = new URL(request.url);
  if (pathname === "/") {
    return redirect(`${gallery}/`, HOME_CACHE);
  }
  const link = SHARE_LINK.exec(pathname);
  const page = link?.[1];
  const code = link?.[2];
  if (page === undefined || code === undefined) {
    return notFound();
  }
  const object = await env.SNAPSHOT.get(`codes/${code}`);
  const body = object === null ? undefined : await object.text();
  const id = body?.trim();
  if (id === undefined || id === "") {
    return notFound();
  }
  const run = `${gallery}/runs/${encodeURIComponent(id)}`;
  return redirect(page === "r" ? `${run}/verdict` : run, REDIRECT_CACHE);
}

function redirect(location: string, cache: string): Response {
  return new Response(null, {
    status: 302,
    headers: { location, "cache-control": cache },
  });
}

function notFound(): Response {
  return new Response("Not Found", {
    status: 404,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": MISS_CACHE,
    },
  });
}

export default {
  fetch: handle,
};
