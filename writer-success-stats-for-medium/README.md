# Writer Success Stats for Medium

A Chrome extension for Medium authors that captures and compares story performance snapshots from the Medium stats page.

Target page: https://medium.com/me/stats

Created by ![author profile picture](author.png) Frank Font 2026

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
	- If at least one snapshot exists within the last 5 days, auto capture prefers a delta snapshot.
	- Otherwise, auto capture creates a full snapshot.
- Manual snapshot: user triggers one `Capture Snapshot` button.
	- Smart mode chooses delta when a recent snapshot exists (within 5 days).
	- Smart mode chooses full when no prior snapshot exists or no recent snapshot exists.
	- `Shift+Click` on `Capture Snapshot` forces a full snapshot.
	- `Option+Click` on `Capture Snapshot` forces a delta snapshot.
- Multiple manual snapshots per day are allowed.
- Hybrid storage model:
	- First snapshot of each day is stored as a full snapshot.
	- Later snapshots on the same day are stored sparsely (only changed story records).
	- Compare, daily summary, and trend views materialize sparse snapshots back into full point-in-time states before computing diffs.
- Snapshot key: `Story Name + timestamp`.

## Panel Access

The extension panel is available from the Chrome toolbar and from keyboard shortcuts.

Open methods:

- Click the extension icon in the Chrome toolbar to open the panel.
- Use a keyboard shortcut to open the panel when viewing `https://medium.com/me/stats`.

## Daily Changes Summary

The panel includes an easy-access **Daily Changes Summary** near the top.

- It automatically compares the latest snapshot against a daily baseline.
- If exactly one snapshot exists, a prominent note explains that daily stats will be available the next day you open the panel.
- Daily baseline rule:
	- Use the **earliest snapshot** from the **most recent prior day**.
	- If no prior day exists, use the **first snapshot from the current day**.
- Metric filter checkboxes are available for: Presentations, Views, Reads, Earnings.
- All metric filters are enabled by default.
- If a metric checkbox is unchecked, that metric no longer qualifies a story for inclusion in the summary.
- It shows only stories with actual numeric tracked changes.
- It highlights Presentations, Views, Reads, and Earnings deltas for quick scanning.
- Positive deltas are always prefixed with `+`.

## Compare Dates Defaults

The **Compare Any Two** area supports manual picker-based comparisons and a default quick compare.

- Compare results auto-refresh when Base/Target day or snapshot selections change.

- Metric filter checkboxes are available for: Presentations, Views, Reads, Earnings.
- All compare metric filters are enabled by default.
- If a metric checkbox is unchecked, that metric no longer qualifies a story for inclusion in compare results.

- `Run Default Comparison` logic:
	- Base snapshot (A): **earliest available snapshot from the earliest date**.
	- Target snapshot (B): **latest available snapshot from the latest date**.

- Hidden advanced controls:
	- Hold `Shift` while clicking `Run Default Comparison` to reveal `Audit Snapshot Pair`, `Export Audit JSON`, `Export A/B JSON`, and the `Delete Data` section.
	- Click `Run Default Comparison` without `Shift` to hide those advanced controls again.

This gives a full-range comparison across all available saved history.

## Keyboard Shortcuts

Default shortcuts (Mac):

- `Option+Shift+S`: Open the extension panel and run a manual snapshot.
- `Option+Shift+0`: Open the extension panel and focus comparison controls.
- `Option+Shift+D`: Open the extension panel and jump to Daily Changes Summary.

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

- Daily baseline comparison
- Any two snapshots selected by user
- Trend over time

Comparison outputs include:

- Baseline and target values (`A` and `B`) for Views, Reads, Earnings
- Delta columns with signed values (`+` for positive)
- Percent delta columns with signed values
- Color coding for positive/negative changes

Story presence rules:

- Present in target only: `new`
- Present in base only: `removed`
- Present in both: `existing`

## Trend Over Time Logic

- Rows are sorted most recent first.
- For **today**, multiple snapshots may appear.
- For any **earlier day**, only that day's most recent snapshot is shown.
- `Show Trend` also opens an SVG line chart overlay for the selected story:
	- Views line: orange
	- Reads line: blue
	- Earnings line: green
	- X-axis is days and lines connect point-to-point directly (snapshot gaps are not expanded with empty points).
- The chart overlay spans the panel area between the panel header and the Trend section.
- Close behavior:
	- Click the chart `Close` button, or
	- Click anywhere outside the chart overlay.
- If total stories exceed the trend picker max group size (default `100`), story selection is split into A-Z filter groups.
	- Each letter is shown.
	- Empty letters are disabled.
	- If a letter exceeds the max size, that letter is split into numbered groups (example: `D1`, `D2`, `D3`).
- Hidden advanced setting:
	- Hold `Shift` while clicking `Show Trend` to reveal a normally hidden max-group-size input.
	- Set a new max and click `Set Max` to rebuild trend filter groups with that size.
	- Allowed range is `2` to `1000` stories per group.
	- The chosen max value is saved in extension local storage and persists across browser restarts.

## Panel Usability

- The panel has an `Expand`/`Collapse` button to widen the layout for large comparison tables.
- The floating `WSM` launcher turns green when Reads or Earnings increased in the default daily comparison.

## Data Management

- Storage uses `chrome.storage.local` and persists across browser sessions.
- `Prune Snapshots` coalesces each day into one merged full snapshot (max coverage union across that day) and removes same-day duplicates.
- `Transfer Data` section supports full export/import:
	- `Export All` writes all snapshots to JSON and copies to clipboard when available.
	- `Import All` restores snapshots from pasted exported JSON.
- Advanced comparison export:
	- `Export A/B JSON` is available via hidden advanced controls (Shift + `Run Default Comparison`).
- `Delete Data` section is hidden by default and is revealed from hidden advanced controls.
- `Delete Data` currently supports deleting by specific timestamp in the visible UI.

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
4. Select the `writer-success-stats-for-medium` folder.
5. Visit `https://medium.com/me/stats` while logged into Medium.
6. Open the extension panel from the toolbar icon or keyboard shortcut to create manual snapshots and run comparisons.
7. Use `Run Default Comparison` for full-range compare or Daily Changes Summary for day-level change detection.