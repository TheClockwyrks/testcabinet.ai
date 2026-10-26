import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, searchForWorkspaceRoot } from "vite";
import react from "@vitejs/plugin-react";
import { linkedCheckouts } from "./linked-checkouts";
import { localRuns } from "./vite-plugin-local-runs";

// Static gallery site. No backend: `vite build` emits a static shell.
//
// The published dataset is the backend's public snapshot, a bucket the page
// reads in the browser at runtime (see `src/snapshot/reader.ts`), so the build
// bakes none of it in and a publish needs no build. The one thing the build
// takes from it is where it is: `TCAB_SNAPSHOT_URL`, the bucket's public base,
// written into the page as `import.meta.env.TCAB_SNAPSHOT_URL`.

// Load `.env.site` (if present) into `process.env` before the config reads
// `TCAB_SNAPSHOT_URL`. We avoid a dependency on the `dotenv` package: this
// parses only simple `KEY=VALUE` lines, skips blanks and `#` comments, strips
// surrounding single/double quotes, and never clobbers a variable already set
// in the environment (so a shell export still wins). The deploy pipeline sets
// the variable itself, so this file is simply absent there.
function loadEnvSite(projectRoot: string): void {
  const file = resolve(projectRoot, ".env.site");
  if (!existsSync(file)) return;
  for (const rawLine of readFileSync(file, "utf8").split("\n")) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      value.length >= 2 &&
      (value[0] === '"' || value[0] === "'") &&
      value[value.length - 1] === value[0]
    ) {
      value = value.slice(1, -1);
    }
    if (key !== "" && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}
//
// In dev only, the `localRuns` plugin serves produced-but-unpublished runs from
// a runs directory so they can be previewed (and played) before publishing:
// `TTC_RUNS_DIR`, or `runs/` beside this repository's checkout, which inside
// the superrepo is the superrepo's own `runs/`. A directory that is not there
// serves no local run. It self-disables for `vite build`, so production stays
// backend-free.
const here = dirname(fileURLToPath(import.meta.url));
loadEnvSite(here);
const runsDir = process.env.TTC_RUNS_DIR ?? resolve(here, "../../../runs");

// The bucket's public base, without a trailing slash. Unset, the gallery reads
// nothing and renders the empty states, which is what a development server with
// no `.env.site` shows; the deploy refuses to build without one.
const snapshotUrl = (process.env.TCAB_SNAPSHOT_URL ?? "")
  .trim()
  .replace(/\/+$/, "");

/**
 * The bare specifiers `@clockwyrks/ui`'s `dist/` imports, other than the
 * project's packages and React, which the development server pre-bundles.
 *
 * The server cannot pre-bundle the package itself: esbuild has no loader for
 * its `?raw` Markdown imports and no default export for its `?worker` one. Left
 * out of pre-bundling, its CommonJS-reaching dependencies would reach the
 * browser unconverted, so they are pre-bundled on its behalf. The list is the
 * one the package's README states for a Vite host; `vite build` needs none of
 * it.
 */
const UI_PREBUNDLED = [
  "@dnd-kit/core",
  "@dnd-kit/modifiers",
  "@dnd-kit/sortable",
  "@dnd-kit/utilities",
  "@observablehq/plot",
  "@react-three/drei",
  "@react-three/fiber",
  "gifenc",
  "highlight.js/lib/core",
  "highlight.js/lib/languages/bash",
  "highlight.js/lib/languages/css",
  "highlight.js/lib/languages/ini",
  "highlight.js/lib/languages/javascript",
  "highlight.js/lib/languages/json",
  "highlight.js/lib/languages/python",
  "highlight.js/lib/languages/rust",
  "highlight.js/lib/languages/scss",
  "highlight.js/lib/languages/typescript",
  "highlight.js/lib/languages/xml",
  "highlight.js/lib/languages/yaml",
  "react-icons/fa",
  "react-markdown",
  "react-router",
  "react-toastify",
  "react-virtuoso",
  "remark-gfm",
  "three",
  "three/examples/jsm/utils/SkeletonUtils.js",
  "zustand",
  "zustand/middleware",
];

/**
 * The bare specifiers the project's packages import, which the development
 * server pre-bundles under their own names and resolves to a single copy.
 *
 * Installed from the feed, the packages sit in `node_modules`, and the server
 * finds their imports among the dependencies pre-bundled above. Inside the
 * superrepo they are links to the sibling checkouts, outside `node_modules`,
 * so their imports of three.js reach the server as a dependency it has not
 * seen. It then optimizes it after the page has loaded and reloads the page,
 * and a module loaded before the reload and one loaded after it hold two
 * copies of React, which breaks every hook on the page. Named here, it is
 * optimized before the first page load. Each linked checkout also has a
 * three.js of its own, so the specifier is resolved from this repository
 * whoever imports it, which keeps the library's scenes and the runtimes'
 * meshes in one copy of three.js.
 */
const LINKED_PREBUNDLED = ["three"];

export default defineConfig({
  plugins: [react(), localRuns({ runsDir })],
  define: {
    "import.meta.env.TCAB_SNAPSHOT_URL": JSON.stringify(snapshotUrl),
  },
  resolve: { dedupe: LINKED_PREBUNDLED },
  optimizeDeps: {
    // The gallery's page alone. Left to itself the dependency scan crawls every
    // HTML file under this directory, the backdrop capture's page among them,
    // whose imports name sources the capture script aliases in a server of its
    // own; the scan fails on them and the gallery's dependencies are then
    // found one at a time after the page loads, each one reloading it.
    entries: ["index.html"],
    exclude: ["@clockwyrks/ui"],
    include: [
      ...UI_PREBUNDLED.map((specifier) => `@clockwyrks/ui > ${specifier}`),
      ...LINKED_PREBUNDLED,
    ],
  },
  server: {
    fs: {
      // The repository, which Vite allows by default, and inside the
      // superrepo each sibling checkout a project package is linked from.
      allow: [searchForWorkspaceRoot(here), ...linkedCheckouts(here)],
    },
  },
});
