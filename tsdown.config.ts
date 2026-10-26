import { defineConfig } from 'tsdown';

export default defineConfig([
    {
        // ESM build + one bundled index.d.ts
        entry: ['src/index.ts'],
        format: 'esm',
        platform: 'browser',
        outDir: 'dist',
        sourcemap: true,
        clean: false,
        dts: { generator: 'oxc' },
        treeshake: { manualPureFunctions: ['test', 'describe'] },
    },
    {
        // <script>-tag build, starts itself
        entry: { 'x-attributes': './src/iife.ts' },
        format: 'iife',
        platform: 'browser',
        outDir: 'dist',
        minify: true,
        treeshake: { manualPureFunctions: ['test', 'describe'] },
        clean: false,
        dts: false,
    },
]);