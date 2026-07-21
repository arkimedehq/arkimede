/**
 * Vitest configuration for the backend tests.
 *
 * Uses SWC (the same toolchain as `nest build`) to transform TypeScript
 * decorators + emit the metadata: importing an `@Injectable` service or a
 * TypeORM entity in a test does not break.
 *
 * Conventions:
 *   - tests live in `test/**\/*.spec.ts`;
 *   - tests that encode a SECURITY invariant are named
 *     `*.security.spec.ts` → `npm run test:security` runs them as a
 *     cross-cutting suite ("the attack must fail"), filtering by file name.
 */
import { defineConfig } from 'vitest/config';
import swc from 'unplugin-swc';

export default defineConfig({
  // The TS transformation is done by SWC (below): disable the default one (Oxc)
  // so that decorators + metadata are handled consistently with `nest build`.
  oxc: false,
  plugins: [
    swc.vite({
      module: { type: 'es6' },
      jsc: {
        parser: { syntax: 'typescript', decorators: true },
        transform: { legacyDecorator: true, decoratorMetadata: true },
        target: 'es2021',
        keepClassNames: true,
      },
    }),
  ],
  test: {
    environment: 'node',
    include: ['test/**/*.spec.ts'],
    setupFiles: ['test/setup.ts'],
    // Some SDKs (e.g. voyageai) publish ESM with directory imports that Node
    // does not resolve but Vite does: inlining them routes them through Vite's resolver.
    server: { deps: { inline: [/voyageai/] } },
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.entity.ts', 'src/**/*.module.ts', 'src/**/*.dto.ts'],
    },
  },
});
