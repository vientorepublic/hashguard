import * as swcModule from 'unplugin-swc';
import type { PluginOption } from 'vite';
import { defineConfig } from 'vitest/config';

// unplugin-swc exports the unplugin instance as its default; under vitest's CJS
// config bundling the default can surface as the module namespace, so resolve the
// instance from either shape. unplugin ships no .d.ts, so cast .vite() to a plugin.
const swc = ((swcModule as { default?: unknown }).default ??
  swcModule) as { vite: () => PluginOption };

export default defineConfig({
  plugins: [swc.vite()],
  test: {
    globals: true,
    include: ['test/**/*.spec.ts'],
    exclude: ['**/*.e2e-spec.ts'],
    environment: 'node',
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      reportsDirectory: 'coverage',
    },
  },
});
