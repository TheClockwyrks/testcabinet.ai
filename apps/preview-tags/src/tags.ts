/**
 * A run page's preview tags: what they say, taken from the run's summary card
 * and its document, and how they are written into the shell's head.
 */

/** The fields of a `runs.json` summary card the tags are written from. */
export interface RunCard {
  id: string;
  caseName: string;
  subject: { modelId: string; harnessSlug: string; ggPreset?: string | null };
  rating: string | null;
  score: { earned: number; total: number } | null;
  reviewCount: number;
  documentKey?: string | null;
}

/** The media lists of a run document the image is chosen from. */
export interface RunDocument {
  showcaseMedia?: { file: string; key: string }[];
  assetMedia?: { file: string; key: string }[];
  proofMedia?: { kind: string; key: string }[];
}

export interface PreviewTags {
  title: string;
  description: string;
  url: string;
  image: string | null;
}

/** The still-image extensions a link preview can show. */
const IMAGE = /\.(?:png|jpe?g|webp|gif)$/i;

const SITE_NAME = "The Test Cabinet";

/**
 * The tags of a published run's page. The image is the run's first still in
 * the order its page presents media: its showcase, then its produced asset,
 * then its proof. A run with none takes no image.
 */
export function previewTags(
  run: RunCard,
  document: RunDocument | null,
  where: { snapshotOrigin: string; url: string },
): PreviewTags {
  const harness = run.subject.ggPreset ?? run.subject.harnessSlug;
  const figures = [
    run.rating === null ? undefined : `Rated ${run.rating}`,
    run.score === null || run.score.total <= 0
      ? undefined
      : `scored ${String(Math.round((100 * run.score.earned) / run.score.total))}%`,
    run.reviewCount === 0
      ? undefined
      : `${String(run.reviewCount)} review${run.reviewCount === 1 ? "" : "s"}`,
  ].filter((figure) => figure !== undefined);
  const key = imageKey(document);
  return {
    title: `${run.caseName}: ${run.subject.modelId} on ${harness}`,
    description: [
      `${run.subject.modelId} on ${harness}, a published run of ${run.caseName} on ${SITE_NAME}.`,
      figures.length === 0 ? undefined : `${figures.join(", ")}.`,
    ]
      .filter((part) => part !== undefined)
      .join(" "),
    url: where.url,
    image:
      key === undefined
        ? null
        : `${where.snapshotOrigin.replace(/\/+$/, "")}/${key
            .split("/")
            .map((part) => encodeURIComponent(part))
            .join("/")}`,
  };
}

function imageKey(document: RunDocument | null): string | undefined {
  return document === null
    ? undefined
    : (document.showcaseMedia?.find((media) => IMAGE.test(media.file))?.key ??
        document.assetMedia?.find((media) => IMAGE.test(media.file))?.key ??
        document.proofMedia?.find((media) => media.kind === "image")?.key);
}

/**
 * The shell with the tags written into its head: its `<title>` replaced, and
 * the description, Open Graph and Twitter card tags added before `</head>`.
 */
export function writeTags(shell: string, tags: PreviewTags): string {
  const meta = (attribute: string, name: string, content: string) =>
    `<meta ${attribute}="${name}" content="${escape(content)}" />`;
  const lines = [
    meta("name", "description", tags.description),
    meta("property", "og:type", "website"),
    meta("property", "og:site_name", SITE_NAME),
    meta("property", "og:title", tags.title),
    meta("property", "og:description", tags.description),
    meta("property", "og:url", tags.url),
    ...(tags.image === null ? [] : [meta("property", "og:image", tags.image)]),
    meta(
      "name",
      "twitter:card",
      tags.image === null ? "summary" : "summary_large_image",
    ),
    meta("name", "twitter:title", tags.title),
    meta("name", "twitter:description", tags.description),
    ...(tags.image === null ? [] : [meta("name", "twitter:image", tags.image)]),
  ];
  const title = `<title>${escape(`${tags.title} · ${SITE_NAME}`)}</title>`;
  const titled = /<title>[^<]*<\/title>/i.test(shell)
    ? shell.replace(/<title>[^<]*<\/title>/i, () => title)
    : shell.replace(/<\/head>/i, () => `${title}\n</head>`);
  return titled.replace(/<\/head>/i, () => `${lines.join("\n")}\n</head>`);
}

function escape(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
