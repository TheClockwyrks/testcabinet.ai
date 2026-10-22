import { defineConfig } from "vitest/config";

/**
 * The suite of the build-time plugins, which run in Node beside the Vite config,
 * of the development server's helpers and of the reader of the static files the
 * plugins write.
 *
 * It is a config of its own so that the tests do not load `vite.config.ts`,
 * whose plugins would read the environment and the runs directory. The gallery
 * itself has no suite here: it is the shared UI library's application, tested
 * in the ui-common repository's `packages/ui`.
 */

/**
 * The directory a gate run wants this suite's machine-readable results in.
 *
 * `ci/gates/typescript.py` runs the suite with the `CI_GATE_ARTIFACTS` its
 * runner names. Without it, which is every plain `npm test`, the suite writes
 * no report and collects no coverage. The file names are the ones the `ci`
 * project's `metrics collect` reads: `junit.xml`, and the
 * `coverage-summary.json` istanbul's `json-summary` reporter writes.
 */
const artifacts =
  process.env.CI_GATE_ARTIFACTS === ""
    ? undefined
    : process.env.CI_GATE_ARTIFACTS;

export default defineConfig({
  test: {
    include: ["*.test.ts", "src/**/*.test.ts"],
    environment: "node",
    passWithNoTests: false,
    server: {
      deps: {
        // The project's packages from the feed are unpacked into
        // `node_modules`, which Vitest hands to Node, and Node's ESM resolver
        // refuses their relative imports without an extension. Inlined, they
        // go through Vite's resolver as the bundle's do.
        inline: [/\/node_modules\/@clockwyrks\//],
      },
    },
    ...(artifacts !== undefined && {
      reporters: ["default", "junit"],
      outputFile: { junit: `${artifacts}/junit.xml` },
      coverage: {
        enabled: true,
        provider: "v8" as const,
        // Every source, so a file no test imports counts as uncovered instead
        // of dropping out of the total.
        include: ["*.ts", "src/**/*.{ts,tsx}"],
        exclude: [
          "*.test.ts",
          "src/**/*.test.{ts,tsx}",
          "*.config.ts",
          "src/vite-env.d.ts",
        ],
        reporter: ["json-summary"],
        reportsDirectory: artifacts,
        // The directory is the gate's, and the JUnit report shares it.
        clean: false,
      },
    }),
  },
});
