import { existsSync, lstatSync, readdirSync, realpathSync } from "node:fs";
import path from "node:path";

/**
 * The checkouts the development server may serve files from besides this
 * repository, read by `vite.config.ts`.
 *
 * On its own the repository installs every `@clockwyrks` package from the feed
 * into its own `node_modules`, which the server serves already. Inside the
 * superrepo, its `scripts/repos/link-packages.sh` links each one to the
 * checkout that builds it, so a module the gallery loads resolves to
 * `../ui-common/...`, outside this repository, and the server refuses to serve
 * it unless it is allowed. What is allowed is the linked package's checkout,
 * the nearest directory above it holding a `package-lock.json`, because the
 * package's own dependencies are installed there.
 */

/** The scope every package of the project is published under. */
const PROJECT_SCOPE = "@clockwyrks";

/**
 * One checkout per package of the project the install linked in from a
 * sibling checkout rather than unpacked from the feed.
 *
 * @param appRoot The directory whose `node_modules` the app resolves from.
 */
export function linkedCheckouts(appRoot: string): string[] {
  const roots = new Set<string>();
  // npm hoists a workspace's packages to the workspace root, so the app's own
  // `node_modules` and each one above it up to the filesystem root are read.
  for (let directory = path.resolve(appRoot); ; ) {
    const scope = path.join(directory, "node_modules", PROJECT_SCOPE);
    for (const checkout of linkedFrom(scope)) {
      roots.add(checkout);
    }
    const parent = path.dirname(directory);
    if (parent === directory) {
      return [...roots];
    }
    directory = parent;
  }
}

/** The checkout of each package in an installed scope that is a link. */
function linkedFrom(scope: string): string[] {
  const entries = existsSync(scope) ? readdirSync(scope) : [];
  return entries
    .map((entry) => path.join(scope, entry))
    .filter((installed) => lstatSync(installed).isSymbolicLink())
    .map((installed) => lockedAncestor(realpathSync(installed)))
    .filter((checkout) => checkout !== undefined);
}

/** The nearest directory at or above `directory` holding a `package-lock.json`. */
function lockedAncestor(directory: string): string | undefined {
  for (let current = directory; ; ) {
    if (existsSync(path.join(current, "package-lock.json"))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
}
