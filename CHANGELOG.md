# Changelog

All notable changes to Gum JSX Preview are documented here.

## 0.1.0

- Render gum.jsx previews in a bundled worker instead of spawning an external Bun command.
- Add render timeout handling for long-running gum.jsx code.
- Bundle the gum.jsx evaluator and required font assets into the extension package.
- Add Marketplace metadata and packaging exclusions.
