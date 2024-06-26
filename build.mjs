import * as esbuild from 'esbuild';

await esbuild.build({
    entryPoints: ['src/server.ts'],
    bundle: true,
    outfile: 'dist/index.cjs',
    platform: 'node',
    format: 'cjs',
});

await esbuild.build({
    entryPoints: ['src/authenticationPlugins/*'],
    bundle: true,
    outdir: 'dist/authenticationPlugins',
    platform: 'node',
    format: 'cjs',
});