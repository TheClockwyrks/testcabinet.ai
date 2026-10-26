import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { SiteApp } from "./site-app";

// A deep link such as /runs/<id> arrives at its own URL: with no `404.html` in the
// build, Cloudflare Pages answers an unmatched path with the app shell and a 200
// at the requested URL (see `public/_redirects`), so the router reads the real
// location and nothing has to be restored here before it mounts.
const rootElement = document.querySelector("#root");
if (!rootElement) {
  throw new Error("#root element not found in index.html");
}

createRoot(rootElement).render(
  <StrictMode>
    <SiteApp />
  </StrictMode>,
);
