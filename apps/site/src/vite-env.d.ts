/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * The public base of the bucket the published dataset is read from, such as
   * `https://snapshot.testcabinet.ai`, written in by `vite.config.ts` from the
   * environment's `TCAB_SNAPSHOT_URL`. Empty when none was set, and the gallery
   * then renders the empty states.
   */
  readonly TCAB_SNAPSHOT_URL: string;
}
