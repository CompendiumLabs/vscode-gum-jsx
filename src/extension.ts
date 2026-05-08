import * as vscode from 'vscode';
import { Worker } from 'node:worker_threads';
import * as path from 'node:path';

const VIEW_TYPE = 'gumJsx.preview';
const WORKER_URL = new URL('./render-worker.js', import.meta.url);

type RenderResult = {
    promise: Promise<string>;
    cancel: () => void;
};

type RenderWorkerMessage =
    | { type: 'svg'; svg: string }
    | { type: 'error'; message: string; stack?: string };

export function activate(context: vscode.ExtensionContext) {
    context.subscriptions.push(
        vscode.commands.registerCommand('gumJsx.openPreview', () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                vscode.window.showInformationMessage('Open a gum.jsx file first.');
                return;
            }
            GumPreviewPanel.createOrShow(context, editor.document, vscode.ViewColumn.Active);
        }),
        vscode.commands.registerCommand('gumJsx.openPreviewToSide', () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                vscode.window.showInformationMessage('Open a gum.jsx file first.');
                return;
            }
            GumPreviewPanel.createOrShow(context, editor.document, vscode.ViewColumn.Beside);
        }),
    );

    if (vscode.window.registerWebviewPanelSerializer) {
        vscode.window.registerWebviewPanelSerializer(VIEW_TYPE, {
            async deserializeWebviewPanel(webviewPanel, state: unknown) {
                const sourceUri = (state as { sourceUri?: string } | undefined)?.sourceUri;
                webviewPanel.webview.options = getWebviewOptions(context.extensionUri);
                if (sourceUri) {
                    try {
                        const doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(sourceUri));
                        GumPreviewPanel.revive(context, webviewPanel, doc);
                        return;
                    } catch {
                        // fall through and dispose
                    }
                }
                webviewPanel.dispose();
            },
        });
    }
}

export function deactivate() {
    GumPreviewPanel.disposeAll();
}

function getWebviewOptions(extensionUri: vscode.Uri): vscode.WebviewOptions {
    return {
        enableScripts: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')],
    };
}

class GumPreviewPanel {
    private static panels = new Map<string, GumPreviewPanel>();

    private readonly panel: vscode.WebviewPanel;
    private readonly context: vscode.ExtensionContext;
    private document: vscode.TextDocument;
    private disposables: vscode.Disposable[] = [];
    private renderToken = 0;
    private debounceTimer: NodeJS.Timeout | null = null;
    private activeRender: RenderResult | null = null;
    private disposed = false;

    public static createOrShow(
        context: vscode.ExtensionContext,
        document: vscode.TextDocument,
        column: vscode.ViewColumn,
    ) {
        const key = document.uri.toString();
        const existing = GumPreviewPanel.panels.get(key);
        if (existing) {
            existing.panel.reveal(column, true);
            existing.scheduleRender(true);
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            VIEW_TYPE,
            previewTitle(document),
            { viewColumn: column, preserveFocus: true },
            getWebviewOptions(context.extensionUri),
        );

        const view = new GumPreviewPanel(context, panel, document);
        GumPreviewPanel.panels.set(key, view);
    }

    public static revive(
        context: vscode.ExtensionContext,
        panel: vscode.WebviewPanel,
        document: vscode.TextDocument,
    ) {
        const view = new GumPreviewPanel(context, panel, document);
        GumPreviewPanel.panels.set(document.uri.toString(), view);
    }

    public static disposeAll() {
        for (const panel of GumPreviewPanel.panels.values()) {
            panel.dispose();
        }
        GumPreviewPanel.panels.clear();
    }

    private constructor(
        context: vscode.ExtensionContext,
        panel: vscode.WebviewPanel,
        document: vscode.TextDocument,
    ) {
        this.context = context;
        this.panel = panel;
        this.document = document;

        this.panel.title = previewTitle(document);
        this.panel.webview.html = this.shellHtml();
        this.scheduleRender(true);

        this.panel.onDidDispose(() => this.dispose(), null, this.disposables);

        this.panel.onDidChangeViewState(
            () => {
                if (this.panel.visible) this.scheduleRender(false);
            },
            null,
            this.disposables,
        );

        vscode.workspace.onDidChangeTextDocument(
            (e) => {
                if (e.document.uri.toString() === this.document.uri.toString()) {
                    this.scheduleRender(false);
                }
            },
            null,
            this.disposables,
        );

        vscode.workspace.onDidSaveTextDocument(
            (doc) => {
                if (doc.uri.toString() === this.document.uri.toString()) {
                    this.scheduleRender(true);
                }
            },
            null,
            this.disposables,
        );
    }

    private scheduleRender(immediate: boolean) {
        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer);
            this.debounceTimer = null;
        }
        const delay = immediate
            ? 0
            : (vscode.workspace.getConfiguration('gumJsx').get<number>('refreshDelayMs') ?? 250);
        this.debounceTimer = setTimeout(() => {
            this.debounceTimer = null;
            void this.render();
        }, delay);
    }

    private async render() {
        const token = ++this.renderToken;
        const code = this.document.getText();
        const cwd = path.dirname(this.document.uri.fsPath);

        try {
            this.activeRender?.cancel();
            const render = this.createRender(code, cwd);
            this.activeRender = render;
            const svg = await render.promise;
            if (this.disposed || token !== this.renderToken) return;
            this.panel.webview.postMessage({ type: 'svg', svg });
        } catch (err) {
            if (this.disposed || token !== this.renderToken) return;
            const message = err instanceof Error ? err.message : String(err);
            this.panel.webview.postMessage({ type: 'error', message });
        } finally {
            if (token === this.renderToken) this.activeRender = null;
        }
    }

    private createRender(code: string, cwd: string): RenderResult {
        const config = vscode.workspace.getConfiguration('gumJsx');
        const theme = config.get<string>('theme') ?? 'light';
        const timeoutMs = Math.max(config.get<number>('renderTimeoutMs') ?? 5000, 250);

        const worker = new Worker(WORKER_URL, {
            workerData: { code, cwd, theme },
            resourceLimits: {
                maxOldGenerationSizeMb: 256,
            },
        });

        let settled = false;
        let timer: NodeJS.Timeout | null = null;
        let rejectPromise: ((err: Error) => void) | null = null;

        const cleanup = () => {
            if (timer) {
                clearTimeout(timer);
                timer = null;
            }
        };

        const promise = new Promise<string>((resolve, reject) => {
            rejectPromise = reject;

            timer = setTimeout(() => {
                if (settled) return;
                settled = true;
                cleanup();
                void worker.terminate();
                reject(new Error(`gum.jsx render timed out after ${timeoutMs}ms`));
            }, timeoutMs);

            worker.once('message', (msg: RenderWorkerMessage) => {
                if (settled) return;
                settled = true;
                cleanup();
                if (msg.type === 'svg') {
                    resolve(msg.svg);
                } else {
                    const err = new Error(msg.message);
                    if (msg.stack) err.stack = msg.stack;
                    reject(err);
                }
            });

            worker.once('error', (err) => {
                if (settled) return;
                settled = true;
                cleanup();
                reject(err);
            });

            worker.once('exit', (code) => {
                if (settled) return;
                settled = true;
                cleanup();
                reject(new Error(`gum.jsx render worker exited with code ${code}`));
            });
        });

        return {
            promise,
            cancel: () => {
                if (settled) return;
                settled = true;
                cleanup();
                void worker.terminate();
                rejectPromise?.(new Error('gum.jsx render canceled'));
            },
        };
    }

    private shellHtml(): string {
        const webview = this.panel.webview;
        const nonce = makeNonce();
        const scriptUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this.context.extensionUri, 'media', 'preview.js'),
        );
        const styleUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this.context.extensionUri, 'media', 'preview.css'),
        );
        const csp = [
            `default-src 'none'`,
            `style-src ${webview.cspSource} 'unsafe-inline'`,
            `img-src ${webview.cspSource} data: https:`,
            `font-src ${webview.cspSource} data:`,
            `script-src 'nonce-${nonce}'`,
        ].join('; ');

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="${csp}">
    <link href="${styleUri}" rel="stylesheet">
    <title>Gum Preview</title>
</head>
<body>
    <div id="status" class="status">Rendering…</div>
    <div id="error" class="error" hidden></div>
    <div id="stage" class="stage"></div>
    <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
    }

    public dispose() {
        this.disposed = true;
        GumPreviewPanel.panels.delete(this.document.uri.toString());
        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer);
            this.debounceTimer = null;
        }
        this.activeRender?.cancel();
        this.activeRender = null;
        this.panel.dispose();
        while (this.disposables.length) {
            const d = this.disposables.pop();
            d?.dispose();
        }
    }
}

function previewTitle(document: vscode.TextDocument): string {
    return `Preview: ${path.basename(document.uri.fsPath)}`;
}

function makeNonce(): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let out = '';
    for (let i = 0; i < 32; i++) out += chars.charAt(Math.floor(Math.random() * chars.length));
    return out;
}
