import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/cli.ts'],
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
