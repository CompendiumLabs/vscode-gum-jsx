# Gum JSX Viewer

Live viewer for `.jsx` files written with [gum.jsx](https://github.com/CompendiumLabs/gum.jsx).

## Features

- Opens a rendered SVG  beside the active editor.
- Updates the output as the document changes.
- Supports light and dark gum.jsx themes.
- Runs gum.jsx evaluation in an isolated worker with a configurable timeout.
- Supports `loadTable(...)` and `LoadImage` relative to the source file.

## Usage

Open a gum.jsx `.jsx` file, then run one of these commands:

- `Gum JSX: Open Viewer`
- `Gum JSX: Open Viewer to the Side`

The default keybinding for viewing to the side is:

- Windows/Linux: `Ctrl+K V`
- macOS: `Cmd+K V`

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `gumJsx.theme` | `light` | Theme passed to gum.jsx when rendering. |
| `gumJsx.refreshDelayMs` | `250` | Debounce delay before re-rendering after document changes. |
| `gumJsx.renderTimeoutMs` | `5000` | Maximum render time before the worker is stopped. |

## Workspace Trust

This extension evaluates the active gum.jsx document. For that reason, it only runs in trusted workspaces.

## Requirements

- VS Code 1.100.0 or newer.
- No separate Bun or gum.jsx command-line install is required at runtime.

## Known Limitations

- The viewer renders SVG only.
- Long-running or infinite gum.jsx code is stopped by the render timeout.
