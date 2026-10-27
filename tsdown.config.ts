import { defineConfig } from 'tsdown';

export default defineConfig([
    {
        // ESM build + one bundled index.d.ts
        entry: ['src/index.ts'],
        format: 'esm',
        platform: 'browser',
        outDir: 'dist',
        sourcemap: true,
        clean: true,
        minify: true,
        dts: { generator: 'oxc' },
        treeshake: { manualPureFunctions: ['test', 'describe'] },
    },
]);