import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parentPort, workerData } from 'node:worker_threads';

import { evaluateGum } from 'gum-jsx/eval';

type ThemeName = 'light' | 'dark';

type WorkerData = {
    code: string;
    cwd: string;
    theme: ThemeName;
};

type LoadFileData = string | Uint8Array;

function loadFileFrom(cwd: string) {
    return (filePath: string, encoding = 'utf8'): LoadFileData => {
        const resolved = path.resolve(cwd, filePath);
        if (encoding === 'bytes') return readFileSync(resolved);
        return readFileSync(resolved, encoding as BufferEncoding);
    };
}

function serializeError(err: unknown) {
    if (err instanceof Error) {
        return { message: err.message, stack: err.stack };
    }
    return { message: String(err) };
}

try {
    const { code, cwd, theme } = workerData as WorkerData;
    const elem = evaluateGum(code, {
        theme,
        loadFile: loadFileFrom(cwd),
    });
    parentPort?.postMessage({ type: 'svg', svg: elem.svg() });
} catch (err) {
    parentPort?.postMessage({ type: 'error', ...serializeError(err) });
}
