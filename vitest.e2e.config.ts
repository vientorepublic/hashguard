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
    // The PoW solve in these specs is synchronous and CPU-bound, so on a
    // loaded CI runner a single issue+solve+verify round can exceed vitest's
    // 5s default. Give the E2E suite headroom; a real hang still surfaces.
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
});
