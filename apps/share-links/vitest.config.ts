import { defineConfig } from "vitest/config";

/**
 * The Worker's suite, run in Node against the Worker's own handler with its
 * bindings stubbed.
 *
 * It writes no report into `CI_GATE_ARTIFACTS`: the `typescript` gate keeps one
 * JUnit report and one coverage summary per run, and the gallery's suite, run
 * after this one, writes them. A failure here still fails the gate.
 */
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
    passWithNoTests: false,
  },
});
