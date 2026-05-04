import * as vscode from 'vscode';
import { spawn } from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs';

const VIEW_TYPE = 'gumJsx.preview';

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
            const svg = await this.runGum(code, cwd);
            if (token !== this.renderToken) return;
            this.panel.webview.postMessage({ type: 'svg', svg });
        } catch (err) {
            if (token !== this.renderToken) return;
            const message = err instanceof Error ? err.message : String(err);
            this.panel.webview.postMessage({ type: 'error', message });
        }
    }

    private runGum(code: string, cwd: string): Promise<string> {
        const config = vscode.workspace.getConfiguration('gumJsx');
        const bunPath = config.get<string>('bunPath') ?? 'bun';
        const theme = config.get<string>('theme') ?? 'light';

        const gumScript = this.findGumScript();
        if (!gumScript) {
            return Promise.reject(
                new Error(
                    'gum-jsx not found. Run `bun link gum-jsx` in the extension directory ' +
                    '(after `bun link` in the gum.jsx repo).',
                ),
            );
        }

        return new Promise((resolve, reject) => {
            const args = [gumScript, '-f', 'svg', '-t', theme];
            const child = spawn(bunPath, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });

            let stdout = '';
            let stderr = '';
            child.stdout.on('data', (d) => (stdout += d.toString()));
            child.stderr.on('data', (d) => (stderr += d.toString()));
            child.on('error', (err) => {
                if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
                    reject(new Error(`Could not spawn '${bunPath}'. Set "gumJsx.bunPath" in settings.`));
                } else {
                    reject(err);
                }
            });
            child.on('close', (exitCode) => {
                if (exitCode === 0) resolve(stdout);
                else reject(new Error(stderr.trim() || `gum exited with code ${exitCode}`));
            });

            child.stdin.write(code);
            child.stdin.end();
        });
    }

    private findGumScript(): string | null {
        const candidates = [
            path.join(this.context.extensionPath, 'node_modules', 'gum-jsx', 'scripts', 'gum.ts'),
        ];
        for (const folder of vscode.workspace.workspaceFolders ?? []) {
            candidates.push(
                path.join(folder.uri.fsPath, 'node_modules', 'gum-jsx', 'scripts', 'gum.ts'),
            );
        }
        for (const c of candidates) {
            if (fs.existsSync(c)) return c;
        }
        return null;
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
        GumPreviewPanel.panels.delete(this.document.uri.toString());
        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer);
            this.debounceTimer = null;
        }
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
