/*
  DOM Replacer for Dynamic Apps (Angular/Vue/React/SPA)
  -----------------------------------------------
  Edit these values for most use cases:
  1) TARGET_SELECTOR
  2) REPLACEMENT_MARKUP

  Quick experiment shortcuts (Mac: Option = Alt key):
  - Option+Shift+S: Set TARGET_SELECTOR at runtime
  - Option+Shift+M: Set REPLACEMENT_MARKUP at runtime
  - Option+Shift+0: Reset both selector and markup to defaults
  - Disable experimentation shortcuts by setting enableExperimentation to false

  Created by Frank Font 2026
*/

// Set to true to enable runtime selector shortcuts (Option+Shift+S / Option+Shift+0 on Mac).
// Set to false to lock the extension — TARGET_SELECTOR and REPLACEMENT_MARKUP
// can only be changed by editing this file directly.
const enableExperimentation = true;

const TARGET_SELECTOR = "h1";
const REPLACEMENT_MARKUP = `
  <div style="padding: 12px; border: 2px solid #222; background: #f4f4f4;">
    <strong>Replaced by extension</strong>
    <p style="margin: 8px 0 0;">Now supports Angular/Vue/React re-renders.</p>
  </div>
`;

const OBSERVER_DEBOUNCE_MS = 80;
const REPLACED_ATTR = "data-dom-replacer-node";
const STORAGE_SELECTOR_KEY = "domReplacerSelectorOverride";
const STORAGE_MARKUP_KEY = "domReplacerMarkupOverride";

let observer = null;
let scanScheduled = false;
let applyingReplacement = false;
let hasLoggedInitialMiss = false;

function getActiveSelector() {
  const override = window.localStorage.getItem(STORAGE_SELECTOR_KEY);

  if (typeof override !== "string") {
    return TARGET_SELECTOR;
  }

  const normalized = override.trim();
  return normalized || TARGET_SELECTOR;
}

function setSelectorOverride(value) {
  if (typeof value !== "string") {
    return;
  }

  const normalized = value.trim();
  if (!normalized) {
    window.localStorage.removeItem(STORAGE_SELECTOR_KEY);
    return;
  }

  window.localStorage.setItem(STORAGE_SELECTOR_KEY, normalized);
}

function clearSelectorOverride() {
  window.localStorage.removeItem(STORAGE_SELECTOR_KEY);
}

function getActiveMarkup() {
  const override = window.localStorage.getItem(STORAGE_MARKUP_KEY);

  if (typeof override !== "string") {
    return REPLACEMENT_MARKUP;
  }

  const normalized = override.trim();
  return normalized || REPLACEMENT_MARKUP;
}

function setMarkupOverride(value) {
  if (typeof value !== "string") {
    return;
  }

  const normalized = value.trim();
  if (!normalized) {
    window.localStorage.removeItem(STORAGE_MARKUP_KEY);
    return;
  }

  window.localStorage.setItem(STORAGE_MARKUP_KEY, normalized);
}

function clearMarkupOverride() {
  window.localStorage.removeItem(STORAGE_MARKUP_KEY);
}

function createReplacementNode() {
  const wrapper = document.createElement("div");
  wrapper.innerHTML = getActiveMarkup().trim();

  const node = wrapper.firstElementChild || document.createElement("div");
  node.setAttribute(REPLACED_ATTR, "true");

  return node;
}

function collectTargets() {
  const selector = getActiveSelector();

  return Array.from(document.querySelectorAll(selector)).filter((node) => {
    if (!(node instanceof Element)) {
      return false;
    }

    if (node.hasAttribute(REPLACED_ATTR)) {
      return false;
    }

    // Skip targets already inside previously injected replacement markup.
    return !node.closest(`[${REPLACED_ATTR}="true"]`);
  });
}

function replaceTargets() {
  const selector = getActiveSelector();
  const targets = collectTargets();

  if (targets.length === 0) {
    if (!hasLoggedInitialMiss) {
      console.info(`[DOM Replacer] No element found for selector: ${selector}`);
      hasLoggedInitialMiss = true;
    }
    return;
  }

  hasLoggedInitialMiss = false;
  applyingReplacement = true;

  for (const target of targets) {
    const replacement = createReplacementNode();
    target.replaceWith(replacement);
  }

  applyingReplacement = false;
  console.info(`[DOM Replacer] Replaced ${targets.length} element(s) for selector: ${selector}`);
}

function scheduleReplace() {
  if (scanScheduled) {
    return;
  }

  scanScheduled = true;
  window.setTimeout(() => {
    scanScheduled = false;
    replaceTargets();
  }, OBSERVER_DEBOUNCE_MS);
}

function startObserver() {
  observer = new MutationObserver((mutations) => {
    if (applyingReplacement) {
      return;
    }

    for (const mutation of mutations) {
      if (mutation.type === "childList" && mutation.addedNodes.length > 0) {
        scheduleReplace();
        return;
      }
    }
  });

  observer.observe(document.documentElement, {
    childList: true,
    subtree: true
  });
}

function startExperimentShortcuts() {
  if (!enableExperimentation) {
    return;
  }

  window.addEventListener("keydown", (event) => {
    if (!(event.altKey && event.shiftKey)) {
      return;
    }

    if (event.code === "KeyS") {
      event.preventDefault();

      const currentSelector = getActiveSelector();
      const input = window.prompt(
        "DOM Replacer selector (leave empty to reset to default):",
        currentSelector
      );

      if (input === null) {
        return;
      }

      if (input.trim()) {
        setSelectorOverride(input);
        console.info(`[DOM Replacer] Selector override set to: ${getActiveSelector()}`);
      } else {
        clearSelectorOverride();
        console.info(`[DOM Replacer] Selector override cleared. Using default: ${TARGET_SELECTOR}`);
      }

      scheduleReplace();
      return;
    }

    if (event.code === "KeyM") {
      event.preventDefault();

      const currentMarkup = getActiveMarkup();
      const input = window.prompt(
        "DOM Replacer markup (paste HTML; leave empty to reset to default):",
        currentMarkup
      );

      if (input === null) {
        return;
      }

      if (input.trim()) {
        setMarkupOverride(input);
        console.info("[DOM Replacer] Markup override set.");
      } else {
        clearMarkupOverride();
        console.info("[DOM Replacer] Markup override cleared. Using default REPLACEMENT_MARKUP.");
      }

      scheduleReplace();
      return;
    }

    if (event.code === "Digit0") {
      event.preventDefault();
      clearSelectorOverride();
      clearMarkupOverride();
      console.info(`[DOM Replacer] All overrides cleared. Using defaults.`);
      scheduleReplace();
    }
  });
}

function init() {
  replaceTargets();
  startObserver();
  startExperimentShortcuts();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init, { once: true });
} else {
  init();
}
