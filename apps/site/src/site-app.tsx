import { GalleryApp, GalleryDataProvider } from "@clockwyrks/ui/app";
import { useEffect, useState } from "react";
import { RouterProvider, createBrowserRouter } from "react-router";

import { createSnapshotReader } from "./snapshot/reader";
import type { SnapshotDataset } from "./snapshot/reader";
import { useStaticGallery } from "./staticGallery";

// A data router, the same as the console's: the gallery declares its own routes beneath
// the one catch-all route here.
const router = createBrowserRouter([{ path: "*", element: <GalleryApp /> }]);

// The public bucket the published dataset is read from, the one reader for the
// page. The build writes its base in from `TCAB_SNAPSHOT_URL`; without one the
// gallery reads nothing and renders the empty states.
const reader = createSnapshotReader(import.meta.env.TCAB_SNAPSHOT_URL);

// The static gallery: the shared app (from @clockwyrks/ui) rendered with the
// published snapshot as its data source. Its global styles come in as a side
// effect of importing the shared app entry.
function Gallery({ dataset }: { dataset: SnapshotDataset }) {
  const data = useStaticGallery(reader, dataset);
  return (
    <GalleryDataProvider value={data}>
      <RouterProvider router={router} />
    </GalleryDataProvider>
  );
}

/** The dataset's load: still reading, read, or the reason it could not be. */
type DatasetLoad =
  | { status: "loading" }
  | { status: "ready"; dataset: SnapshotDataset }
  | { status: "error"; error: Error };

const notice = { marginTop: "40vh", textAlign: "center" } as const;

// The routes mount once the dataset is read, because which sections the gallery
// has follows from it: a gallery whose snapshot carries a gg corpus mounts the
// Discover page, and a deep link to it must not meet the not-found page first.
// Every page reads the dataset, so one that could not be read is reported here,
// once, rather than mounting pages that would show an empty gallery in its place.
export function SiteApp() {
  const [load, setLoad] = useState<DatasetLoad>({ status: "loading" });
  useEffect(() => {
    const mounted = { current: true };
    void (async () => {
      let next: DatasetLoad;
      try {
        next = { status: "ready", dataset: await reader.dataset() };
      } catch (error) {
        console.error(
          "the gallery could not read the published snapshot",
          error,
        );
        next = {
          status: "error",
          error: error instanceof Error ? error : new Error(String(error)),
        };
      }
      if (mounted.current) setLoad(next);
    })();
    return () => {
      mounted.current = false;
    };
  }, []);
  switch (load.status) {
    case "loading": {
      return (
        <p role="status" style={{ ...notice, opacity: 0.7 }}>
          Loading the gallery…
        </p>
      );
    }
    case "error": {
      return (
        <div role="alert" style={notice}>
          <p>The gallery could not be loaded: {load.error.message}</p>
          <button
            type="button"
            onClick={() => {
              location.reload();
            }}
          >
            Reload
          </button>
        </div>
      );
    }
    case "ready": {
      return <Gallery dataset={load.dataset} />;
    }
  }
}
