import type { Comparison } from "@clockwyrks/backend-api/comparison";
import type { RunRecord, RunSubject } from "@clockwyrks/run-record";
import type { CodeAnalysisDocument } from "@clockwyrks/run-record/code-analysis";
import type { GgRunDoc } from "@clockwyrks/run-record/gg-query";
import {
  DEFAULT_ENGINE_SLUG,
  findModelByModelId,
  foldCabinetStats,
  runSummaryPage,
  toModelSummary,
  toRunSummary,
  type CabinetStats,
  type CaseVariantRef,
  type GalleryDataInput,
  type RunDetail,
  type RunQuery,
  type SeededInput,
  type TestCaseDetail,
  type TestCaseGroupSummary,
  type TestCaseSummary,
  type VariantSummary,
} from "@clockwyrks/ui/app";
import type {
  HarnessEvent,
  Model,
  StoredReview,
  WorkspaceFileRef,
} from "@clockwyrks/ui/client";
import { readOutcome } from "@clockwyrks/ui/client";
import { useCallback, useEffect, useMemo, useState } from "react";

import type { AssembledCaseVersionMedia } from "./snapshot/assemble";
import type { SnapshotDataset, SnapshotReader } from "./snapshot/reader";

// The static site's gallery data source. The published dataset is read from the
// public bucket in the browser (see `./snapshot/reader`), merged in dev with
// produced-but-unpublished runs served from disk by the localRuns plugin. It
// produces the one `GalleryDataInput` the shared app consumes.
//
// The page mounts once the dataset — the run index, the model catalog, the
// comparisons, the groups and the gg corpus — is in, and this hook is handed it.
// The case catalog arrives after it (`testCasesStatus` says when), and everything
// that describes one run is read from that run's document when a page of the run
// opens. The site cannot run tests, so `canExecute` is false and `inProgress` is
// empty.

/**
 * One variant as a case version's file carries it: the gallery's
 * {@link VariantSummary} (the engineless rendering) plus the same prompt and
 * specs re-rendered for each engine the version declares that vendors a runtime.
 * A case's prompt and `.hbs` specs branch on the selected engine, so a run's
 * Inputs tab reads the entry for the engine its run recorded.
 *
 * The app's reading of `AssembledVariant` in `./snapshot/assemble`.
 */
interface SnapshotVariant extends VariantSummary {
  engineRenderings: Record<
    string,
    {
      prompt: string;
      seededInputs: SeededInput[];
      /** The variant's effective starter-workspace set for this engine — a
       * starter project is written against a runtime, so each rendering carries
       * its own (the engineless set is the variant's own `workspace`). */
      workspace: WorkspaceFileRef[];
    }
  >;
}

/** The part of a {@link TestCaseDetail} that spans the case's versions. */
type CaseDetail = Omit<TestCaseDetail, keyof TestCaseSummary | "variants">;

/** The catalog in the app's types. */
interface Catalog {
  testCases: TestCaseSummary[];
  details: Map<string, CaseDetail>;
  versions: Map<
    string,
    { variants: SnapshotVariant[]; media: AssembledCaseVersionMedia }
  >;
  catalogShowcaseMediaUrls: Record<string, Record<string, string>>;
}

/** A catalog's load state, as the gallery reads it. */
type CatalogStatus = GalleryDataInput["testCasesStatus"];

/** The catalog's load: still loading, assembled, or failed. */
type CatalogLoad =
  | { status: "loading" }
  | { status: "ready"; catalog: Catalog }
  | { status: "error" };

/**
 * Where one file of a recording's shared image store is, under `prefix`.
 *
 * The store is the one media the snapshot does NOT list file by file. A run's — or
 * a case version's — store holds a distinct file per unique image its recordings
 * drew, some fifteen hundred for the busiest case in the corpus, and one replay on
 * one page is all that ever asks for them. Instead each namespace carries a single
 * URL prefix and the name the recording itself carries completes it, which works
 * because a store file's name is a hash of its bytes and is published verbatim.
 *
 * The `img.` prefix MIRRORS `IMAGE_STORE_PREFIX` in
 * `engines/packages/case-harness/src/replay/store.ts` and `VALIDATION_IMAGE_PREFIX` in
 * `contracts/crates/contracts/src/layout.rs`; a declared output never carries it, so asking here
 * first costs a declared name nothing.
 */
function storeUrl(
  prefix: string | null | undefined,
  file: string,
): string | null {
  return prefix == null || !file.startsWith("img.") ? null : `${prefix}${file}`;
}

// The gallery-wide reviews map of a host that holds none outside a run's own
// document. One object, so the lookups memoized on it are built once.
const NO_REVIEWS: Readonly<Record<string, never>> = {};

const NO_CASES: TestCaseSummary[] = [];

const LOCAL_RUNS_URL = "/__local-runs__/index.json";

interface LocalRunsResponse {
  runs?: RunRecord[];
  writeups?: Record<string, string>;
}

export function useStaticGallery(
  reader: SnapshotReader,
  dataset: SnapshotDataset,
): GalleryDataInput {
  const [localRuns, setLocalRuns] = useState<RunRecord[] | null>(null);
  const [localWriteups, setLocalWriteups] = useState<Record<string, string>>(
    {},
  );
  const [loading, setLoading] = useState<boolean>(import.meta.env.DEV);
  const [catalogLoad, setCatalogLoad] = useState<CatalogLoad>({
    status: "loading",
  });

  useEffect(() => {
    if (!import.meta.env.DEV) return;
    let active = true;
    fetch(LOCAL_RUNS_URL)
      .then((response) =>
        response.ok
          ? (response.json() as Promise<LocalRunsResponse>)
          : { runs: [] },
      )
      .then((data) => {
        if (!active) return;
        setLocalRuns(data.runs ?? []);
        setLocalWriteups(data.writeups ?? {});
      })
      .catch(() => {
        if (active) setLocalRuns([]);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  // The catalog, read once the page has mounted. The reader shares one read, so
  // the resolvers below that await it ask for the same one.
  useEffect(() => {
    const mounted = { current: true };
    void (async () => {
      try {
        const catalog = (await reader.catalog()) as Catalog;
        if (mounted.current) setCatalogLoad({ status: "ready", catalog });
      } catch (error) {
        console.error("the gallery could not read the case catalog", error);
        if (mounted.current) setCatalogLoad({ status: "error" });
      }
    })();
    return () => {
      mounted.current = false;
    };
  }, [reader]);

  const publishedRunSummaries = dataset.runSummaries;
  const publishedById = useMemo(
    () =>
      new Map(publishedRunSummaries.map((summary) => [summary.id, summary])),
    [publishedRunSummaries],
  );

  // Everything derived from the loaded local runs is memoized on them, so a
  // render for any other reason — the catalog arriving — hands the gallery the
  // same tables and does not restart the surfaces keyed on them.
  const local = useMemo(() => localRuns ?? [], [localRuns]);
  const localIds = useMemo(() => new Set(local.map((run) => run.id)), [local]);
  // A small in-memory map of the DEV local runs' full records, keyed by id — the
  // only full records held in memory. The lazy `fetchRun` resolves a dev local
  // run from here; any other id reads the run's document.
  const localById = useMemo(
    () => new Map(local.map((run) => [run.id, run])),
    [local],
  );

  // The produced (dev-only local) runs as their own summary cards — mirroring the
  // console's `producedSummaries`, and folded into the `any` slice by
  // `queryRunSummaries` below so a listing sorts and pages them with the published
  // rows. Dev-only local runs have no published summary, so derive theirs from the
  // full record (they are unreviewed previews, so no reviews / null rating is
  // correct). The published run index stays internal to this module (queried by
  // `queryRunSummaries` below); it is never exposed whole.
  // A dev-only local run is a legacy-shaped preview: the site has no store to say
  // whether it is validator-rated, so it carries neither channel decided.
  const producedSummaries = useMemo(
    () =>
      local.map((run) =>
        toRunSummary({
          id: run.id,
          record: run,
          reviews: [],
          published: false,
          rating: null,
          aesthetic: null,
          validatorRated: false,
          score: null,
        }),
      ),
    [local],
  );

  // The public gallery lists only models that a run has actually used. The
  // catalog already surfaces any model with a recorded run automatically, so the
  // rows this drops are curated-but-never-run entries (added in the console but
  // not yet exercised) — real on a management console, but noise on the public
  // site. Resolve every run the site knows about (the published run index, plus
  // any dev-only local runs) to its catalog model with the same harness-aware
  // matcher the rest of the app uses, and keep only the models something
  // references.
  const models = useMemo(() => {
    const allModels = (dataset.models as Model[]).map(toModelSummary);
    const referencedModelSlugs = new Set<string>();
    for (const summary of [...publishedRunSummaries, ...producedSummaries]) {
      const model = findModelByModelId(
        allModels,
        summary.subject.modelId,
        summary.subject.harnessSlug,
      );
      if (model) referencedModelSlugs.add(model.slug);
    }
    return allModels.filter((model) => referencedModelSlugs.has(model.slug));
  }, [dataset, publishedRunSummaries, producedSummaries]);
  const modelsStatus: CatalogStatus = dataset.modelsFailed ? "error" : "ready";

  const catalog = catalogLoad.status === "ready" ? catalogLoad.catalog : null;
  const readCatalog = useCallback(
    async () => (await reader.catalog()) as Catalog,
    [reader],
  );

  // The catalog's listing cards. A case's detail is the part that spans its
  // versions joined with the latest version's variants, which a case page opens
  // on. A slug the catalog does not list resolves null.
  const testCases = catalog?.testCases ?? NO_CASES;
  const testCasesStatus: CatalogStatus = catalogLoad.status;
  const readTestCase = useCallback(
    async (slug: string): Promise<TestCaseDetail | null> => {
      const { testCases: cards, details, versions } = await readCatalog();
      const summary = cards.find((entry) => entry.slug === slug);
      const detail = details.get(slug);
      const latest = summary
        ? versions.get(`${slug}/${summary.latestVersion}`)
        : undefined;
      return summary && detail && latest
        ? { ...summary, ...detail, variants: latest.variants }
        : null;
    },
    [readCatalog],
  );

  // The inputs one run was given: the variant of the run's OWN case version,
  // rendered for the run's OWN engine. The catalog holds every published version,
  // so an older version resolves out of its own file rather than the latest
  // version's; and a version's file carries each variant's prompt and specs
  // re-rendered per engine, so a run on an engine reads that engine's rendering.
  // The engineless slug is the top-level pair, which is what a run selecting no
  // engine received. A version, variant, or engine this snapshot does not carry
  // resolves null, which the Inputs tab reports as unavailable.
  const readCaseVariant = useCallback(
    async (ref: CaseVariantRef): Promise<VariantSummary | null> => {
      const { versions } = await readCatalog();
      const file = versions.get(`${ref.slug}/${ref.version}`);
      const variant = file?.variants.find(
        (entry) => entry.slug === ref.variant,
      );
      if (!variant) return null;
      if (ref.engine === DEFAULT_ENGINE_SLUG) return variant;
      const rendering = variant.engineRenderings[ref.engine];
      if (!rendering) return null;
      return {
        ...variant,
        prompt: rendering.prompt,
        seededInputs: rendering.seededInputs,
        // The starter workspace is engine-keyed exactly as the prompt and specs
        // are (a starter project is written against a runtime), so the
        // rendering's set replaces the variant's engineless one too.
        workspace: rendering.workspace,
      };
    },
    [readCatalog],
  );

  // The only writeups and reviews this host holds outside a run's own document
  // are the dev-only local previews. A published run's cards, badges and
  // leaderboard rows read its rating, aesthetic and score off its summary card,
  // and its page reads its reviews from the run's document through `readRun`,
  // exactly as the console's do.
  const writeups = localWriteups;
  const reviews = NO_REVIEWS;

  // The Events tab's data source on the static site: a published run's normalized
  // event stream, which rides in the run's document (raw harness output is never
  // published). A run that recorded none is an absence: an empty stream, which the
  // tab renders as a run that recorded none. A read that FAILED is thrown, so the
  // tab reports the failure instead of showing an empty feed for events that
  // exist. Stable identity so the Events tab doesn't refetch on every render.
  const fetchRunEvents = useCallback(
    async (runId: string) => {
      const document = await reader.run(runId);
      return {
        events: (document?.events ?? []) as HarnessEvent[],
        raw: null,
      };
    },
    [reader],
  );

  // The Code tab's explorer tier on the static site: a published run's unbounded
  // code-analysis document, its own generation-keyed object, fetched here on
  // demand (the bounded summary rides on the record, so the provenance strip and
  // figure table never wait on this). The run's document says where it is; the
  // tab holds the run, so the document is normally read already.
  //
  // A run whose document names none resolves to `null`, which the tab renders as
  // "never analysed" — the honest reading, since the corpus is deliberately not
  // backfilled and therefore starts on the day the analyzer shipped. Stable
  // identity so the tab doesn't refetch on every render.
  const readCodeAnalysis = useCallback(
    async (runId: string) => {
      let media = reader.runMedia(runId);
      if (media === undefined) {
        const document = await reader.run(runId);
        media = document?.file.media;
      }
      const url = media?.codeAnalysisUrl;
      if (!url) return null;
      const response = await fetch(url);
      // A listed object the store no longer holds is still an absence ("never
      // analysed"); a read that failed for any other reason is reported as one.
      return readOutcome(response, `code analysis for run ${runId}`) ===
        "absent"
        ? null
        : ((await response.json()) as CodeAnalysisDocument);
    },
    [reader],
  );

  // Lazily resolve one run's detail — its full record plus every review — from
  // the run's document, so a summary-first page reads a whole run on demand, and
  // the media resolvers below answer for it from the moment this resolves. A
  // dev-only local run (which has no document) is resolved from the in-memory
  // `localById` map first. Wired as the host's `readRun` hook; the gallery
  // context's `fetchRun` delegates to it. Stable identity so consumers don't
  // refetch on every render.
  const fetchRun = useCallback(
    async (runId: string): Promise<RunDetail | null> => {
      const localRun = localById.get(runId);
      // A dev-only local run is by definition not published; everything the
      // bucket holds is. It is also a legacy-shaped, unreviewed preview (no
      // store to decide its channels).
      if (localRun)
        return {
          record: localRun,
          reviews: [],
          published: false,
          validatorRated: false,
          rating: null,
          aesthetic: null,
          // Lifted off the record the same way the rating channels are, so a
          // page reads `run.showcase` directly.
          showcase: localRun.showcase ?? null,
        };
      // Only a run the run index does not hold is absent, which is what the
      // run-detail layout prints as "No run found". An offline visitor, a 500
      // from the edge, or a body that won't parse is a read that FAILED and
      // throws, so the layout reports the failure instead — the same contract
      // the console's `readRun` follows, and the reason this host must not
      // collapse the two into one null.
      const document = await reader.run(runId);
      if (document === null) return null;
      const record = document.file.record as RunRecord;
      // The published summary card carries the store's word on the two rating
      // channels and whether the run is validator-rated — the same fields the
      // console reads off `GET /runs/{id}`.
      const summary = publishedById.get(runId);
      return {
        record,
        reviews: document.file.reviews as StoredReview[],
        published: true,
        validatorRated: summary?.validatorRated ?? false,
        rating: summary?.rating ?? null,
        aesthetic: summary?.aesthetic ?? null,
        showcase: record.showcase ?? null,
      };
    },
    [reader, localById, publishedById],
  );

  // Answer a paged summary query purely in memory — the static analog of the
  // console's backend offset endpoint. The queryable set is the published run
  // index (minus any dev local overrides, which the local card supersedes), plus —
  // for the `any` slice the listings ask for — the dev-only produced runs, so an
  // unpublished preview sorts and pages among the published rows exactly as it does
  // against the backend's `any` slice. `runSummaryPage` filters/sorts/windows the
  // set with the same semantics the backend uses, so a numbered page behaves
  // identically on both hosts.
  const queryRunSummaries = useCallback(
    async (query: RunQuery) => {
      const published = publishedRunSummaries.filter(
        (summary) => !localIds.has(summary.id),
      );
      return runSummaryPage(
        query.state === "any"
          ? [...producedSummaries, ...published]
          : published,
        query,
      );
    },
    [publishedRunSummaries, localIds, producedSummaries],
  );

  // The cabinet's headline figures, folded locally from the published run index
  // with the mirror of the backend's `fold_cabinet_stats` — the static analog of
  // the console's `GET /stats/cabinet`. The site's corpus is the published
  // snapshot alone (the backend's additionally counts unpublished runs), so the
  // figures are the published cabinet's. Pure and in-memory, so it never
  // rejects; async only to satisfy the host contract.
  const getCabinetStats = useCallback(
    async (): Promise<CabinetStats | null> =>
      foldCabinetStats(publishedRunSummaries, new Date()),
    [publishedRunSummaries],
  );

  // A published run's media, each resolved to an absolute bucket URL from the
  // run's document. These resolvers are synchronous and answer from the documents
  // `readRun` has read: a surface that holds a run got it through `readRun`, so
  // the run's media is on hand by the time it asks. Produced (local, dev-only)
  // runs are not published, so they have no published media. Stable identities,
  // so a surface keyed on one never refetches.

  // Proof media, keyed by served file name (`<proof-id>.<ext>`).
  const proofMediaUrl = useCallback(
    (runId: string, file: string): string | null =>
      reader.runMedia(runId)?.proof[file] ?? null,
    [reader],
  );

  // Asset-generation media (regenerated/preview/target image + action log), keyed
  // by served file name (`regenerated.png`, etc.).
  const assetMediaUrl = useCallback(
    (runId: string, file: string): string | null =>
      reader.runMedia(runId)?.asset[file] ?? null,
    [reader],
  );

  // The synthesized *actual* validation media (the model build's debug-script
  // outputs), keyed by the flat `<item>__<output>.<ext>` name the reviewer UI
  // requests (a video's `.webm` request resolving to its published `.mp4`). A
  // recording's shared image store resolves under the run's one prefix.
  const validationMediaUrl = useCallback(
    (runId: string, file: string) => {
      const media = reader.runMedia(runId);
      return (
        media?.validation[file] ?? storeUrl(media?.validationStorePrefix, file)
      );
    },
    [reader],
  );

  // Showcase media (the carousel files, plus any image the description
  // references), keyed by the recorded file name (a video's `.webm` request
  // resolving to its published `.mp4`).
  const showcaseMediaUrl = useCallback(
    (runId: string, file: string): string | null =>
      reader.runMedia(runId)?.showcase[file] ?? null,
    [reader],
  );

  // A case version's media is in the catalog, and the three resolvers below
  // answer from it. Before the catalog arrives they answer null, and each takes
  // a new identity when it does — which re-renders the surfaces reading them
  // through the gallery, now with the answer.
  const caseVersionMedia = useCallback(
    (slug: string, version: string) =>
      catalog?.versions.get(`${slug}/${version}`)?.media,
    [catalog],
  );

  // A CASE variant's authored showcase media (the carousel captured from the
  // reference implementation) — the case-side counterpart of the run showcase
  // above, keyed by variant then the authored file name (a video's `.webm`
  // request resolving to its published `.mp4`). The media a catalog card
  // previews may be of a version no published run built, so it is looked up
  // first. Null for a variant with no published showcase, and the surfaces then
  // degrade exactly like the run showcase.
  const caseShowcaseMediaUrl = useCallback(
    (
      slug: string,
      version: string,
      variant: string,
      file: string,
    ): string | null =>
      catalog?.catalogShowcaseMediaUrls[`${slug}/${version}/${variant}`]?.[
        file
      ] ??
      caseVersionMedia(slug, version)?.showcase[variant]?.[file] ??
      null,
    [catalog, caseVersionMedia],
  );

  // A published reference build's *baseline* validation media (the reference
  // implementation's declared outputs), keyed by `<engine>/<variant>` then the
  // flat `<item>__<output>.<ext>` name — the same file name the actual media is
  // requested under, resolved through the case version instead of the run. The
  // engine is in the key because a variant has one reference implementation per
  // engine, and a run is only comparable against the one it was built on.
  const validationBaselineUrl = useCallback(
    (subject: RunSubject, file: string): string | null => {
      const media = caseVersionMedia(
        subject.testCaseSlug,
        subject.testCaseVersion,
      );
      const key = `${subject.engineSlug}/${subject.variant}`;
      return (
        media?.baselines[key]?.[file] ??
        storeUrl(media?.baselineStorePrefixes[key], file)
      );
    },
    [caseVersionMedia],
  );

  // An asset-generation case variant's published reference frames — the rendered
  // image and the action log each was drawn from — keyed by variant then the file
  // below that variant's prefix (`frames/<index>.png`). Null for a variant with no
  // published reference, which is every non-asset case.
  const referenceMediaUrl = useCallback(
    (
      slug: string,
      version: string,
      variant: string,
      file: string,
    ): string | null =>
      caseVersionMedia(slug, version)?.reference[variant]?.[file] ?? null,
    [caseVersionMedia],
  );

  const comparisons = useMemo(
    () => dataset.comparisons as Comparison[],
    [dataset],
  );
  const readComparison = useCallback(
    (id: string) => comparisons.find((c) => c.id === id) ?? null,
    [comparisons],
  );
  const testCaseGroups = useMemo(
    () => dataset.testCaseGroups as TestCaseGroupSummary[],
    [dataset],
  );
  const ggData = useMemo(
    () =>
      dataset.ggRuns
        ? {
            generatedAt: dataset.ggRuns.generatedAt,
            documents: dataset.ggRuns.documents as GgRunDoc[],
          }
        : undefined,
    [dataset],
  );

  return {
    producedSummaries,
    localIds,
    writeups,
    reviews,
    runsLoading: loading,
    queryRunSummaries,
    getCabinetStats,
    testCases,
    testCasesStatus,
    // The test-case groups, already in display order. Empty when the snapshot
    // predates them, and the home page then renders no group leaderboards.
    testCaseGroups,
    readCaseVariant,
    readTestCase,
    // The model catalog, read with the dataset; the site has no backend to mutate
    // it, so the config affordances hide (no `createModel` on any client here).
    // Narrowed above to the models a run has actually used, so run-less curated
    // entries don't show here.
    models,
    modelsStatus,
    // The published harness comparisons, rendered read-only (no backend to
    // create/run/publish — those affordances gate on `canExecute`, which is false
    // here). A single comparison is resolved by id for the detail view.
    comparisons,
    readComparison,
    canExecute: false,
    // The exported gg document corpus, read with the dataset. This is the whole of
    // the site's analysis surface: `useGgSource` evaluates every query against these
    // documents in the browser with the mirrored evaluator, so `/gg/query` makes no
    // request at all. A snapshot without the corpus (one published before the export
    // existed) leaves this undefined, and the section is simply not mounted.
    ggData,
    // The public gallery has no backend to ask for a Grafana URL, and its readers
    // have no access to one — Grafana sits behind the edge's Access sign-in. Always
    // null, so the run view never offers a link nobody could follow.
    grafanaUrl: null,
    fetchRunEvents,
    readCodeAnalysis,
    // The host's lazy single-run fetcher; the gallery context's `fetchRun`
    // delegates to it.
    readRun: fetchRun,
    proofMediaUrl,
    assetMediaUrl,
    validationMediaUrl,
    showcaseMediaUrl,
    caseShowcaseMediaUrl,
    validationBaselineUrl,
    referenceMediaUrl,
  };
}
