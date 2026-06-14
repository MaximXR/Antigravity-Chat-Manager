# Changelog

## 1.0.2
- **Adaptive Layout**: Re-engineered dialogue card buttons to support dynamic layout. Wide screens display all action buttons in a single horizontal row, while narrow sidebars stack them into a 3-row grid (`[Edit Note]` on top, `[Search] [Folder]` in the middle, `[Launch/Restore] [Delete]` at the bottom).
- **Index Status Badge**: Relocated the index status badge (`В ИНДЕКСЕ` / `ВНЕ ИНДЕКСА`) to the top-right corner of the card, directly above the action buttons.
- **Native Confirmation Dialogs**: Replaced Webview-based confirmation alerts with native VS Code modal dialogs (`vscode.window.showWarningMessage` with `{ modal: true }`) for bulk actions.
- **WS Package Bug Fix**: Resolved launching crash (`Cannot find module 'ws'`) by packaging the `ws` runtime dependency inside the VSIX package.
- **Build Improvements**: Updated `build.bat` to preserve old VSIX builds in the `dist` directory instead of deleting them.
- **README Restructuring**: Relocated technical notes on file locking and workspace locations in the README.

## 1.0.1
- Added localization support for Russian and other languages.
- Stability improvements.

## 1.0.0
- Initial release of Antigravity Chat Manager.
