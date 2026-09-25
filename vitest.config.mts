import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        bindings: {
          INSTALLER_PASSWORD: 'test-installer-password',
          // Served by the fakes in test/fakes.ts — nothing reaches the network.
          RELEASES_INDEX_URL: 'https://releases.test/releases.json',
          CLOUDFLARE_API_BASE: 'https://cf.test/client/v4',
        },
      },
    }),
  ],
});
