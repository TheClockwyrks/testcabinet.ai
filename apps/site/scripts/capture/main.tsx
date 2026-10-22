import { createRoot } from "react-dom/client";
// Reach straight into the ui package source so the capture renders the *real*
// scene (and reads the *real* theme tokens) without pulling in the whole gallery
// app or its chrome. `@ui-sources` is the alias capture-backdrop.mjs gives the
// sources of a ui-common checkout; Vite compiles them on the fly and nothing
// here ships.
import SynthwaveScene from "@ui-sources/app/components/backdrop/SynthwaveScene";
import "@ui-sources/app/styles/theme.scss";

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("#root element not found in index.html");
}

createRoot(rootElement).render(<SynthwaveScene />);
