import { build } from 'esbuild';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

const directory = await mkdtemp(join(tmpdir(), 'otf-proxy-tests-'));
try {
    const bundle = join(directory, 'exports.cjs');
    await build({ entryPoints: ['tests/exports.ts'], outfile: bundle,
        bundle: true, platform: 'node', format: 'cjs' });
    const files = (await readdir('tests')).filter(name => name.endsWith('.test.cjs'))
        .map(name => join('tests', name));
    const child = spawn(process.execPath, ['--test', ...files], {
        env: { ...process.env, OTF_TEST_BUNDLE: bundle }, stdio: 'inherit',
    });
    const [code] = await once(child, 'exit');
    process.exitCode = code ?? 1;
} finally {
    await rm(directory, { recursive: true, force: true });
}
