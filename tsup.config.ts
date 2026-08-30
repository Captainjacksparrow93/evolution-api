import { cpSync } from 'node:fs';

import { defineConfig } from 'tsup';

/**
 * Serverless builds ship a single CommonJS entrypoint and never load the ESM
 * twin or the sourcemaps, both of which are large enough to matter against a
 * platform bundle-size limit. Set VERCEL=1 (Vercel sets this automatically) or
 * BUILD_TARGET=serverless to drop them.
 */
const serverless = process.env.BUILD_TARGET === 'serverless' || process.env.VERCEL === '1';

export default defineConfig({
  entry: ['src'],
  outDir: 'dist',
  splitting: false,
  sourcemap: !serverless,
  clean: true,
  minify: true,
  format: serverless ? ['cjs'] : ['cjs', 'esm'],
  onSuccess: async () => {
    cpSync('src/utils/translations', 'dist/translations', { recursive: true });
  },
  loader: {
    '.json': 'file',
    '.yml': 'file',
  },
});
