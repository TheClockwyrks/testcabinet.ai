# CLAUDE.md

This file is a map, not a manual. It points to where authoritative information
lives so there is a single source of truth for each topic. When a pointer here
and a linked document disagree, the linked document wins. Correct this file
accordingly.

## Start here

- What this repository is: [`README.md`](README.md). It is the `testcabinet.ai`
  repository of The Test Cabinet, a repository of kind `site`.
- The documentation of The Test Cabinet is the source of truth, and it lives
  in the superrepo's documentation site, never here. Checked out inside the
  superrepo, its pages are under `../apps/docs/src/content/docs/`, and the
  Repositories page, `../apps/docs/src/content/docs/development/repositories.md`,
  draws the edges between the repositories and links the component pages that
  govern each.
- This repository documents its own code with its README. It never restates
  what the documentation site states; it links the page.
- Issues are filed on the superrepo's one board, `../tasks/`, never here.

## Repository layout

| Path | What it is |
| --- | --- |
| [`.claude/`](.claude/README.md) | The harness's settings, its gate hooks and the `coding` skill |
| `packages/`, `apps/` | The npm workspace's members, under the root `package.json` |
| [`ci/`](ci/README.md) | The gates, one file per gate, with the runner that executes them |
| `.copier-answers.yml` | The answers this repository was rendered with and the superrepo commit its kit was last updated from; copier maintains it, and `scripts/repos/render.py --update` in the superrepo merges a kit change in from it |
| `.test-cabinet-repo.toml` | The name, kind and description, rendered from those answers for the `dependency-edges` gate to read |
| `azure-pipelines.yml` | The pipeline: every gate a step of its own on Azure Pipelines |
| `apps/site/` | The gallery: a Vite and React host of `@clockwyrks/ui`, the workspace's one member |
| `apps/site/vite-plugin-snapshot.ts` | The build's plugin that fetches the published dataset from `TCAB_SNAPSHOT_URL` and bakes it into the bundle, with its tests |
| `apps/site/scripts/` | The screenshot helper and the backdrop capture, run from a checkout |
| `eslint.config.js`, `eslint-suppressions.json` | The `web-lint` gate's configuration and its ratchet |
| `scripts/ci/` | The pipeline's scripts, the kit's and the gallery's deploy, each with its `.test.sh` |
| `.azure/project/` | The gallery's own pipeline templates: no jobs, and the `deploy` stage |
| [`history/`](history/README.md) | How this repository's history was extracted from the monorepo |

## Rules this repository is held to

- It depends on contracts (packages); engines (packages); ui-common (packages),
  and on no other repository of the project; the `dependency-edges` gate holds
  every Cargo and npm manifest to the edges the superrepo's Repositories page
  draws.
- No built artifact is committed. Anything built is derived at build time and
  cached under the build directory.

## Working in this repo (skills)

- Writing code: read the [`coding`](.claude/skills/coding/SKILL.md) skill
  first. It defines Conventional Commits, the gates a change runs, and
  `cargo nextest` over `cargo test`.
- Writing documentation, filing an issue, or draining the queue: the
  superrepo's skills, since the documentation and the board are the
  superrepo's.

## Branches

`master` and `staging` are protected and take pull requests alone, each
approved and with the pipeline passed. `nightly` takes pushes. A push to any
of the three runs the pipeline.
A passing commit of each is pushed to the same branch of the GitHub mirror.

## Building and testing

Everything runs inside the superrepo's devcontainer, from this repository's
root, and one command runs every gate:

```sh
make gate
```

A gate is a file under [`ci/gates/`](ci/README.md) whose stem is its id, run
by the `gate` runner of the `ci` uv project:

```sh
uv run --quiet --project ci gate list         # every gate and what it checks
uv run --quiet --project ci gate run <id>...  # run some of them; --all runs all
```
