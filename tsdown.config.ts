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
        dts: { generator: 'oxc' },   // isolatedDeclarations: no TypeScript JS API involved
    },
    {
        // <script>-tag build, starts itself
        entry: { 'x-attributes': 'src/iife.ts' },
        format: 'iife',
        platform: 'browser',
        outDir: 'dist',
        minify: true,
        clean: false,
        dts: false,
    },
]);