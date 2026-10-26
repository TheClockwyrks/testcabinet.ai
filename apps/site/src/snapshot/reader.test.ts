import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createSnapshotFetcher, type SnapshotFetch } from "./fetch";
import { createSnapshotReader, EMPTY_DATASET } from "./reader";

const BASE = "https://snapshot.example";
const RUNS = 12;
const CASES = ["alpha", "beta", "gamma"];

function runId(index: number): string {
  return `run-${String(index).padStart(2, "0")}`;
}

function caseOf(index: number): string {
  const slug = CASES[index % CASES.length];
  if (slug === undefined) throw new Error(`no case ${String(index)}`);
  return slug;
}

/** A small published snapshot: every object by its key, as the bucket serves it. */
function snapshotObjects(): Map<string, unknown> {
  const objects = new Map<string, unknown>([
    [
      "index.json",
      {
        schemaVersion: 1,
        snapshotId: "s1",
        generatedAt: "2026-10-12T00:00:00Z",
        runCount: RUNS,
        runsKey: "s1/runs.json",
        runDocumentsPrefix: "docs/",
        casesPrefix: "s1/cases/",
        modelsKey: "s1/models.json",
      },
    ],
    [
      "s1/runs.json",
      {
        schemaVersion: 1,
        runs: Array.from({ length: RUNS }, (_unused, index) => ({
          id: runId(index),
          documentKey: `docs/${runId(index)}.json`,
          subject: { testCaseSlug: caseOf(index), testCaseVersion: "1.0.0" },
        })),
      },
    ],
  ]);
  for (let index = 0; index < RUNS; index += 1) {
    objects.set(`docs/${runId(index)}.json`, {
      schemaVersion: 1,
      record: { id: runId(index), payload: index },
      reviews: [],
      proofMedia: [
        { id: "p", kind: "image", key: `media/${runId(index)}/proof.png` },
      ],
      // Every third run has no event log.
      ...(index % 3 !== 0 && { events: [{ seq: index }] }),
    });
  }
  for (const slug of CASES) {
    objects.set(`s1/cases/${slug}/1.0.0.json`, {
      schemaVersion: 1,
      slug,
      version: "1.0.0",
      name: slug,
      difficulty: "easy",
      tags: [],
      summary: null,
      description: null,
      variants: [],
    });
  }
  objects.set("s1/models.json", { schemaVersion: 1, models: [{ id: "m1" }] });
  return objects;
}

interface Bucket {
  fetch: SnapshotFetch;
  requests: string[];
  peak: () => number;
}

/**
 * A bucket over `objects`. `delay` is how long a key's response takes, and
 * `failures` how many times a key answers with `failWith` before it is served.
 */
function bucket(
  objects: Map<string, unknown>,
  options: {
    delay?: (key: string) => number;
    failures?: Map<string, number>;
    failWith?: () => Promise<Response>;
  } = {},
): Bucket {
  const requests: string[] = [];
  const remaining = new Map(options.failures);
  let inFlight = 0;
  let peak = 0;
  return {
    requests,
    peak: () => peak,
    fetch: async (url) => {
      const key = url.slice(BASE.length + 1);
      requests.push(key);
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      try {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, options.delay?.(key) ?? 1);
        });
        const left = remaining.get(key) ?? 0;
        if (left > 0) {
          remaining.set(key, left - 1);
          return await (
            options.failWith ??
            (() => Promise.reject(new TypeError("terminated")))
          )();
        }
        return objects.has(key)
          ? Response.json(objects.get(key), { status: 200 })
          : new Response("", { status: 404, statusText: "Not Found" });
      } finally {
        inFlight -= 1;
      }
    },
  };
}

/** A case version's snapshot file with one variant that declares a showcase. */
function caseFile(
  slug: string,
  version: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    schemaVersion: 1,
    slug,
    version,
    name: slug,
    difficulty: "easy",
    tags: ["t"],
    summary: "a summary",
    description: `${slug} ${version} described`,
    changelog: `${version} changed`,
    domains: [{ id: "play", name: "Play", description: "" }],
    variants: [
      {
        slug: "base",
        name: "Base",
        description: null,
        prompt: `${version} prompt`,
        engineRenderings: { tide: { prompt: `${version} prompt for tide` } },
        showcase: {
          description: "shown",
          media: [
            {
              file: "clip.webm",
              name: "Clip",
              kind: "video",
              key: `media/${slug}/${version}/clip.mp4`,
            },
          ],
        },
        referenceSheet: { frames: [2] },
      },
    ],
    validationBaselines: [
      {
        engine: "tide",
        variant: "base",
        file: "item__shot.png",
        key: `base/${slug}/${version}/item__shot.png`,
      },
      {
        engine: "tide",
        variant: "base",
        file: "img.abc.png",
        key: `base/${slug}/${version}/store/img.abc.png`,
      },
    ],
    ...extra,
  };
}

/** A run document's delay that brings the newest runs back last. */
function reversed(key: string): number {
  const match = /^docs\/run-(\d+)\.json$/.exec(key);
  return match ? (RUNS - Number(match[1])) * 10 : 1;
}

/** A reader over `source`, as the page creates it. */
function readerOf(source: Bucket, concurrency = 6) {
  const fetcher = createSnapshotFetcher({ fetch: source.fetch });
  return {
    fetcher,
    reader: createSnapshotReader(BASE, { fetcher, concurrency }),
  };
}

/** The outcome of `pending`, captured so a rejection is never left unhandled. */
async function outcomeOf<T>(
  pending: Promise<T>,
): Promise<{ value: T } | { error: Error }> {
  try {
    return { value: await pending };
  } catch (error: unknown) {
    return { error: error as Error };
  }
}

/** Drive `pending` to its end on the fake clock. */
async function settle<T>(pending: Promise<T>): Promise<T> {
  const outcome = outcomeOf(pending);
  await vi.runAllTimersAsync();
  const result = await outcome;
  if ("error" in result) throw result.error;
  return result.value;
}

/** A case showcases entry of `slug` at `version`, one showcase per variant. */
function showcaseEntry(slug: string, version: string, variants: string[]) {
  return {
    slug,
    version,
    variants: variants.map((variant) => ({
      variant,
      showcase: {
        description: "shown",
        media: [
          {
            file: "play.json.gz",
            name: `${version} play`,
            kind: "replay",
            key: `media/cases/${slug}/${version}/showcase/${variant}/d-play.json.gz`,
          },
        ],
      },
    })),
  };
}

/** `objects` with a case showcases file the pointer names. */
function withShowcases(objects: Map<string, unknown>) {
  const index = objects.get("index.json") as Record<string, unknown>;
  index.caseShowcasesKey = "s1/case-showcases.json";
  objects.set("s1/case-showcases.json", {
    schemaVersion: 2,
    showcases: [
      showcaseEntry("alpha", "1.0.0", ["base"]),
      // Newer than any run of alpha, and listed out of order: the newest wins
      // by version, not by position.
      showcaseEntry("alpha", "10.0.0", ["second", "base"]),
      showcaseEntry("alpha", "2.0.0", ["base"]),
      // A case no published run built: it stays unlisted.
      showcaseEntry("unlisted", "1.0.0", ["base"]),
    ],
  });
  objects.set("s1/cases/alpha/1.0.0.json", caseFile("alpha", "1.0.0"));
  return objects;
}

/** The catalog a reader over `objects` assembles. */
async function catalogOf(objects: Map<string, unknown>) {
  return settle(readerOf(bucket(objects)).reader.catalog());
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("dataset", () => {
  it("reads the pointer, the run index and the objects the pointer names", async () => {
    const source = bucket(snapshotObjects());
    const { reader } = readerOf(source);

    const dataset = await settle(reader.dataset());

    expect(dataset.runSummaries.map((summary) => summary.id)).toEqual(
      Array.from({ length: RUNS }, (_unused, index) => runId(index)),
    );
    expect(dataset.models).toEqual([{ id: "m1" }]);
    expect(dataset.modelsFailed).toBe(false);
    expect(dataset.comparisons).toEqual([]);
    expect(dataset.testCaseGroups).toEqual([]);
    expect(dataset.ggRuns).toBeNull();
    // No run document and no case file is read before a page asks for one.
    expect(source.requests).toHaveLength(3);
    expect(source.requests).toEqual(
      expect.arrayContaining(["index.json", "s1/models.json", "s1/runs.json"]),
    );
  });

  it("reads the comparisons, the groups and the gg corpus the pointer names", async () => {
    const objects = snapshotObjects();
    Object.assign(objects.get("index.json") as object, {
      comparisonsKey: "s1/comparisons.json",
      testCaseGroupsKey: "s1/test-case-groups.json",
      ggRunsKey: "s1/gg-runs.json",
    });
    objects.set("s1/comparisons.json", { comparisons: [{ id: "c1" }] });
    objects.set("s1/test-case-groups.json", { groups: [{ slug: "g" }] });
    objects.set("s1/gg-runs.json", {
      generatedAt: "2026-10-12T00:00:00Z",
      documents: [{ "run.id": "g1" }],
    });

    const dataset = await settle(readerOf(bucket(objects)).reader.dataset());

    expect(dataset.comparisons).toEqual([{ id: "c1" }]);
    expect(dataset.testCaseGroups).toEqual([{ slug: "g" }]);
    expect(dataset.ggRuns).toEqual({
      generatedAt: "2026-10-12T00:00:00Z",
      documents: [{ "run.id": "g1" }],
    });
  });

  it("is the empty dataset when the bucket holds no pointer, on one request", async () => {
    const objects = snapshotObjects();
    objects.delete("index.json");
    const source = bucket(objects);
    const { reader } = readerOf(source);

    expect(await settle(reader.dataset())).toEqual(EMPTY_DATASET);
    const catalog = await settle(reader.catalog());
    expect(catalog.testCases).toEqual([]);
    const run = await settle(reader.run(runId(0)));
    expect(run).toBeNull();
    expect(source.requests).toEqual(["index.json"]);
  });

  it("is the empty dataset without a bucket, reading nothing", async () => {
    const source = bucket(snapshotObjects());
    const reader = createSnapshotReader("", {
      fetcher: createSnapshotFetcher({ fetch: source.fetch }),
    });

    expect(await settle(reader.dataset())).toEqual(EMPTY_DATASET);
    const run = await settle(reader.run(runId(0)));
    expect(run).toBeNull();
    expect(source.requests).toEqual([]);
  });

  it("rides out a dropped connection", async () => {
    const source = bucket(snapshotObjects(), {
      failures: new Map([
        ["index.json", 1],
        ["s1/runs.json", 2],
      ]),
    });
    const { reader, fetcher } = readerOf(source);

    const dataset = await settle(reader.dataset());

    expect(dataset.runSummaries).toHaveLength(RUNS);
    expect(fetcher.retried).toBe(2);
  });

  it("fails when the pointer keeps failing, and tries again when asked again", async () => {
    const source = bucket(snapshotObjects(), {
      failures: new Map([["index.json", 5]]),
      failWith: () =>
        Promise.resolve(
          new Response("", { status: 502, statusText: "Bad Gateway" }),
        ),
    });
    const { reader } = readerOf(source);

    await expect(settle(reader.dataset())).rejects.toThrow(
      `502 Bad Gateway for ${BASE}/index.json after 5 attempts`,
    );
    // The failure is forgotten: the next ask reads the bucket again.
    const dataset = await settle(reader.dataset());
    expect(dataset.runSummaries).toHaveLength(RUNS);
  });

  it("fails when the run index the pointer names is absent", async () => {
    const objects = snapshotObjects();
    objects.delete("s1/runs.json");
    const { reader } = readerOf(bucket(objects));

    await expect(settle(reader.dataset())).rejects.toThrow(
      `404 Not Found for ${BASE}/s1/runs.json after 1 attempt`,
    );
  });

  it("reports a model catalog that cannot be read, and degrades the rest", async () => {
    const objects = snapshotObjects();
    Object.assign(objects.get("index.json") as object, {
      ggRunsKey: "s1/gg-runs.json",
    });
    const source = bucket(objects, {
      failures: new Map([["s1/models.json", 99]]),
    });
    vi.spyOn(console, "warn").mockReturnValue(undefined);

    const dataset = await settle(readerOf(source).reader.dataset());

    expect(dataset.models).toEqual([]);
    expect(dataset.modelsFailed).toBe(true);
    expect(dataset.ggRuns).toBeNull();
    expect(dataset.runSummaries).toHaveLength(RUNS);
  });

  it("shares one read between everyone who asks", async () => {
    const source = bucket(snapshotObjects());
    const { reader } = readerOf(source);

    await settle(Promise.all([reader.dataset(), reader.dataset()]));
    await settle(reader.run(runId(1)));

    expect(source.requests.filter((key) => key === "index.json")).toHaveLength(
      1,
    );
  });
});

describe("run", () => {
  it("assembles a run's record, reviews and media, and sets its events apart", async () => {
    const objects = snapshotObjects();
    objects.set("docs/run-01.json", {
      schemaVersion: 1,
      record: { id: "run-01", payload: 1 },
      reviews: [
        {
          reviewer: "Ada",
          ratings: [{ domain: "play", rating: "great" }],
          aesthetics: [
            { domain: "play", rating: "good" },
            { domain: "feel", rating: "okay" },
          ],
          writeup: "Plays well.",
        },
      ],
      proofMedia: [{ id: "p", kind: "image", key: "media/run-01/proof.png" }],
      assetMedia: [{ file: "preview.png", key: "media/run-01/preview.png" }],
      validationMedia: [
        { file: "item__clip.webm", key: "val/run-01/item__clip.mp4" },
        { file: "img.one.png", key: "val/run-01/store/img.one.png" },
        { file: "img.two.png", key: "val/run-01/store/img.two.png" },
      ],
      showcaseMedia: [{ file: "hero.png", key: "show/run-01/hero.png" }],
      codeAnalysisKey: "code/run-01/7.json",
      events: [{ seq: 1 }],
    });
    const { reader } = readerOf(bucket(objects));

    expect(reader.runMedia("run-01")).toBeUndefined();
    const document = await settle(reader.run("run-01"));

    expect(document).toEqual({
      file: {
        record: { id: "run-01", payload: 1 },
        reviews: [
          {
            reviewer: "Ada",
            ratings: [{ domain: "play", rating: "great" }],
            aesthetic: "okay",
            aesthetics: [
              { domain: "play", rating: "good" },
              { domain: "feel", rating: "okay" },
            ],
            writeup: "Plays well.",
            checklist: [],
            reviewedAt: null,
          },
        ],
        media: {
          proof: { "proof.png": `${BASE}/media/run-01/proof.png` },
          asset: { "preview.png": `${BASE}/media/run-01/preview.png` },
          validation: {
            "item__clip.webm": `${BASE}/val/run-01/item__clip.mp4`,
          },
          validationStorePrefix: `${BASE}/val/run-01/store/`,
          showcase: { "hero.png": `${BASE}/show/run-01/hero.png` },
          codeAnalysisUrl: `${BASE}/code/run-01/7.json`,
        },
      },
      events: [{ seq: 1 }],
    });
    expect(reader.runMedia("run-01")).toEqual(document?.file.media);
  });

  it("gives a run that published none of it every field, empty", async () => {
    const { reader } = readerOf(bucket(snapshotObjects()));
    const document = await settle(reader.run("run-00"));

    expect(document).toEqual({
      file: {
        record: { id: "run-00", payload: 0 },
        reviews: [],
        media: {
          proof: { "proof.png": `${BASE}/media/run-00/proof.png` },
          asset: {},
          validation: {},
          validationStorePrefix: null,
          showcase: {},
          codeAnalysisUrl: null,
        },
      },
      events: null,
    });
  });

  it("is null for a run the run index does not hold, reading no document", async () => {
    const source = bucket(snapshotObjects());

    expect(await settle(readerOf(source).reader.run("nope"))).toBeNull();
    expect(source.requests).toEqual(["index.json", "s1/runs.json"]);
  });

  it("fails on a run document that is absent, without retrying it", async () => {
    const objects = snapshotObjects();
    objects.delete("docs/run-05.json");
    const source = bucket(objects);

    await expect(settle(readerOf(source).reader.run("run-05"))).rejects.toThrow(
      `404 Not Found for ${BASE}/docs/run-05.json after 1 attempt`,
    );
    expect(
      source.requests.filter((key) => key === "docs/run-05.json"),
    ).toHaveLength(1);
  });

  it("fails on a summary with no documentKey, reading no document", async () => {
    const objects = snapshotObjects();
    const runs = objects.get("s1/runs.json") as {
      runs: { documentKey?: string }[];
    };
    delete runs.runs[9]?.documentKey;
    const source = bucket(objects);

    await expect(settle(readerOf(source).reader.run("run-09"))).rejects.toThrow(
      "snapshot run summary run-09 carries no documentKey",
    );
    expect(source.requests).toEqual(["index.json", "s1/runs.json"]);
  });

  it("reads a document once, and again after a read that failed", async () => {
    const source = bucket(snapshotObjects(), {
      failures: new Map([["docs/run-02.json", 5]]),
    });
    const { reader } = readerOf(source);

    await expect(settle(reader.run("run-02"))).rejects.toThrow(
      `terminated for ${BASE}/docs/run-02.json after 5 attempts`,
    );
    await settle(Promise.all([reader.run("run-02"), reader.run("run-02")]));

    expect(
      source.requests.filter((key) => key === "docs/run-02.json"),
    ).toHaveLength(6);
  });
});

describe("catalog", () => {
  it("assembles the same catalog at any concurrency", async () => {
    const { reader } = readerOf(bucket(snapshotObjects()), 1);
    const sequential = await settle(reader.catalog());
    const source = bucket(snapshotObjects(), { delay: reversed });
    const concurrent = await settle(readerOf(source, 6).reader.catalog());

    expect(concurrent).toEqual(sequential);
    expect(concurrent.testCases.map((entry) => entry.slug)).toEqual(CASES);
    // The case files and nothing of any run.
    expect(source.requests.some((key) => key.startsWith("docs/"))).toBe(false);
  });

  it("reads the case files a few at a time", async () => {
    const objects = snapshotObjects();
    const runs = objects.get("s1/runs.json") as {
      runs: { subject: { testCaseVersion: string } }[];
    };
    // A version per run, so there are as many case files as runs.
    for (const [index, summary] of runs.runs.entries()) {
      const version = `1.0.${String(index)}`;
      summary.subject.testCaseVersion = version;
      objects.set(
        `s1/cases/${caseOf(index)}/${version}.json`,
        caseFile(caseOf(index), version),
      );
    }
    const source = bucket(objects);

    await settle(readerOf(source, 4).reader.catalog());

    expect(source.peak()).toBe(4);
  });

  it("leaves out a case file the bucket does not hold", async () => {
    const objects = snapshotObjects();
    objects.delete("s1/cases/beta/1.0.0.json");

    const catalog = await settle(readerOf(bucket(objects)).reader.catalog());

    expect(catalog.testCases.map((entry) => entry.slug)).toEqual([
      "alpha",
      "gamma",
    ]);
    expect(Array.from(catalog.details, ([key]) => key)).toEqual([
      "alpha",
      "gamma",
    ]);
    expect(Array.from(catalog.versions, ([key]) => key)).toEqual([
      "alpha/1.0.0",
      "gamma/1.0.0",
    ]);
  });

  it("fails on a case file that keeps failing, and tries again when asked again", async () => {
    const source = bucket(snapshotObjects(), {
      failures: new Map([["s1/cases/beta/1.0.0.json", 5]]),
    });
    const { reader } = readerOf(source);

    await expect(settle(reader.catalog())).rejects.toThrow(
      `terminated for ${BASE}/s1/cases/beta/1.0.0.json after 5 attempts`,
    );
    const catalog = await settle(reader.catalog());
    expect(catalog.testCases).toHaveLength(3);
  });

  it("splits a case into its listing card, its detail and a file per version", async () => {
    const objects = snapshotObjects();
    const runs = objects.get("s1/runs.json") as {
      runs: {
        subject: { testCaseSlug: string; testCaseVersion: string };
      }[];
    };
    // The oldest alpha run was of an older version, referenced after the newer.
    const oldest = runs.runs[9];
    if (oldest) oldest.subject.testCaseVersion = "0.9.0";
    objects.set("s1/cases/alpha/1.0.0.json", caseFile("alpha", "1.0.0"));
    objects.set(
      "s1/cases/alpha/0.9.0.json",
      caseFile("alpha", "0.9.0", { changelog: null }),
    );

    const catalog = await settle(readerOf(bucket(objects)).reader.catalog());

    // The listing card, and the media that card previews.
    expect(catalog.testCases.find((entry) => entry.slug === "alpha")).toEqual({
      slug: "alpha",
      name: "alpha",
      testType: "end-to-end",
      assetKind: null,
      difficulty: "easy",
      tags: ["t"],
      summary: "a summary",
      versions: ["1.0.0", "0.9.0"],
      latestVersion: "1.0.0",
      showcase: {
        version: "1.0.0",
        variant: "base",
        media: [{ file: "clip.webm", name: "Clip", kind: "video" }],
      },
    });
    expect(catalog.catalogShowcaseMediaUrls).toEqual({
      "alpha/1.0.0/base": {
        "clip.webm": `${BASE}/media/alpha/1.0.0/clip.mp4`,
      },
    });

    // What spans the case's versions.
    expect(catalog.details.get("alpha")).toEqual({
      description: "alpha 1.0.0 described",
      descriptionsByVersion: {
        "1.0.0": "alpha 1.0.0 described",
        "0.9.0": "alpha 0.9.0 described",
      },
      changelog: [{ version: "1.0.0", body: "1.0.0 changed" }],
      errata: [],
      variantsByVersion: {
        "1.0.0": [{ slug: "base", name: "Base" }],
        "0.9.0": [{ slug: "base", name: "Base" }],
      },
      enginesByVersion: {
        "1.0.0": ["none", "tide"],
        "0.9.0": ["none", "tide"],
      },
      domains: [{ id: "play", name: "Play", description: "" }],
      sheet: null,
    });

    // One file per version, each with its own variants and media.
    expect(
      Array.from(catalog.versions, ([id]) => id).filter((id) =>
        id.startsWith("alpha/"),
      ),
    ).toEqual(["alpha/1.0.0", "alpha/0.9.0"]);
    const older = catalog.versions.get("alpha/0.9.0");
    expect(older?.variants[0]?.prompt).toBe("0.9.0 prompt");
    expect(older?.variants[0]?.engineRenderings.tide?.prompt).toBe(
      "0.9.0 prompt for tide",
    );
    expect(older?.media).toEqual({
      baselines: {
        "tide/base": {
          "item__shot.png": `${BASE}/base/alpha/0.9.0/item__shot.png`,
        },
      },
      baselineStorePrefixes: {
        "tide/base": `${BASE}/base/alpha/0.9.0/store/`,
      },
      showcase: {
        base: { "clip.webm": `${BASE}/media/alpha/0.9.0/clip.mp4` },
      },
      reference: {
        base: {
          "frames/2.png": `${BASE}/media/references/alpha/0.9.0/base/frames/2.png`,
          "frames/2.actions.json": `${BASE}/media/references/alpha/0.9.0/base/frames/2.actions.json`,
        },
      },
    });
  });

  // A case is listed once any run of it is published, and previews its NEWEST
  // showcase from `case-showcases.json` — even when that version has no published
  // run, and so no case file of its own.
  describe("with the case showcases", () => {
    it("previews a case with its newest showcase, run or no run", async () => {
      const catalog = await catalogOf(withShowcases(snapshotObjects()));
      const alpha = catalog.testCases.find((entry) => entry.slug === "alpha");
      // Listed at the version its runs built, previewed from the newest showcase,
      // first variant in manifest order.
      expect(alpha?.latestVersion).toBe("1.0.0");
      expect(alpha?.showcase).toEqual({
        version: "10.0.0",
        variant: "second",
        media: [{ file: "play.json.gz", name: "10.0.0 play", kind: "replay" }],
      });
      const urls = catalog.catalogShowcaseMediaUrls;
      expect(urls["alpha/10.0.0/second"]).toEqual({
        "play.json.gz": `${BASE}/media/cases/alpha/10.0.0/showcase/second/d-play.json.gz`,
      });
      expect(
        Object.keys(urls).some((key) => key.startsWith("alpha/1.0.0")),
      ).toBe(false);
    });

    it("lists no case that only the showcases name", async () => {
      const catalog = await catalogOf(withShowcases(snapshotObjects()));
      expect(catalog.testCases.map((entry) => entry.slug)).not.toContain(
        "unlisted",
      );
      expect(
        Object.keys(catalog.catalogShowcaseMediaUrls).some((key) =>
          key.startsWith("unlisted/"),
        ),
      ).toBe(false);
    });

    it("previews nothing for a listed case with no showcase in the file", async () => {
      // The file is authoritative when present: a case it carries no showcase for
      // previews the placeholder rather than an older case file's showcase.
      const objects = withShowcases(snapshotObjects());
      const file = objects.get("s1/case-showcases.json") as {
        showcases: { slug: string }[];
      };
      file.showcases = file.showcases.filter((entry) => entry.slug !== "alpha");
      const catalog = await catalogOf(objects);
      expect(
        catalog.testCases.find((entry) => entry.slug === "alpha")?.showcase,
      ).toBeNull();
    });

    it("passes over a newer version whose showcase has no media", async () => {
      // A showcase whose media the publisher could not find in its store reaches
      // the file empty; the preview takes the next version down instead.
      const objects = withShowcases(snapshotObjects());
      const file = objects.get("s1/case-showcases.json") as {
        showcases: {
          version: string;
          variants: { showcase: { media: unknown[] } }[];
        }[];
      };
      for (const entry of file.showcases) {
        if (entry.version === "10.0.0") {
          for (const variant of entry.variants) variant.showcase.media = [];
        }
      }
      const catalog = await catalogOf(objects);
      expect(
        catalog.testCases.find((entry) => entry.slug === "alpha")?.showcase
          ?.version,
      ).toBe("2.0.0");
    });

    it("falls back to the case files when the showcases cannot be read", async () => {
      const objects = withShowcases(snapshotObjects());
      objects.delete("s1/case-showcases.json");
      vi.spyOn(console, "warn").mockReturnValue(undefined);
      const catalog = await catalogOf(objects);
      expect(
        catalog.testCases.find((entry) => entry.slug === "alpha")?.showcase,
      ).toEqual({
        version: "1.0.0",
        variant: "base",
        media: [{ file: "clip.webm", name: "Clip", kind: "video" }],
      });
    });
  });
});
