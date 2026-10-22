import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import nodePath from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { linkedCheckouts } from "./linked-checkouts";

describe("the linked checkouts", () => {
  const made: string[] = [];

  afterEach(() => {
    for (const directory of made.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  /** A scratch tree laid out as the superrepo holds the gallery beside ui-common. */
  function superrepo(): { app: string; uiCommon: string } {
    // The real path, which is what a linked package resolves to.
    const root = realpathSync(
      mkdtempSync(nodePath.join(tmpdir(), "gallery-links-")),
    );
    made.push(root);
    const uiCommon = nodePath.join(root, "ui-common");
    const ui = nodePath.join(uiCommon, "packages/ui");
    mkdirSync(ui, { recursive: true });
    writeFileSync(nodePath.join(uiCommon, "package-lock.json"), "{}");
    const checkout = nodePath.join(root, "testcabinet.ai");
    const app = nodePath.join(checkout, "apps/site");
    const scope = nodePath.join(checkout, "node_modules/@clockwyrks");
    mkdirSync(app, { recursive: true });
    mkdirSync(scope, { recursive: true });
    writeFileSync(nodePath.join(checkout, "package-lock.json"), "{}");
    symlinkSync(ui, nodePath.join(scope, "ui"));
    // A package unpacked from the feed is the repository's own and allows
    // nothing more.
    mkdirSync(nodePath.join(scope, "backend-api"));
    return { app, uiCommon };
  }

  it("allows the checkout a linked package is built in", () => {
    const { app, uiCommon } = superrepo();

    expect(linkedCheckouts(app)).toEqual([uiCommon]);
  });

  it("allows nothing where every package came from the feed", () => {
    const root = mkdtempSync(nodePath.join(tmpdir(), "gallery-feed-"));
    made.push(root);
    mkdirSync(nodePath.join(root, "node_modules/@clockwyrks/ui"), {
      recursive: true,
    });

    expect(linkedCheckouts(root)).toEqual([]);
  });
});
