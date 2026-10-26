import { describe, expect, it } from "vitest";

import {
  handle,
  HOME_CACHE,
  MISS_CACHE,
  REDIRECT_CACHE,
  type Env,
} from "./worker";

function env(codes: Record<string, string>): Env {
  return {
    GALLERY_ORIGIN: "https://testcabinet.ai/",
    SNAPSHOT: {
      get: (key) => {
        const code = key.startsWith("codes/") ? codes[key.slice(6)] : undefined;
        return Promise.resolve(
          code === undefined ? null : { text: () => Promise.resolve(code) },
        );
      },
    },
  };
}

const CODES = { "0123abcd": "0123abcd-ef45-6789\n" };

function get(path: string, method = "GET"): Promise<Response> {
  return handle(new Request(`https://tcab.ai${path}`, { method }), env(CODES));
}

describe("the share-link Worker", () => {
  it("redirects /r/<code> to the run's verdict page", async () => {
    const response = await get("/r/0123abcd");
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      "https://testcabinet.ai/runs/0123abcd-ef45-6789/verdict",
    );
    expect(response.headers.get("cache-control")).toBe(REDIRECT_CACHE);
  });

  it("redirects /p/<code> to the run's play page", async () => {
    const response = await get("/p/0123abcd/");
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      "https://testcabinet.ai/runs/0123abcd-ef45-6789",
    );
  });

  it("answers HEAD as GET", async () => {
    const response = await get("/p/0123abcd", "HEAD");
    expect(response.status).toBe(302);
  });

  it("answers a code the bucket holds no object for with an uncached 404", async () => {
    const response = await get("/r/ffffffff");
    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe(MISS_CACHE);
  });

  it.each(["/x/0123abcd", "/r/", "/r/0123abcd/extra", "/r/..%2Fcodes"])(
    "answers %s with a 404",
    async (path) => {
      const response = await get(path);
      expect(response.status).toBe(404);
    },
  );

  it("sends the bare host to the gallery", async () => {
    const response = await get("/");
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("https://testcabinet.ai/");
    expect(response.headers.get("cache-control")).toBe(HOME_CACHE);
  });

  it("refuses every method but GET and HEAD", async () => {
    const response = await get("/r/0123abcd", "POST");
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET, HEAD");
  });
});
