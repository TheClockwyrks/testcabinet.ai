# history

The record of how this repository's history was extracted from the monorepo,
[The Test Cabinet](https://github.com/TheClockwyrks/TheTestCabinet), where the
gallery lived as `apps/site/` until the extraction. Nothing builds or tests
against these files; they are kept so the provenance outlives the scratch clone
the extraction ran in.

## The extraction

The history below the scaffold commit is the monorepo's `issue/repos-18` branch
at `a3a738a35b3af5ec79f35e5e0b222fd9e4abee9c` (its `nightly` at `a1c20adb7` and
the one commit that taught the repository kit to render this repository with
its deploy stage and lint gate), filtered to the paths in
[`paths.txt`](paths.txt) by git filter-repo 2.47.0:

```sh
git clone -q --no-local --no-checkout --single-branch --branch issue/repos-18 \
  --no-tags <the-test-cabinet> x
cd x
uvx --from git-filter-repo==2.47.0 git-filter-repo --force \
  --paths-from-file ../paths.txt --prune-empty always --preserve-commit-hashes
```

Of the 7,184 commits reachable from that commit, 220 touched a path in the list
and were kept (45 of them merges); the rest were pruned. No tag was carried.
The tip tree of `apps/site/` hashes the same as the monorepo's at that commit
(`81261e2b994c03df67c3c88234ad5a55b0fe9800`).

The app is kept where it was in the monorepo, at `apps/site/`, so the filter
needed no rename and the npm workspace the kit renders (`apps/*`) holds it as
it is. Four files at the monorepo's root that served the gallery alone came
with it, each at the path it had there:

- `tsconfig.base.json`, the compiler options the app's `tsconfig.json`
  extends;
- `.env.site.example`, the template of the gallery's environment file, moved
  beside the app (`apps/site/.env.site.example`) in the commit that makes the
  repository build on its own, since the build reads `.env.site` from there;
- `eslint.config.js` and `eslint-suppressions.json`, the lint configuration
  and its ratchet, which by the extraction linted the gallery alone. Their
  earlier history, when they covered other parts of the monorepo as well, is
  carried as it was.

## The files

- [`paths.txt`](paths.txt) is the list handed to `--paths-from-file`
  (sha256 `0b212445057a36ce406439a65d3b0cfe94c2a4b43cd55e11963bb2a41ae6410c`).
  It is generated, not hand-written: the moved directory (`apps/site/`), the
  four root files, and every path a tracked one of them had before a rename or
  copy, collected by `git log --follow -M -C --name-status` over each. Every
  earlier path is inside `apps/site/` (`src/staticFiles.ts` and its test, the
  names of `src/static-files.ts` and its test before a rename), so the
  directory entry already covers them and no other path is listed.
- [`commit-map`](commit-map) is filter-repo's map from each monorepo commit
  (left) to the commit it became here (right), all zeros for a pruned one.
  `--preserve-commit-hashes` left the commit ids quoted in the messages as they
  were, so an id in a message below the scaffold commit names a monorepo
  commit, and this map translates it.

## The live-path review

`paths.txt` intersected with the monorepo's tree at the extraction commit
names, outside `apps/site/`, exactly the four root files above, each moved
here rather than copied. No file of this repository began as a copy of a file
the monorepo kept, so the scaffold commit deletes nothing.
