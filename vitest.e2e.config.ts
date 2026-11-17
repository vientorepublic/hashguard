import * as swcModule from 'unplugin-swc';
import type { PluginOption } from 'vite';
import { defineConfig } from 'vitest/config';

const swc = ((swcModule as { default?: unknown }).default ??
  swcModule) as { vite: () => PluginOption };

export default defineConfig({
  plugins: [swc.vite()],
  test: {
    globals: true,
    include: ['test/**/*.e2e-spec.ts'],
    environment: 'node',
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
  },
});
