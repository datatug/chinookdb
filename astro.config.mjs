import { defineConfig } from 'astro/config';

export default defineConfig({
  site: 'https://chinookdb.com',
  output: 'static',
  build: { format: 'directory' },
  vite: {
    build: { assetsInlineLimit: 0 },
  },
});
