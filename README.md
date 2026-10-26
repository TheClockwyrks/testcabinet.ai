# testcabinet.ai

The public gallery, deployed to Cloudflare Pages.

This repository is one component of
[The Test Cabinet](https://github.com/TheClockwyrks/TheTestCabinet). What it is
and how it fits with the others is stated by the documentation site, which
lives in the superrepo at `apps/docs/src/content/docs/`. Its Repositories page,
`apps/docs/src/content/docs/development/repositories.md`, draws the edges
between the repositories.

## Getting started

Open the superrepo in its devcontainer, which carries every toolchain the
repositories need, and work from this repository's root.

One command runs every gate:

```sh
make gate
```

Each gate is a file under `ci/gates/` whose stem is the gate's id.
`uv run --quiet --project ci gate list` names them all, and
`azure-pipelines.yml` runs each one as a step of its own on every push, inside
the CI images the superrepo builds.

## The gallery

`apps/site` is the public gallery, the static site served at `testcabinet.ai`.
The Site page of the documentation site,
`apps/docs/src/content/docs/components/site/overview.md` in the superrepo, and
its Public gallery deployment page,
`apps/docs/src/content/docs/deployment/public-gallery.md`, state what it is and
how it is served. It is a host of `@clockwyrks/ui`, and it builds against the
published packages of contracts (`@clockwyrks/run-record`,
`@clockwyrks/backend-api`), engines and ui-common at the exact versions
`apps/site/package.json` pins. On its own the workspace installs them from the
project's feed, which needs a feed token in the user's npm configuration (see
`.npmrc`); inside the superrepo `scripts/repos/link-packages.sh` links each one
to its sibling checkout instead.

```sh
npm ci
npm run dev                 # the development server
npm run build               # the static bundle, into apps/site/dist
npm test                    # the build plugins' and the file reader's suite
npm run lint                # ESLint, with the ratchet in eslint-suppressions.json
npm run screenshot -- / tmp/screenshots/index.png
npm run capture-backdrop    # bake the backdrop's stills into ui-common
```

The build fetches the published dataset from the public bucket's read URL in
`TCAB_SNAPSHOT_URL` and bakes it into the bundle, writing each run's and each
case's files beside it; with the variable unset it builds an empty gallery. The
variable is read from the environment or from a gitignored `apps/site/.env.site`
(`apps/site/.env.site.example` is its template), the environment winning.

In the development server only, the gallery also lists the runs produced on
this machine but not published, read from the directory `TTC_RUNS_DIR` names,
or from `runs/` beside this repository's checkout, which inside the superrepo
is the superrepo's own `runs/`. A directory that is not there lists none.

`npm run screenshot` captures a route of the gallery in Chromium through
Playwright (the engines the superrepo's devcontainer carries). `npm run
capture-backdrop` renders the backdrop's WebGL scene from the sources of a
ui-common checkout and writes its stills there: the checkout `UI_COMMON_DIR`
names, or `ui-common` beside this repository's checkout, with its dependencies
installed. Without one it fails, naming what it looked for.

One gate beside the kit's is this repository's own: `web-lint`, ESLint over
the gallery's sources, its build configuration and its tools.

## The Workers

Two Workers stand beside the gallery, each an npm workspace member with its
own `wrangler.toml`. The Serving page of the documentation site,
`apps/docs/src/content/docs/components/site/serving.md`, states what each
answers, and the Public gallery deployment page its bindings, variables and
routes.

- `apps/preview-tags` is routed on the gallery's run routes. It writes a
  published run's title, description and image into the Pages shell's head,
  and answers an unknown run id with the shell and a 404.
- `apps/share-links` is `tcab.ai`. It redirects `/r/<code>` to a run's
  verdict page and `/p/<code>` to its play page, reading the run id from the
  bucket's `codes/<code>`.

Each imports nothing outside its own sources, so `wrangler` bundles it
without an install. Its suite runs its handler in Node with the bucket
binding stubbed, as `npm test` runs every member's:

```sh
npm test -w apps/preview-tags
npx wrangler@4.40.3 dev --config apps/share-links/wrangler.toml
```

## Deploying

The pipeline's `deploy` stage (`.azure/project/stages.yml`) runs
`scripts/ci/deploy-site.sh` on every `master` and `staging` build that passed
the gates: `master` deploys to the Cloudflare Pages project
`the-test-cabinet`, served at `testcabinet.ai`, and `staging` to
`the-test-cabinet-staging`, served at `staging.testcabinet.ai`. Each build is
handed its environment's `TCAB_SNAPSHOT_URL`, from the pipeline definition's
`TCAB_SNAPSHOT_URL_MASTER` and `TCAB_SNAPSHOT_URL_STAGING`, and the script
refuses to build without one, since an empty gallery would replace the live
one. The superrepo's Releasing page,
`apps/docs/src/content/docs/development/releasing.md`, section "Gallery
(Cloudflare Pages and Workers, one-time)", says how the projects and the
pipeline's variables are set up.

The same stage runs `scripts/ci/deploy-workers.sh`, which deploys both
Workers with `wrangler deploy`: `master` their `production` environment and
`staging` their `staging` one.

One part of the gallery the documentation describes is not here yet. The
shell still bakes the dataset into the bundle at build time, where the
documentation has it read the bucket's index in the browser, so a published
run appears on the site with the next deploy rather than without one.
