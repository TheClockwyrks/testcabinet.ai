import { describe, expect, it } from "vitest";

import {
  createWorker,
  MISS_CACHE,
  PAGE_CACHE,
  POINTER_TTL_MS,
  type Env,
} from "./worker";

const SHELL = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <title>The Test Cabinet</title>
  </head>
  <body><div id="root"></div></body>
</html>`;

const CARD = {
  id: "run-1",
  caseName: "Pong <Deluxe>",
  subject: { modelId: "model-a", harnessSlug: "gg", ggPreset: "fast" },
  rating: "great",
  score: { earned: 3, total: 4 },
  reviewCount: 1,
  documentKey: "documents/runs/run-1/abc.json",
};

interface Fixture {
  objects: Map<string, string>;
  reads: string[];
  shellFetches: string[];
  clock: { now: number };
  env: Env;
  worker: ReturnType<typeof createWorker>;
}

function fixture(): Fixture {
  const objects = new Map<string, string>([
    ["index.json", JSON.stringify({ runsKey: "snapshots/g1/runs.json" })],
    ["snapshots/g1/runs.json", JSON.stringify({ runs: [CARD] })],
    [
      "documents/runs/run-1/abc.json",
      JSON.stringify({
        showcaseMedia: [
          { file: "clip.webm", key: "media/runs/run-1/showcase/clip.webm" },
          { file: "still.png", key: "media/runs/run-1/showcase/still.png" },
        ],
        proofMedia: [{ kind: "image", key: "media/runs/run-1/proof/a.png" }],
      }),
    ],
  ]);
  const reads: string[] = [];
  const shellFetches: string[] = [];
  const clock = { now: 0 };
  const env: Env = {
    SHELL_ORIGIN: "https://the-test-cabinet.pages.dev",
    SNAPSHOT_ORIGIN: "https://snapshot.testcabinet.ai",
    SNAPSHOT: {
      get: (key) => {
        reads.push(key);
        const body = objects.get(key);
        return Promise.resolve(
          body === undefined ? null : { text: () => Promise.resolve(body) },
        );
      },
    },
  };
  const worker = createWorker({
    fetch: (input) => {
      shellFetches.push(input);
      return Promise.resolve(new Response(SHELL, { status: 200 }));
    },
    now: () => clock.now,
  });
  return { objects, reads, shellFetches, clock, env, worker };
}

function get(f: Fixture, path: string, method = "GET"): Promise<Response> {
  return f.worker.fetch(
    new Request(`https://testcabinet.ai${path}`, { method }),
    f.env,
  );
}

describe("the preview-tag Worker", () => {
  it("writes a published run's tags into the shell with a 200", async () => {
    const f = fixture();
    const response = await get(f, "/runs/run-1/verdict");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe(PAGE_CACHE);
    expect(response.headers.get("content-type")).toContain("text/html");
    const html = await response.text();
    expect(html).toContain(
      "<title>Pong &lt;Deluxe&gt;: model-a on fast · The Test Cabinet</title>",
    );
    expect(html).not.toContain("<title>The Test Cabinet</title>");
    expect(html).toContain(
      '<meta property="og:title" content="Pong &lt;Deluxe&gt;: model-a on fast" />',
    );
    expect(html).toContain(
      '<meta property="og:image" content="https://snapshot.testcabinet.ai/media/runs/run-1/showcase/still.png" />',
    );
    expect(html).toContain(
      '<meta property="og:url" content="https://testcabinet.ai/runs/run-1/verdict" />',
    );
    expect(html).toContain(
      '<meta name="twitter:card" content="summary_large_image" />',
    );
    expect(html).toMatch(/Rated great, scored 75%, 1 review\./);
    expect(html.indexOf("og:title")).toBeLessThan(html.indexOf("</head>"));
    expect(f.shellFetches).toEqual(["https://the-test-cabinet.pages.dev/"]);
  });

  it("answers an unknown run id with the shell and an uncached 404", async () => {
    const f = fixture();
    const response = await get(f, "/runs/nope");
    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe(MISS_CACHE);
    expect(await response.text()).toBe(SHELL);
  });

  it("answers every run route with a 404 before anything is published", async () => {
    const f = fixture();
    f.objects.delete("index.json");
    const response = await get(f, "/runs/run-1");
    expect(response.status).toBe(404);
  });

  it("takes no image when the run's document holds no still", async () => {
    const f = fixture();
    f.objects.set("documents/runs/run-1/abc.json", JSON.stringify({}));
    const response = await get(f, "/runs/run-1");
    const html = await response.text();
    expect(html).not.toContain("og:image");
    expect(html).toContain('<meta name="twitter:card" content="summary" />');
  });

  it("holds the run index for as long as the pointer names it", async () => {
    const f = fixture();
    await get(f, "/runs/run-1");
    await get(f, "/runs/run-1");
    f.clock.now += POINTER_TTL_MS;
    await get(f, "/runs/run-1");
    const count = (key: string) => f.reads.filter((k) => k === key).length;
    expect(count("index.json")).toBe(2);
    expect(count("snapshots/g1/runs.json")).toBe(1);
    expect(count("documents/runs/run-1/abc.json")).toBe(1);
  });

  it("reads the new generation's index once the pointer moves", async () => {
    const f = fixture();
    const before = await get(f, "/runs/run-2");
    expect(before.status).toBe(404);
    f.objects.set(
      "index.json",
      JSON.stringify({ runsKey: "snapshots/g2/runs.json" }),
    );
    f.objects.set(
      "snapshots/g2/runs.json",
      JSON.stringify({ runs: [{ ...CARD, id: "run-2", documentKey: null }] }),
    );
    f.clock.now += POINTER_TTL_MS;
    const after = await get(f, "/runs/run-2");
    expect(after.status).toBe(200);
  });

  it("passes on a shell the Pages project failed to serve", async () => {
    const f = fixture();
    const worker = createWorker({
      fetch: () => Promise.resolve(new Response("down", { status: 503 })),
      now: () => 0,
    });
    const response = await worker.fetch(
      new Request("https://testcabinet.ai/runs/run-1"),
      f.env,
    );
    expect(response.status).toBe(503);
  });

  it.each(["/runs/comparisons", "/runs/comparisons/", "/runs/"])(
    "serves %s, a gallery page beside the run routes, untagged with a 200",
    async (path) => {
      const f = fixture();
      const response = await get(f, path);
      expect(response.status).toBe(200);
      expect(await response.text()).toBe(SHELL);
      expect(f.reads).toEqual([]);
    },
  );

  it("serves the shell untagged and uncached while the bucket cannot be read", async () => {
    const f = fixture();
    const bucket = f.env.SNAPSHOT;
    f.env.SNAPSHOT = {
      get: (key) =>
        key === "index.json"
          ? Promise.reject(new Error("R2 is down"))
          : bucket.get(key),
    };
    const down = await get(f, "/runs/run-1");
    expect(down.status).toBe(200);
    expect(down.headers.get("cache-control")).toBe(MISS_CACHE);
    expect(await down.text()).toBe(SHELL);

    f.env.SNAPSHOT = bucket;
    const back = await get(f, "/runs/run-1");
    expect(back.status).toBe(200);
    expect(back.headers.get("cache-control")).toBe(PAGE_CACHE);
  });

  it("reads a missing run index again rather than holding it as empty", async () => {
    const f = fixture();
    const index = f.objects.get("snapshots/g1/runs.json") ?? "";
    f.objects.delete("snapshots/g1/runs.json");
    const missing = await get(f, "/runs/run-1");
    expect(missing.headers.get("cache-control")).toBe(MISS_CACHE);
    f.objects.set("snapshots/g1/runs.json", index);
    const found = await get(f, "/runs/run-1");
    expect(found.status).toBe(200);
  });

  it("shares one read of the run index among concurrent requests", async () => {
    const f = fixture();
    await Promise.all([
      get(f, "/runs/run-1"),
      get(f, "/runs/run-1"),
      get(f, "/runs/nope"),
    ]);
    const count = (key: string) => f.reads.filter((k) => k === key).length;
    expect(count("index.json")).toBe(1);
    expect(count("snapshots/g1/runs.json")).toBe(1);
  });

  it("refuses every method but GET and HEAD", async () => {
    const f = fixture();
    const response = await get(f, "/runs/run-1", "POST");
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET, HEAD");
  });
});
