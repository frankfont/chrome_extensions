# Medium Reader Stats Info

A Chrome extension for Medium authors that captures and compares story performance snapshots from the Medium stats page.

Target page: https://medium.com/me/stats

## What It Tracks

For each story snapshot:

- Story Name
- Presentations Count
- Views Count
- Reads Count
- Earnings Amount
- Snapshot Timestamp
- Medium URL
- Story ID

This extension stores values as text and numbers. It does not take screenshots.

## Snapshot Behavior

- Automatic snapshot: once per day on the first visit to `https://medium.com/me/stats`.
- Manual snapshot: user can trigger a snapshot from the extension popup.
- Multiple manual snapshots per day are allowed.
- Snapshot key: `Story Name + timestamp`.

## Panel Access

The extension panel is available from the Chrome toolbar and from keyboard shortcuts.

Open methods:

- Click the extension icon in the Chrome toolbar to open the panel.
- Use a keyboard shortcut to open the panel when viewing `https://medium.com/me/stats`.

## Keyboard Shortcuts

Default shortcuts (Mac):

- `Option+Shift+S`: Open the extension panel and run a manual snapshot.
- `Option+Shift+0`: Open the extension panel and focus comparison controls.

Shortcut setup:

- Open `chrome://extensions/shortcuts` to view or customize shortcuts.
- If a shortcut conflicts with another extension, reassign it in Chrome shortcuts settings.

## Parsing Behavior

- Data source is the Medium stats page DOM.
- The extension auto-scrolls the page to load more rows.
- Scroll stop rule: stop when no new rows appear after `N` scrolls, where `N = 3`.
- Number/currency format assumption: American English only.

## Comparisons and Diff Rules

The UI supports:

- Latest vs previous baseline
- Any two snapshots selected by user
- Trend over time

Default baseline rule:

- Compare latest current snapshot against the last available snapshot from the most recent prior day that has a snapshot.

Diff display includes:

- Absolute delta
- Percentage delta
- Color coding (positive/negative)
- Sortable columns

Story presence changes:

- If a story exists in only one of the two snapshots, show it as `new` or `removed`.

## Data Management

- Storage uses `chrome.storage` and persists across browser sessions.
- User can manually delete data by story and/or specific timestamp.
- No export/import feature is included.

## Scope and Constraints

- Chrome Extension `manifest_version: 3`
- Single Medium account/profile per browser context
- No multi-account partitioning

## Error Handling

The extension should show clear user-facing errors for cases such as:

- Not logged into Medium
- Empty or unavailable stats page
- Parsing/selectors failure
- Incomplete row loading

## Privacy

- Snapshot data remains local in browser extension storage.
- The extension does not transmit snapshot data to external services.

## Quick Start (Unpacked Extension)

1. Open Chrome and go to `chrome://extensions`.
2. Enable Developer mode.
3. Click Load unpacked.
4. Select the `medium-reader-stats-info` folder.
5. Visit `https://medium.com/me/stats` while logged into Medium.
6. Open the extension panel from the toolbar icon or keyboard shortcut to create manual snapshots and run comparisons.