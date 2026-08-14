import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  outDir: 'dist',
  format: ['esm'],
  target: 'node20',
  platform: 'node',
  // Single self-contained file: one module load at startup, one node_modules entry
  // for a global install. See ADR-0001 ("How the tool is installed").
  bundle: true,
  noExternal: [/.*/],
  splitting: false,
  treeshake: true,
  minify: false,
  sourcemap: false,
  clean: true,
  banner: {
    // Some inquirer dependencies are still CJS and call `require('stream')`.
    // esbuild's ESM output stubs `require` with a throwing shim unless a real
    // one is in scope, so provide one.
    js: [
      '#!/usr/bin/env node',
      "import { createRequire as __awsxCreateRequire } from 'node:module';",
      'var require = __awsxCreateRequire(import.meta.url);',
    ].join('\n'),
  },
  onSuccess: 'chmod +x dist/index.js',
});
