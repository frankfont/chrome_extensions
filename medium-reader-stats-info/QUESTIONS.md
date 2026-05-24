# Questions Before Implementation

1. What exact trigger should create a snapshot?
   - Manual button click in the extension popup, automatic on visiting `https://medium.com/me/stats`, or both?

A: Automatic once per day on first visit of that day and also manual button click on extension popup. There can be multiple manual snapshots per day. User can view Any two snapshots via a picker. By default, diff is between latest current and last available snapshot from the most recent prior day which has a snapshot.

2. How should snapshots be identified and organized?
   - One snapshot per day, per timestamp, or user-defined labels (for example "May baseline")?

A: I do not want screenshots -- I want values stored as text and numbers. Organize by Story Name and timestamp. Primary key is Story Name + timestamp.

3. Should we store only the five listed fields (`Story Name`, `Presentations`, `Views`, `Reads`, `Earnings`) or include additional metadata (for example snapshot timestamp, Medium URL, story ID)?

A: Yes store timestamp, medium URL, and story ID in addition to the core fields.

4. Which comparisons should be available in the UI?
   - Compare latest vs previous, compare any two selected snapshots, trend over time, or all of these?

A: All of these; user has options.

5. How should differences be displayed?
   - Absolute delta only, percentage delta, color coding (green/red), sortable columns, etc.

A: All of these

6. What should happen when a story exists in one snapshot but not the other?
   - Show as new/removed story, ignore, or configurable behavior?

A: Show as new/removed story.

7. What is the expected parsing source on Medium stats page?
   - DOM table selectors from a specific layout/version, and do we need fallback selectors for UI changes?

A: DOM and the extension will need to scroll down the page to trigger generation of data. Stop when no new rows appear after N scrolls. Set N as a constant in the script that is clearly set at top of script to value 3.

8. Should this extension support only English-formatted numbers/currency, or must it handle localized formats (for example commas vs periods, different currency symbols)?

A: American English only

9. Do we need export/import features for snapshots (CSV/JSON), or is in-browser storage sufficient?

A: No export.

10. Are there retention limits or cleanup rules for stored snapshots?
    - Keep all snapshots forever, max count, or time-based pruning?

A: Allow user to manually delete based on story and/or specific timestamp

11. What is the minimum Chrome extension manifest version and permission scope we want?
    - For example `manifest_version: 3`, host permissions for `medium.com`, and whether `activeTab` is acceptable.

A: manifest_version: 3

12. Should the extension include any privacy/disclaimer notes?
    - Clarify that data remains local in `chrome.storage` and is not transmitted externally.

A: Yes

13. How should errors be handled in the UI?
    - Empty stats page, parsing failure, Medium not logged in, or selector mismatch.

A: Clear explanation of error to the user

14. Should we support multiple Medium accounts/profiles in the same browser?
    - If yes, how do we partition stored snapshots?

A: No
