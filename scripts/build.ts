import path from 'node:path';
import { watch } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';

const root = path.resolve(import.meta.dir, '..');
const outdir = path.join(root, 'out');
const watchMode = process.argv.includes('--watch');

const fontAssetPlugin = {
    name: 'node-font-assets',
    setup(build: any) {
        build.onLoad({ filter: /\.(ttf|otf|woff2?)$/ }, async (args: { path: string }) => {
            const filename = path.basename(args.path);
            await Bun.write(path.join(outdir, filename), Bun.file(args.path));
            return {
                loader: 'js',
                contents:
                    'import { fileURLToPath } from "node:url";\n' +
                    `export default fileURLToPath(new URL("./${filename}", import.meta.url));\n`,
            };
        });
    },
};

async function buildExtension() {
    await rm(outdir, { recursive: true, force: true });
    await mkdir(outdir, { recursive: true });

    const result = await Bun.build({
        entrypoints: [
            path.join(root, 'src', 'extension.ts'),
            path.join(root, 'src', 'render-worker.ts'),
        ],
        outdir,
        target: 'node',
        external: ['vscode'],
        format: 'esm',
        naming: {
            entry: '[dir]/[name].js',
        },
        plugins: [fontAssetPlugin],
    });

    for (const log of result.logs) {
        console.error(log);
    }

    if (!result.success) {
        process.exitCode = 1;
        return false;
    }

    console.log(`Built extension and render worker to ${path.relative(root, outdir)}`);
    return true;
}

let building = false;
let queued = false;

async function scheduleBuild() {
    if (building) {
        queued = true;
        return;
    }

    building = true;
    do {
        queued = false;
        await buildExtension();
    } while (queued);
    building = false;
}

await scheduleBuild();

if (watchMode) {
    console.log('Watching src for changes...');
    watch(path.join(root, 'src'), { recursive: true }, () => {
        void scheduleBuild();
    });
    process.stdin.resume();
}
