import type { RunSummary } from "@clockwyrks/backend-api/snapshot";

import {
  assembleCatalog,
  assembleRunDocument,
  joinUrl,
  type AssembledCatalog,
  type AssembledRunDocument,
  type AssembledRunMedia,
  type SnapshotCaseFile,
  type SnapshotCaseShowcasesFile,
  type SnapshotComparisonsFile,
  type SnapshotGgRunsFile,
  type SnapshotIndex,
  type SnapshotModelsFile,
  type SnapshotRunFile,
  type SnapshotRunsFile,
  type SnapshotTestCaseGroupsFile,
} from "./assemble";
import {
  createSnapshotFetcher,
  DEFAULT_CONCURRENCY,
  forEachOrdered,
  SnapshotFetchError,
  type SnapshotFetcher,
} from "./fetch";

// The gallery's reader of the public snapshot, the bucket the backend publishes
// to (the superrepo's documentation: `components/backend/snapshot.md`, and
// `components/site/serving.md` for how the gallery reads it).
//
// Nothing of the dataset is in the bundle. The page reads `index.json`, the atomic
// pointer a publish writes last, and follows it in three steps:
//
//   - the DATASET, read when the page loads: the run index, the model catalog,
//     the comparison index, the test-case group set and the gg document corpus,
//     which are what the listing, home, leaderboard, model and Discover views
//     read;
//   - the CATALOG, read once the dataset is in: the case file of every case
//     version a published run built, and the case showcases, assembled into the
//     catalog's cards and each case's detail;
//   - one RUN DOCUMENT per run, read when a page of that run opens, reached
//     through the `documentKey` on its summary card.
//
// Each step is read once per page and shared by everyone who asks, and a step that
// failed is forgotten, so asking again tries again. A pointer the bucket does not
// hold is a deployment nothing has been published to yet, and reads as the empty
// dataset rather than a failure.

/** What the gallery reads when the page loads. */
export interface SnapshotDataset {
  /** The run index (`runs.json`), newest first: the bounded summary cards. */
  runSummaries: RunSummary[];
  /** The composed model catalog (wire `Model` shape). */
  models: unknown[];
  /**
   * Whether the model catalog the pointer names could not be read. A snapshot
   * that names none is an empty catalog, not a failed one.
   */
  modelsFailed: boolean;
  /** The published harness comparisons, each the full read model. */
  comparisons: unknown[];
  /** The test-case groups, already in display order. */
  testCaseGroups: unknown[];
  /**
   * The gg document corpus and the instant it was exported, or null when the
   * snapshot carries none, in which case the gallery mounts no analysis surface.
   */
  ggRuns: { generatedAt: string; documents: unknown[] } | null;
}

/** The dataset of a bucket nothing has been published to. */
export const EMPTY_DATASET: SnapshotDataset = {
  runSummaries: [],
  models: [],
  modelsFailed: false,
  comparisons: [],
  testCaseGroups: [],
  ggRuns: null,
};

const EMPTY_CATALOG: AssembledCatalog = {
  testCases: [],
  details: new Map(),
  versions: new Map(),
  catalogShowcaseMediaUrls: {},
};

export interface SnapshotReader {
  /**
   * The dataset. Resolves to {@link EMPTY_DATASET} for a bucket that holds no
   * pointer, and for a reader with no bucket at all; rejects when the pointer or
   * the run index it names cannot be read.
   */
  dataset(): Promise<SnapshotDataset>;
  /**
   * The case catalog. A case file the bucket does not hold is left out, as a
   * case the gallery has no framing for; any other failure rejects.
   */
  catalog(): Promise<AssembledCatalog>;
  /**
   * One run's document, or null when the run index holds no such run. Rejects
   * when the document cannot be read.
   */
  run(runId: string): Promise<AssembledRunDocument | null>;
  /** The media of a run {@link run} has resolved, or undefined before that. */
  runMedia(runId: string): AssembledRunMedia | undefined;
}

export interface SnapshotReaderOptions {
  fetcher?: SnapshotFetcher;
  /** How many case files are in flight at once. */
  concurrency?: number;
}

/**
 * A step read once and shared by everyone who asks; forgotten when it fails, so
 * the next ask tries again.
 */
function once<T>(read: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | null = null;
  return () => {
    pending ??= (async () => {
      try {
        return await read();
      } catch (error) {
        pending = null;
        throw error;
      }
    })();
    return pending;
  };
}

/** Whether `error` is the bucket answering that it holds no such object. */
function isAbsent(error: unknown): boolean {
  return error instanceof SnapshotFetchError && error.status === 404;
}

/**
 * The reader of the bucket whose public base is `base`, or of nothing when `base`
 * is empty: a development server or a build given no `TCAB_SNAPSHOT_URL`, which
 * renders the empty states.
 */
export function createSnapshotReader(
  base: string,
  options: SnapshotReaderOptions = {},
): SnapshotReader {
  const fetcher = options.fetcher ?? createSnapshotFetcher();
  const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
  const url = (key: string): string => joinUrl(base, key);

  // An object the pointer names optionally: absent from a snapshot published
  // before it existed, and degraded the same way when it cannot be read, so one
  // unreadable optional object never takes the gallery down with it.
  async function optional<T>(key: string | undefined): Promise<T | null> {
    if (!key) return null;
    try {
      return await fetcher.json<T>(url(key));
    } catch (error) {
      console.warn(`the gallery could not read ${url(key)}`, error);
      return null;
    }
  }

  // The pointer and the run index, with the summaries by id. Null for a bucket
  // that holds no pointer.
  const index = once(async () => {
    if (base === "") return null;
    let pointer: SnapshotIndex;
    try {
      pointer = await fetcher.json<SnapshotIndex>(url("index.json"));
    } catch (error) {
      if (isAbsent(error)) return null;
      throw error;
    }
    const runs = await fetcher.json<SnapshotRunsFile>(url(pointer.runsKey));
    return {
      pointer,
      runs: runs.runs,
      byId: new Map(runs.runs.map((summary) => [summary.id, summary])),
    };
  });

  const dataset = once(async (): Promise<SnapshotDataset> => {
    const loaded = await index();
    if (loaded === null) return EMPTY_DATASET;
    const { pointer } = loaded;
    const [models, comparisons, groups, ggRuns] = await Promise.all([
      optional<SnapshotModelsFile>(pointer.modelsKey),
      optional<SnapshotComparisonsFile>(pointer.comparisonsKey),
      optional<SnapshotTestCaseGroupsFile>(pointer.testCaseGroupsKey),
      optional<SnapshotGgRunsFile>(pointer.ggRunsKey),
    ]);
    return {
      runSummaries: loaded.runs,
      models: models?.models ?? [],
      modelsFailed: pointer.modelsKey !== undefined && models === null,
      comparisons: comparisons?.comparisons ?? [],
      testCaseGroups: groups?.groups ?? [],
      ggRuns: ggRuns
        ? { generatedAt: ggRuns.generatedAt, documents: ggRuns.documents }
        : null,
    };
  });

  const catalog = once(async (): Promise<AssembledCatalog> => {
    const loaded = await index();
    if (loaded === null) return EMPTY_CATALOG;
    const { pointer } = loaded;
    // The case version of every published run, in the order the runs first
    // name them.
    const keys = [
      ...new Set(
        loaded.runs.map(
          ({ subject }) =>
            `${pointer.casesPrefix}${subject.testCaseSlug}/${subject.testCaseVersion}.json`,
        ),
      ),
    ];
    const caseFiles: SnapshotCaseFile[] = [];
    const [caseShowcases] = await Promise.all([
      optional<SnapshotCaseShowcasesFile>(pointer.caseShowcasesKey),
      forEachOrdered(
        keys,
        concurrency,
        async (key) => {
          try {
            return await fetcher.json<SnapshotCaseFile>(url(key));
          } catch (error) {
            // A run can name a case version the snapshot did not emit; the
            // run still shows, without the case's framing.
            if (isAbsent(error)) return null;
            throw error;
          }
        },
        (file) => {
          if (file !== null) caseFiles.push(file);
        },
      ),
    ]);
    return assembleCatalog(base, caseFiles, caseShowcases);
  });

  const runs = new Map<string, () => Promise<AssembledRunDocument | null>>();
  const media = new Map<string, AssembledRunMedia>();

  return {
    dataset,
    catalog,
    run(runId) {
      let read = runs.get(runId);
      if (read === undefined) {
        read = once(async () => {
          const loaded = await index();
          const summary = loaded?.byId.get(runId);
          if (summary === undefined) return null;
          // The document is content-addressed, so its summary is what names it.
          if (!summary.documentKey) {
            throw new Error(
              `snapshot run summary ${runId} carries no documentKey; the snapshot is malformed`,
            );
          }
          const document = assembleRunDocument(
            base,
            await fetcher.json<SnapshotRunFile>(url(summary.documentKey)),
          );
          media.set(runId, document.file.media);
          return document;
        });
        runs.set(runId, read);
      }
      return read();
    },
    runMedia: (runId) => media.get(runId),
  };
}
