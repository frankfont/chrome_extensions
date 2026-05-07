# DOM Replacer (MutationObserver) - Chrome Extension

A Manifest V3 extension that replaces matching elements with custom markup and keeps working when Angular or Vue re-render the page.

## Why this works for Angular/Vue/React

Angular, Vue, and React often render content after page load and re-render DOM nodes during route changes or state updates.

This extension uses a `MutationObserver` to detect new DOM nodes and re-apply replacements when matching elements appear again.

## Files

- `manifest.json`: Extension configuration
- `content.js`: Replacement + observer logic

## What to Edit

Open `content.js` and update:

1. `TARGET_SELECTOR`

Example:

```js
const TARGET_SELECTOR = ".hero-title";
```

2. `REPLACEMENT_MARKUP`

Example:

```js
const REPLACEMENT_MARKUP = `
  <section class="my-box">
    <h2>New headline</h2>
    <p>This content was injected by my extension.</p>
  </section>
`;
```

## Load in Chrome

1. Open `chrome://extensions`
2. Turn on **Developer mode**
3. Click **Load unpacked**
4. Select: `dom-replacer-extension`

## Optional: Restrict Where It Runs

By default, it runs on all URLs (`"<all_urls>"`).
To limit it, edit `manifest.json`:

```json
"matches": ["https://example.com/*"]
```

## Real-World Example: Replace a nav label text

Given this markup from a dynamic nav sidebar:

```html
<li id="/home" class="relative scroll-m-4 ...">
  <a href="/home" ...>
    <div ...>
      <div ...>
        <span class="min-w-0 max-w-full break-words hyphens-auto">Overview</span>
      </div>
    </div>
  </a>
</li>
```

To replace the word **Overview** with **MyReplacementWord**, target the `<span>` inside that specific `<li>` using its `id` attribute:

```js
const TARGET_SELECTOR = 'li[id="/home"] span.min-w-0.max-w-full.break-words.hyphens-auto';
```

Then set `REPLACEMENT_MARKUP` to a new `<span>` with the same classes so layout is preserved:

```js
const REPLACEMENT_MARKUP = `
  <span class="min-w-0 max-w-full break-words hyphens-auto">MyReplacementWord</span>
`;
```

The extension replaces the matched element in full, so the replacement `<span>` takes the original's place in the DOM.

> **Tip:** Use the `Option+Shift+S` shortcut (Mac) to test the selector live without editing code or reloading.

## Experimenting With Selectors Faster

If you edit `content.js`, you still need to reload the extension in `chrome://extensions` and refresh the page.

To avoid that while testing selectors, this extension includes runtime shortcuts:

- `Option+Shift+S` (Mac) / `Alt+Shift+S` (Windows/Linux): Open a prompt to set a selector override for the current site.
- `Option+Shift+M` (Mac) / `Alt+Shift+M` (Windows/Linux): Open a prompt to paste a replacement markup override.
- `Option+Shift+0` (Mac) / `Alt+Shift+0` (Windows/Linux): Clear **both** selector and markup overrides, returning to the defaults in `content.js`.

> **Mac note:** `Option` is the Mac equivalent of the `Alt` key.

The selector override is saved in browser local storage, so it persists across refreshes.

To disable these shortcuts entirely, set `enableExperimentation = false` in `content.js`.

## Notes

- It replaces all matching elements currently in the DOM.
- It re-runs replacement when new matching elements are added later.
- Keep `REPLACEMENT_MARKUP` to a single top-level element for predictable replacement.
