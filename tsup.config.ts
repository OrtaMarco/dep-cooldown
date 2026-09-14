import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/cli.ts', 'src/bin.ts'],
  // bin.js imports ./cli.js at runtime instead of carrying a second copy of it:
  // a bundled copy would see bin.js as its own file and run main() twice.
  external: ['./cli.js'],
  format: ['esm'],
  target: 'node20',
  platform: 'node',
  dts: true,
  clean: true,
  sourcemap: false,
  splitting: false,
  shims: false,
  banner: ({ format }) => (format === 'esm' ? {} : {}),
});
