/*
  Writer Success Stats for Medium content script

  Instructions:
  - Load this script on https://medium.com/me/stats only.
  - It injects an on-page panel for snapshot capture, comparison, trend views,
    and deletion controls.
  - Open the panel from the floating launcher, the Chrome toolbar icon,
    or the keyboard shortcuts below.
  - Mac shortcuts:
    - Option+Shift+S: open the panel and capture a manual snapshot.
    - Option+Shift+0: open the panel and focus the comparison controls.
  - Automatic behavior:
    - Capture one automatic snapshot per day on the first visit to the stats page.
    - Scroll the page to load stats rows before parsing.
    - Stop scrolling after 3 consecutive passes with no new rows.
  - Data is stored locally in chrome.storage.

  Created by Frank Font 2026
*/

const TARGET_URL_PREFIX = "https://medium.com/me/stats";
const CHANGE_EPSILON = 0.000001;
const AUTO_SCROLL_STABLE_ITERATIONS = 3;
const AUTO_SCROLL_CONFIRMATION_PASSES = 2;
const AUTO_SCROLL_MAX_ITERATIONS = 40;
const AUTO_SCROLL_WAIT_INTERVAL_MS = 75;
const AUTO_SCROLL_WAIT_TIMEOUT_MS = 1800;
const COMPARE_AUTO_RENDER_DEBOUNCE_MS = 150;
const ROUTE_CHECK_INTERVAL_MS = 500;
const DEFAULT_TREND_GROUP_MAX_SIZE = 50;
const MIN_TREND_GROUP_MAX_SIZE = 2;
const MAX_TREND_GROUP_MAX_SIZE = 1000;
const TREND_COLOR_VIEWS = "#d97706";
const TREND_COLOR_READS = "#2563eb";
const TREND_COLOR_EARNINGS = "#16a34a";

const STORAGE_KEYS = {
  snapshots: "mwSnapshots",
  lastAutoSnapshotDate: "mwLastAutoSnapshotDate",
  trendGroupMaxSize: "mwTrendGroupMaxSize",
  trendGroupMaxCustomized: "mwTrendGroupMaxCustomized"
};

const PANEL_IDS = {
  wrapper: "mw-stats-panel-wrapper",
  panel: "mw-stats-panel",
  launcher: "mw-stats-launcher"
};

const state = {
  snapshots: [],
  materializedSnapshotsById: new Map(),
  materializedSnapshotsVersion: "",
  panelReady: false,
  launcherEl: null,
  panelEl: null,
  selectCompareDateA: null,
  selectCompareDateB: null,
  selectCompareA: null,
  selectCompareB: null,
  selectTrendStory: null,
  trendFilterContainerEl: null,
  trendGroupSettingsEl: null,
  trendGroupMaxInputEl: null,
  trendSectionEl: null,
  trendChartOverlayEl: null,
  trendChartTitleEl: null,
  trendChartSvgEl: null,
  trendChartCloseBtnEl: null,
  trendChartOutsideClickHandler: null,
  trendStoryGroups: [],
  activeTrendStoryGroupKey: "",
  trendGroupMaxSize: DEFAULT_TREND_GROUP_MAX_SIZE,
  selectDeleteStory: null,
  selectDeleteTimestamp: null,
  smartCaptureHintEl: null,
  statusEl: null,
  summaryEl: null,
  dailySummaryEl: null,
  dailyFilterPresentationsEl: null,
  dailyFilterViewsEl: null,
  dailyFilterReadsEl: null,
  dailyFilterEarningsEl: null,
  compareFilterPresentationsEl: null,
  compareFilterViewsEl: null,
  compareFilterReadsEl: null,
  compareFilterEarningsEl: null,
  diffContainerEl: null,
  auditSectionEl: null,
  auditContainerEl: null,
  trendContainerEl: null,
  lastSeenUrl: "",
  routeCheckTimer: null,
  routeWatcherStarted: false,
  keyboardShortcutsWired: false,
  runtimeMessagesWired: false,
  transferSectionEl: null,
  deleteSectionEl: null,
  compareRenderTimer: null,
  compareSortKey: "",
  compareSortDirection: "asc"
};

function setAuditSectionVisible(visible) {
  if (!state.auditSectionEl) {
    return;
  }
  state.auditSectionEl.style.display = visible ? "block" : "none";
}

function setTransferSectionVisible(visible) {
  if (!state.transferSectionEl) {
    return;
  }
  state.transferSectionEl.style.display = visible ? "block" : "none";
}

function setDeleteSectionVisible(visible) {
  if (!state.deleteSectionEl) {
    return;
  }
  state.deleteSectionEl.style.display = visible ? "block" : "none";
}

function setAdvancedFeaturesVisible(visible) {
  const auditButton = document.getElementById("mw-audit-compare");
  const exportAuditButton = document.getElementById("mw-export-audit-json");
  const exportCompareButton = document.getElementById("mw-export-compare-json");
  const hideAdvancedButton = document.getElementById("mw-hide-advanced-features");

  if (auditButton) {
    auditButton.style.display = visible ? "" : "none";
  }
  if (exportAuditButton) {
    exportAuditButton.style.display = visible ? "" : "none";
  }
  if (exportCompareButton) {
    exportCompareButton.style.display = visible ? "" : "none";
  }
  if (hideAdvancedButton) {
    hideAdvancedButton.style.display = visible ? "" : "none";
  }

  setTransferSectionVisible(visible);
  setDeleteSectionVisible(visible);
}

function setTrendGroupSettingsVisible(visible) {
  if (!state.trendGroupSettingsEl) {
    return;
  }
  state.trendGroupSettingsEl.style.display = visible ? "flex" : "none";
}

function isTargetPage() {
  return window.location.href.startsWith(TARGET_URL_PREFIX);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toDateKey(iso) {
  const d = new Date(iso);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function nowIso() {
  return new Date().toISOString();
}

function formatTimestamp(iso) {
  try {
    return new Date(iso).toLocaleString("en-US");
  } catch {
    return iso;
  }
}

function formatCurrency(value) {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return "-";
  }
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(value);
}

function formatNumber(value) {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return "-";
  }
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 2
  }).format(value);
}

function formatSignedNumber(value) {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return "-";
  }
  const abs = formatNumber(Math.abs(value));
  if (value > 0) {
    return `+${abs}`;
  }
  if (value < 0) {
    return `-${abs}`;
  }
  return "0";
}

function formatSignedCurrency(value) {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return "-";
  }
  const abs = formatCurrency(Math.abs(value));
  if (value > 0) {
    return `+${abs}`;
  }
  if (value < 0) {
    return `-${abs}`;
  }
  return formatCurrency(0);
}

function formatSignedPercent(value) {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return "-";
  }
  const abs = `${Math.abs(value).toFixed(1)}%`;
  if (value > 0) {
    return `+${abs}`;
  }
  if (value < 0) {
    return `-${abs}`;
  }
  return "0.0%";
}

function formatByteSize(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) {
    return "-";
  }
  if (bytes < 1024) {
    return `${bytes} B`;
  }

  const kb = bytes / 1024;
  if (kb < 1024) {
    return `${kb.toFixed(kb < 10 ? 1 : 0)} KB`;
  }

  const mb = kb / 1024;
  if (mb < 1024) {
    return `${mb.toFixed(mb < 10 ? 1 : 0)} MB`;
  }

  const gb = mb / 1024;
  return `${gb.toFixed(gb < 10 ? 1 : 0)} GB`;
}

function estimateSnapshotsStorageBytes() {
  try {
    const json = JSON.stringify(state.snapshots || []);
    return new TextEncoder().encode(json).length;
  } catch {
    return 0;
  }
}

function parseScaledNumber(text) {
  if (!text) {
    return null;
  }

  const cleaned = String(text).replace(/\s+/g, " ").trim();
  const match = cleaned.match(/(-?[\d,]+(?:\.\d+)?)\s*([kmb])?/i);
  if (!match) {
    return null;
  }

  const numeric = Number(match[1].replace(/,/g, ""));
  if (Number.isNaN(numeric)) {
    return null;
  }

  const suffix = (match[2] || "").toUpperCase();
  if (suffix === "K") {
    return numeric * 1_000;
  }
  if (suffix === "M") {
    return numeric * 1_000_000;
  }
  if (suffix === "B") {
    return numeric * 1_000_000_000;
  }
  return numeric;
}

function parseCurrency(text) {
  if (!text) {
    return null;
  }

  const normalized = String(text)
    .replace(/\u2212/g, "-")
    .replace(/[^\d.,$\-kmbKMB]/g, "");

  const numeric = parseScaledNumber(normalized.replace(/\$/g, ""));
  return numeric;
}

function parseNumber(text) {
  return parseScaledNumber(text);
}

function getStoryIdFromUrl(url) {
  if (!url) {
    return "";
  }
  const match = String(url).match(/\/(?:me\/stats\/post|p)\/([a-zA-Z0-9]+)/);
  return match ? match[1] : "";
}

function normalizeMediumStoryUrl(url) {
  const rawUrl = String(url || "").trim();
  if (!rawUrl) {
    return "";
  }

  const storyId = getStoryIdFromUrl(rawUrl);
  if (storyId) {
    return `https://medium.com/me/stats/post/${storyId}`;
  }

  try {
    const parsed = new URL(rawUrl);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return rawUrl;
  }
}

function sanitizeText(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function formatStoryTitleForDisplay(storyName) {
  return String(storyName || "").replace(/\s*·\s*View\s+story\s*$/i, "").trim();
}

function getStatsPostUrl(story) {
  if (!story) {
    return "";
  }

  const rawUrl = String(story.mediumUrl || "").trim();
  if (rawUrl && rawUrl.includes("/me/stats/post/")) {
    return rawUrl;
  }

  const idMatch = rawUrl.match(/\/(?:me\/stats\/post|p)\/([a-zA-Z0-9]+)/);
  const storyId = story.storyId || (idMatch ? idMatch[1] : "");
  if (!storyId) {
    return "";
  }

  return `https://medium.com/me/stats/post/${storyId}`;
}

function renderStoryTitleHtml(storyName, storyUrl) {
  const title = formatStoryTitleForDisplay(storyName);
  if (!storyUrl) {
    return title;
  }

  return `<a class="mw-story-link" href="${storyUrl}" target="_blank" rel="noopener noreferrer" title="Open stats post page">${title}</a>`;
}

function normalizeExtensionRuntimeErrorMessage(rawMessage) {
  const text = String(rawMessage || "");
  const lowered = text.toLowerCase();
  if (lowered.includes("extension context invalidated") || lowered.includes("context invalidated")) {
    return "Extension was reloaded or updated. Refresh this page to reinitialize the panel.";
  }
  return text || "Extension runtime error.";
}

function getStorage(keys) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get(keys, (result) => {
      const err = chrome.runtime.lastError;
      if (err) {
        reject(new Error(normalizeExtensionRuntimeErrorMessage(err.message)));
        return;
      }
      resolve(result);
    });
  });
}

function setStorage(payload) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set(payload, () => {
      const err = chrome.runtime.lastError;
      if (err) {
        reject(new Error(normalizeExtensionRuntimeErrorMessage(err.message)));
        return;
      }
      resolve();
    });
  });
}

function setStatus(message, isError = false) {
  if (!state.statusEl) {
    return;
  }
  state.statusEl.textContent = message;
  state.statusEl.classList.remove("mw-status-busy");
  state.statusEl.style.color = isError ? "#8f1111" : "#0f5132";
}

function setSnapshotCaptureUiBusy(isBusy, activeButtonId = "") {
  const buttonConfigs = [
    {
      id: "mw-manual-snapshot-smart",
      idleText: "Capture Snapshot",
      busyText: "Creating smart snapshot..."
    }
  ];

  buttonConfigs.forEach((config) => {
    const button = document.getElementById(config.id);
    if (!button) {
      return;
    }

    const isActive = !!isBusy && activeButtonId === config.id;
    button.disabled = !!isBusy;
    button.classList.toggle("mw-busy-action", isActive);
    button.textContent = isActive ? config.busyText : config.idleText;
  });

  if (state.statusEl) {
    state.statusEl.classList.toggle("mw-status-busy", !!isBusy);
    state.statusEl.style.color = isBusy ? "#7a2f00" : "#0f5132";
  }
}

function countPotentialRows() {
  const tableRows = document.querySelectorAll("table tbody tr, table tr").length;
  const storyLinks = document.querySelectorAll("a[href*='/p/']").length;
  return Math.max(tableRows, storyLinks);
}

function getDocumentScrollHeight() {
  return Math.max(
    document.body ? document.body.scrollHeight : 0,
    document.documentElement ? document.documentElement.scrollHeight : 0
  );
}

async function waitForPageGrowth(previousCount, previousScrollHeight) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < AUTO_SCROLL_WAIT_TIMEOUT_MS) {
    const currentCount = countPotentialRows();
    const currentScrollHeight = getDocumentScrollHeight();
    if (currentCount > previousCount || currentScrollHeight > previousScrollHeight) {
      return true;
    }
    await sleep(AUTO_SCROLL_WAIT_INTERVAL_MS);
  }

  return false;
}

async function autoScrollForDataRows() {
  let stableLoops = 0;
  let lastCount = countPotentialRows();
  let lastScrollHeight = getDocumentScrollHeight();

  for (let i = 0; i < AUTO_SCROLL_MAX_ITERATIONS; i += 1) {
    window.scrollTo(0, document.body.scrollHeight);

    await waitForPageGrowth(lastCount, lastScrollHeight);

    const currentCount = countPotentialRows();
    const currentScrollHeight = getDocumentScrollHeight();
    if (currentCount <= lastCount) {
      stableLoops += 1;
    } else {
      stableLoops = 0;
      lastCount = currentCount;
    }

    if (currentScrollHeight > lastScrollHeight) {
      lastScrollHeight = currentScrollHeight;
    }

    if (stableLoops >= AUTO_SCROLL_STABLE_ITERATIONS) {
      let confirmationPassed = true;

      for (let confirmation = 0; confirmation < AUTO_SCROLL_CONFIRMATION_PASSES; confirmation += 1) {
        const priorCount = lastCount;
        const priorScrollHeight = lastScrollHeight;

        window.scrollTo(0, document.body.scrollHeight);
        await waitForPageGrowth(priorCount, priorScrollHeight);

        const confirmationCount = countPotentialRows();
        const confirmationScrollHeight = getDocumentScrollHeight();

        if (confirmationCount > priorCount || confirmationScrollHeight > priorScrollHeight) {
          confirmationPassed = false;
          stableLoops = 0;
          lastCount = confirmationCount;
          lastScrollHeight = confirmationScrollHeight > priorScrollHeight ? confirmationScrollHeight : lastScrollHeight;
          break;
        }
      }

      if (confirmationPassed) {
        break;
      }
    }
  }
}

function extractRowsFromTable() {
  const parsed = [];
  const rows = Array.from(document.querySelectorAll("table tbody tr, table tr"));

  rows.forEach((row) => {
    // Ignore rows rendered inside this extension panel (diff/audit/trend tables).
    if (row.closest(`#${PANEL_IDS.wrapper}`)) {
      return;
    }

    const cells = Array.from(row.querySelectorAll("td, th"))
      .map((cell) => sanitizeText(cell.textContent))
      .filter(Boolean);

    if (cells.length < 5) {
      return;
    }

    const storyName = cells[0];
    const presentations = parseNumber(cells[1]);
    const views = parseNumber(cells[2]);
    const reads = parseNumber(cells[3]);
    const earnings = parseCurrency(cells[4]);

    const storyLink = row.querySelector("a[href]");
    const rawMediumUrl = storyLink ? storyLink.href : "";
    const mediumUrl = normalizeMediumStoryUrl(rawMediumUrl);
    const storyId = getStoryIdFromUrl(mediumUrl);

    // Require a Medium story link to avoid parsing unrelated page tables.
    const hasMediumStoryLink =
      !!storyLink &&
      (rawMediumUrl.includes("medium.com/me/stats/post/") || rawMediumUrl.includes("medium.com/p/") || rawMediumUrl.includes("/p/"));
    if (!hasMediumStoryLink) {
      return;
    }

    if (!storyName || (views === null && reads === null && earnings === null)) {
      return;
    }

    parsed.push({
      storyName,
      presentations,
      views,
      reads,
      earnings,
      mediumUrl,
      storyId
    });
  });

  return parsed;
}

function dedupeStories(rows) {
  const map = new Map();
  rows.forEach((row) => {
    const key = row.storyId ? `id:${row.storyId}` : `name:${row.storyName.toLowerCase()}`;
    if (!map.has(key)) {
      map.set(key, row);
      return;
    }

    const existing = map.get(key);
    const existingCompleteness = [existing.presentations, existing.views, existing.reads, existing.earnings].filter((v) => v !== null).length;
    const currentCompleteness = [row.presentations, row.views, row.reads, row.earnings].filter((v) => v !== null).length;
    if (currentCompleteness > existingCompleteness) {
      map.set(key, row);
    }
  });
  return Array.from(map.values());
}

function extractStoryRows() {
  const tableRows = extractRowsFromTable();
  return dedupeStories(tableRows);
}

function hasAnyStatsMetricValueOnPage() {
  const rows = Array.from(document.querySelectorAll("table tbody tr, table tr"));

  for (const row of rows) {
    const cells = Array.from(row.querySelectorAll("td, th"))
      .map((cell) => sanitizeText(cell.textContent))
      .filter(Boolean);

    if (cells.length < 5) {
      continue;
    }

    const presentations = parseNumber(cells[1]);
    const views = parseNumber(cells[2]);
    const reads = parseNumber(cells[3]);
    const earnings = parseCurrency(cells[4]);

    if (presentations !== null || views !== null || reads !== null || earnings !== null) {
      return true;
    }
  }

  return false;
}

function validateSnapshotIntegrity(rows) {
  if (!Array.isArray(rows) || !rows.length) {
    return "No story rows found to validate.";
  }

  const linkedRows = rows.filter((row) => !!row.mediumUrl && row.mediumUrl.includes("medium.com"));
  const linkedRatio = linkedRows.length / rows.length;
  if (linkedRatio < 0.9) {
    return "Snapshot integrity check failed: too many rows are missing Medium story links.";
  }

  const presentationRows = rows.filter((row) => row.presentations !== null && row.presentations !== undefined);
  if (!presentationRows.length) {
    return "Snapshot integrity check failed: Presentations values were not found on this page state.";
  }

  const comparableRows = rows.filter((row) => row.views !== null && row.views !== undefined && row.reads !== null && row.reads !== undefined);
  if (comparableRows.length >= 5) {
    const sameViewReadRows = comparableRows.filter((row) => Math.abs(row.views - row.reads) <= CHANGE_EPSILON);
    const sameRatio = sameViewReadRows.length / comparableRows.length;
    if (sameRatio >= 0.8) {
      return "Snapshot integrity check failed: Reads and Views are identical for most rows, which indicates a malformed capture.";
    }
  }

  return null;
}

function findLatestSnapshot() {
  if (!state.snapshots.length) {
    return null;
  }
  return state.snapshots[state.snapshots.length - 1];
}

function hasAnyPriorSnapshot() {
  return state.snapshots.length > 0;
}

function hasSnapshotWithinLookbackDays(dayCount, referenceIso = nowIso()) {
  const referenceMs = new Date(referenceIso).getTime();
  if (Number.isNaN(referenceMs)) {
    return false;
  }

  const lookbackMs = dayCount * 24 * 60 * 60 * 1000;
  return state.snapshots.some((snapshot) => {
    const snapshotMs = new Date(snapshot.capturedAt).getTime();
    if (Number.isNaN(snapshotMs) || snapshotMs > referenceMs) {
      return false;
    }
    return referenceMs - snapshotMs <= lookbackMs;
  });
}

function getSmartCaptureDecision(referenceIso = nowIso()) {
  if (!hasAnyPriorSnapshot()) {
    return {
      mode: "full",
      modeLabel: "Full",
      reason: "no prior snapshot found"
    };
  }

  if (hasSnapshotWithinLookbackDays(5, referenceIso)) {
    return {
      mode: "sparse",
      modeLabel: "Delta",
      reason: "recent snapshot found within 5 days"
    };
  }

  return {
    mode: "full",
    modeLabel: "Full",
    reason: "no snapshot found in the last 5 days"
  };
}

function updateSmartCaptureHint() {
  if (!state.smartCaptureHintEl) {
    return;
  }

  const decision = getSmartCaptureDecision();
  state.smartCaptureHintEl.textContent = `Mode: Smart -> ${decision.modeLabel} (${decision.reason}). Shift+Click: force Full. Option+Click: force Delta.`;
}

function isSparseSnapshot(snapshot) {
  return !!snapshot && snapshot.storageMode === "sparse";
}

function normalizeStoryRecord(story, fallbackTimestamp) {
  if (!story) {
    return null;
  }

  const normalizedStoryName = String(story.storyName || "").trim();
  if (!normalizedStoryName) {
    return null;
  }

  return {
    key: story.key || `${normalizedStoryName}__${fallbackTimestamp}`,
    storyName: normalizedStoryName,
    presentations: story.presentations !== undefined ? story.presentations : null,
    views: story.views !== undefined ? story.views : null,
    reads: story.reads !== undefined ? story.reads : null,
    earnings: story.earnings !== undefined ? story.earnings : null,
    timestamp: story.timestamp || fallbackTimestamp,
    mediumUrl: story.mediumUrl || "",
    storyId: story.storyId || "",
    removed: !!story.removed
  };
}

function getSnapshotCacheVersion() {
  return state.snapshots
    .map((snapshot) => `${snapshot.id}:${snapshot.storageMode || "full"}:${Array.isArray(snapshot.stories) ? snapshot.stories.length : 0}`)
    .join("|");
}

function rebuildMaterializedSnapshotCache() {
  const cache = new Map();
  let materializedStoryMap = new Map();
  let hasAnchor = false;

  state.snapshots.forEach((snapshot) => {
    const normalizedStories = Array.isArray(snapshot.stories)
      ? snapshot.stories
          .map((story) => normalizeStoryRecord(story, snapshot.capturedAt))
          .filter(Boolean)
      : [];

    if (isSparseSnapshot(snapshot) && hasAnchor) {
      normalizedStories.forEach((story) => {
        const key = getStoryKey(story);
        if (story.removed) {
          materializedStoryMap.delete(key);
          return;
        }
        materializedStoryMap.set(key, {
          ...story,
          removed: false,
          timestamp: snapshot.capturedAt,
          key: `${story.storyName}__${snapshot.capturedAt}`
        });
      });
    } else {
      materializedStoryMap = new Map();
      normalizedStories.forEach((story) => {
        if (story.removed) {
          return;
        }
        materializedStoryMap.set(getStoryKey(story), {
          ...story,
          removed: false,
          timestamp: snapshot.capturedAt,
          key: `${story.storyName}__${snapshot.capturedAt}`
        });
      });
      hasAnchor = true;
    }

    const materializedStories = Array.from(materializedStoryMap.values()).sort((a, b) => a.storyName.localeCompare(b.storyName));
    cache.set(snapshot.id, {
      ...snapshot,
      storageMode: snapshot.storageMode || "full",
      stories: materializedStories
    });
  });

  state.materializedSnapshotsById = cache;
  state.materializedSnapshotsVersion = getSnapshotCacheVersion();
}

function ensureMaterializedSnapshotCache() {
  const currentVersion = getSnapshotCacheVersion();
  if (state.materializedSnapshotsVersion === currentVersion) {
    return;
  }
  rebuildMaterializedSnapshotCache();
}

function getAllMaterializedSnapshots() {
  ensureMaterializedSnapshotCache();
  const byId = state.materializedSnapshotsById;
  return state.snapshots
    .map((snapshot) => byId.get(snapshot.id) || null)
    .filter(Boolean);
}

function findReadDecreasesComparedToSnapshot(rows, previousSnapshot) {
  if (!previousSnapshot || !Array.isArray(previousSnapshot.stories) || !previousSnapshot.stories.length) {
    return [];
  }

  const previousMap = new Map();
  previousSnapshot.stories.forEach((story) => {
    previousMap.set(getStoryKey(story), story);
  });

  const decreases = [];
  rows.forEach((row) => {
    const key = getStoryKey(row);
    const previous = previousMap.get(key);
    if (!previous) {
      return;
    }

    if (previous.reads === null || previous.reads === undefined || row.reads === null || row.reads === undefined) {
      return;
    }

    if (row.reads < previous.reads - CHANGE_EPSILON) {
      decreases.push({
        storyName: row.storyName,
        previousReads: previous.reads,
        currentReads: row.reads
      });
    }
  });

  return decreases;
}

function buildSnapshot(rows, mode, preferredStorageMode = "auto") {
  const capturedAt = nowIso();
  const fullStories = rows.map((row) => ({
    key: `${row.storyName}__${capturedAt}`,
    storyName: row.storyName,
    presentations: row.presentations,
    views: row.views,
    reads: row.reads,
    earnings: row.earnings,
    timestamp: capturedAt,
    mediumUrl: row.mediumUrl || "",
    storyId: row.storyId || ""
  }));

  const latestSnapshot = findLatestSnapshot();
  const latestMaterialized = latestSnapshot
    ? getSnapshotById(latestSnapshot.id)
    : null;
  const sameDayLatest = latestMaterialized && toDateKey(latestMaterialized.capturedAt) === toDateKey(capturedAt)
    ? latestMaterialized
    : null;
  const baselineSnapshot = preferredStorageMode === "sparse" ? latestMaterialized : sameDayLatest;

  if (preferredStorageMode === "full" || !baselineSnapshot) {
    return {
      id: capturedAt,
      mode,
      capturedAt,
      sourceUrl: window.location.href,
      storageMode: "full",
      stories: fullStories
    };
  }

  const previousMap = buildStoryMap(baselineSnapshot);
  const currentMap = new Map();
  fullStories.forEach((story) => {
    currentMap.set(getStoryKey(story), story);
  });

  const allKeys = new Set([...previousMap.keys(), ...currentMap.keys()]);
  const sparseStories = [];
  allKeys.forEach((key) => {
    const previous = previousMap.get(key) || null;
    const current = currentMap.get(key) || null;

    if (!previous && current) {
      sparseStories.push(current);
      return;
    }

    if (previous && !current) {
      sparseStories.push({
        key: `${previous.storyName}__${capturedAt}`,
        storyName: previous.storyName,
        presentations: null,
        views: null,
        reads: null,
        earnings: null,
        timestamp: capturedAt,
        mediumUrl: previous.mediumUrl || "",
        storyId: previous.storyId || "",
        removed: true
      });
      return;
    }

    if (!previous || !current) {
      return;
    }

    const changed =
      previous.storyName !== current.storyName ||
      previous.presentations !== current.presentations ||
      previous.views !== current.views ||
      previous.reads !== current.reads ||
      previous.earnings !== current.earnings ||
      previous.mediumUrl !== current.mediumUrl ||
      previous.storyId !== current.storyId;

    if (changed) {
      sparseStories.push(current);
    }
  });

  return {
    id: capturedAt,
    mode,
    capturedAt,
    sourceUrl: window.location.href,
    storageMode: "sparse",
    stories: sparseStories
  };
}

async function loadSnapshots() {
  const result = await getStorage([STORAGE_KEYS.snapshots]);
  state.snapshots = Array.isArray(result[STORAGE_KEYS.snapshots]) ? result[STORAGE_KEYS.snapshots] : [];
  state.snapshots.sort((a, b) => new Date(a.capturedAt).getTime() - new Date(b.capturedAt).getTime());
  rebuildMaterializedSnapshotCache();
}

async function persistSnapshots() {
  await setStorage({
    [STORAGE_KEYS.snapshots]: state.snapshots
  });
}

function ensureTargetPage() {
  if (!isTargetPage()) {
    throw new Error("Open https://medium.com/me/stats to use this extension.");
  }
}

function syncPanelVisibilityToRoute() {
  const wrapper = document.getElementById(PANEL_IDS.wrapper);
  if (!wrapper) {
    return;
  }

  if (isTargetPage()) {
    wrapper.style.display = "";
    return;
  }

  togglePanel(false);
  wrapper.style.display = "none";
}

function startRouteWatcher() {
  if (state.routeWatcherStarted) {
    return;
  }

  state.routeWatcherStarted = true;
  state.lastSeenUrl = window.location.href;

  const checkForRouteChange = () => {
    const currentUrl = window.location.href;
    if (currentUrl === state.lastSeenUrl) {
      return;
    }
    state.lastSeenUrl = currentUrl;
    syncPanelVisibilityToRoute();
  };

  window.addEventListener("popstate", checkForRouteChange);
  window.addEventListener("hashchange", checkForRouteChange);

  state.routeCheckTimer = window.setInterval(checkForRouteChange, ROUTE_CHECK_INTERVAL_MS);
}

async function captureSnapshot(mode, preferredStorageMode = "auto", triggerButtonId = "") {
  ensureTargetPage();
  const captureLabel = preferredStorageMode === "full"
    ? "full snapshot"
    : preferredStorageMode === "sparse"
      ? "delta snapshot"
      : "snapshot";
  setStatus(`Creating ${captureLabel} now...`);
  setSnapshotCaptureUiBusy(true, triggerButtonId);

  try {
    if (preferredStorageMode === "sparse" && !hasAnyPriorSnapshot()) {
      throw new Error("Delta snapshot requires at least one prior snapshot. Capture a full snapshot first.");
    }

    await autoScrollForDataRows();

    if (!hasAnyStatsMetricValueOnPage()) {
      throw new Error("Snapshot not saved: stats values (Presentations, Views, Reads, Earnings) are not visible on the page yet.");
    }

    const rows = extractStoryRows();
    if (!rows.length) {
      throw new Error("No story rows found. Confirm you are logged into Medium and your stats page is loaded.");
    }

    const integrityError = validateSnapshotIntegrity(rows);
    if (integrityError) {
      throw new Error(`${integrityError} Snapshot not saved.`);
    }

    const latestSnapshot = findLatestSnapshot();
    const previousSnapshot = latestSnapshot ? getSnapshotById(latestSnapshot.id) : null;
    const readDecreases = findReadDecreasesComparedToSnapshot(rows, previousSnapshot);
    if (readDecreases.length) {
      const sample = readDecreases[0];
      throw new Error(
        `Snapshot not saved: Reads decreased for ${readDecreases.length} story(s) vs previous snapshot (example: ${formatStoryTitleForDisplay(sample.storyName)} ${formatNumber(sample.previousReads)} -> ${formatNumber(sample.currentReads)}). Refresh stats and ensure the same Medium date filter before capturing.`
      );
    }

    const snapshot = buildSnapshot(rows, mode, preferredStorageMode);
    state.snapshots.push(snapshot);
    state.snapshots.sort((a, b) => new Date(a.capturedAt).getTime() - new Date(b.capturedAt).getTime());
    await persistSnapshots();
    refreshPanelData();
    const storyCountLabel = snapshot.storageMode === "sparse"
      ? `${snapshot.stories.length} changed story record(s)`
      : `${snapshot.stories.length} stories`;
    setStatus(`Snapshot captured: ${storyCountLabel} (${mode}, ${snapshot.storageMode}).`);
  } finally {
    setSnapshotCaptureUiBusy(false);
  }
}

function getSnapshotById(id) {
  if (!id) {
    return null;
  }
  ensureMaterializedSnapshotCache();
  return state.materializedSnapshotsById.get(id) || null;
}

function findDefaultComparison() {
  if (state.snapshots.length < 2) {
    return [null, null];
  }

  const latest = state.snapshots[state.snapshots.length - 1];
  const latestDate = toDateKey(latest.capturedAt);

  let priorDayKey = null;
  for (let i = state.snapshots.length - 2; i >= 0; i -= 1) {
    const candidateDate = toDateKey(state.snapshots[i].capturedAt);
    if (candidateDate !== latestDate) {
      priorDayKey = candidateDate;
      break;
    }
  }

  // Daily baseline rule:
  // 1) earliest snapshot from the most recent prior day, if any
  // 2) otherwise first snapshot from the current day
  if (priorDayKey) {
    for (let i = 0; i < state.snapshots.length; i += 1) {
      const candidate = state.snapshots[i];
      if (toDateKey(candidate.capturedAt) === priorDayKey) {
        return [candidate.id, latest.id];
      }
    }
  }

  for (let i = 0; i < state.snapshots.length; i += 1) {
    const candidate = state.snapshots[i];
    if (toDateKey(candidate.capturedAt) === latestDate) {
      return [candidate.id, latest.id];
    }
  }

  return [state.snapshots[0].id, latest.id];
}

function findCompareDatesDefault() {
  if (state.snapshots.length < 2) {
    return [null, null];
  }

  // Snapshots are maintained in ascending timestamp order.
  // Compare Dates default should span the full available range:
  // earliest snapshot from earliest date -> latest snapshot from latest date.
  const earliest = state.snapshots[0];
  const latest = state.snapshots[state.snapshots.length - 1];
  return [earliest.id, latest.id];
}

function getStoryKey(story) {
  if (story.storyId) {
    return `id:${story.storyId}`;
  }
  return `name:${story.storyName.toLowerCase()}`;
}

function buildStoryMap(snapshot) {
  const map = new Map();
  snapshot.stories.forEach((story) => {
    map.set(getStoryKey(story), story);
  });
  return map;
}

function normalizeComparisonStoryName(storyName) {
  return sanitizeText(formatStoryTitleForDisplay(storyName || "")).toLowerCase();
}

function getComparisonIdentity(story) {
  const rawStoryId = String(story && story.storyId ? story.storyId : "").trim();
  const urlStoryId = getStoryIdFromUrl(story && story.mediumUrl ? story.mediumUrl : "");
  const storyId = rawStoryId || urlStoryId || "";

  let urlKey = "";
  const statsUrl = getStatsPostUrl(story);
  if (statsUrl) {
    try {
      const parsed = new URL(statsUrl);
      urlKey = `${parsed.origin}${parsed.pathname}`.toLowerCase();
    } catch {
      urlKey = String(statsUrl || "").trim().toLowerCase();
    }
  }

  return {
    idKey: storyId ? `id:${storyId.toLowerCase()}` : "",
    urlKey: urlKey ? `url:${urlKey}` : "",
    nameKey: `name:${normalizeComparisonStoryName(story && story.storyName ? story.storyName : "")}`
  };
}

function buildComparisonIndex(stories) {
  const idMap = new Map();
  const urlMap = new Map();
  const nameMap = new Map();
  const identities = [];

  stories.forEach((story, index) => {
    const identity = getComparisonIdentity(story);
    identities.push(identity);

    if (identity.idKey) {
      if (!idMap.has(identity.idKey)) {
        idMap.set(identity.idKey, []);
      }
      idMap.get(identity.idKey).push(index);
    }

    if (identity.urlKey) {
      if (!urlMap.has(identity.urlKey)) {
        urlMap.set(identity.urlKey, []);
      }
      urlMap.get(identity.urlKey).push(index);
    }

    if (identity.nameKey) {
      if (!nameMap.has(identity.nameKey)) {
        nameMap.set(identity.nameKey, []);
      }
      nameMap.get(identity.nameKey).push(index);
    }
  });

  return { idMap, urlMap, nameMap, identities };
}

function findFirstAvailableIndex(indexList, usedSet) {
  if (!Array.isArray(indexList)) {
    return -1;
  }
  for (let i = 0; i < indexList.length; i += 1) {
    const idx = indexList[i];
    if (!usedSet.has(idx)) {
      return idx;
    }
  }
  return -1;
}

function computeDiffRows(baseSnapshot, targetSnapshot) {
  const baseStories = Array.isArray(baseSnapshot && baseSnapshot.stories) ? baseSnapshot.stories : [];
  const targetStories = Array.isArray(targetSnapshot && targetSnapshot.stories) ? targetSnapshot.stories : [];
  const targetIndex = buildComparisonIndex(targetStories);
  const usedTargetIndexes = new Set();

  const delta = (x, y) => {
    if (x === null || x === undefined || y === null || y === undefined) {
      return null;
    }
    return y - x;
  };

  const pct = (x, y) => {
    if (x === null || x === undefined || y === null || y === undefined || x === 0) {
      return null;
    }
    return ((y - x) / Math.abs(x)) * 100;
  };

  const pushDiffRow = (a, b) => {
    const storyName = (b && b.storyName) || (a && a.storyName) || "(Unknown Story)";
    const storyUrl = (b && getStatsPostUrl(b)) || (a && getStatsPostUrl(a)) || "";
    const status = !a && b ? "new" : a && !b ? "removed" : "existing";

    diffRows.push({
      storyName,
      storyUrl,
      status,
      presentationsA: a ? a.presentations : null,
      presentationsB: b ? b.presentations : null,
      presentationsDelta: delta(a ? a.presentations : null, b ? b.presentations : null),
      presentationsPct: pct(a ? a.presentations : null, b ? b.presentations : null),
      viewsA: a ? a.views : null,
      viewsB: b ? b.views : null,
      viewsDelta: delta(a ? a.views : null, b ? b.views : null),
      viewsPct: pct(a ? a.views : null, b ? b.views : null),
      readsA: a ? a.reads : null,
      readsB: b ? b.reads : null,
      readsDelta: delta(a ? a.reads : null, b ? b.reads : null),
      readsPct: pct(a ? a.reads : null, b ? b.reads : null),
      earningsA: a ? a.earnings : null,
      earningsB: b ? b.earnings : null,
      earningsDelta: delta(a ? a.earnings : null, b ? b.earnings : null),
      earningsPct: pct(a ? a.earnings : null, b ? b.earnings : null)
    });
  };

  const diffRows = [];
  baseStories.forEach((baseStory) => {
    const identity = getComparisonIdentity(baseStory);

    let targetIndexMatch = -1;
    if (identity.idKey) {
      targetIndexMatch = findFirstAvailableIndex(targetIndex.idMap.get(identity.idKey), usedTargetIndexes);
    }
    if (targetIndexMatch < 0 && identity.urlKey) {
      targetIndexMatch = findFirstAvailableIndex(targetIndex.urlMap.get(identity.urlKey), usedTargetIndexes);
    }
    if (targetIndexMatch < 0 && identity.nameKey) {
      targetIndexMatch = findFirstAvailableIndex(targetIndex.nameMap.get(identity.nameKey), usedTargetIndexes);
    }

    if (targetIndexMatch >= 0) {
      usedTargetIndexes.add(targetIndexMatch);
      pushDiffRow(baseStory, targetStories[targetIndexMatch]);
      return;
    }

    pushDiffRow(baseStory, null);
  });

  targetStories.forEach((targetStory, index) => {
    if (usedTargetIndexes.has(index)) {
      return;
    }
    pushDiffRow(null, targetStory);
  });

  diffRows.sort((x, y) => {
    if (x.status !== y.status) {
      return x.status.localeCompare(y.status);
    }
    return x.storyName.localeCompare(y.storyName);
  });

  return diffRows;
}

function toneClass(value) {
  if (value === null || value === undefined || Number.isNaN(value) || value === 0) {
    return "mw-neutral";
  }
  return value > 0 ? "mw-pos" : "mw-neg";
}

function hasDeltaChange(value) {
  return value !== null && value !== undefined && !Number.isNaN(value) && Math.abs(value) > CHANGE_EPSILON;
}

function getDailySummaryMetricFilters() {
  return {
    presentations: state.dailyFilterPresentationsEl ? state.dailyFilterPresentationsEl.checked : true,
    views: state.dailyFilterViewsEl ? state.dailyFilterViewsEl.checked : true,
    reads: state.dailyFilterReadsEl ? state.dailyFilterReadsEl.checked : true,
    earnings: state.dailyFilterEarningsEl ? state.dailyFilterEarningsEl.checked : true
  };
}

function getCompareMetricFilters() {
  return {
    presentations: state.compareFilterPresentationsEl ? state.compareFilterPresentationsEl.checked : true,
    views: state.compareFilterViewsEl ? state.compareFilterViewsEl.checked : true,
    reads: state.compareFilterReadsEl ? state.compareFilterReadsEl.checked : true,
    earnings: state.compareFilterEarningsEl ? state.compareFilterEarningsEl.checked : true
  };
}

function hasAnyTrackedChange(row, metricFilters) {
  const filters = metricFilters || getDailySummaryMetricFilters();
  const trackedDeltas = [];

  if (filters.presentations) {
    trackedDeltas.push(row.presentationsDelta);
  }
  if (filters.views) {
    trackedDeltas.push(row.viewsDelta);
  }
  if (filters.reads) {
    trackedDeltas.push(row.readsDelta);
  }
  if (filters.earnings) {
    trackedDeltas.push(row.earningsDelta);
  }

  if (!trackedDeltas.length) {
    return false;
  }

  return trackedDeltas.some((value) => hasDeltaChange(value));
}

function renderDailyChangesSummary() {
  if (!state.dailySummaryEl) {
    return;
  }

  const [baseId, targetId] = findDefaultComparison();
  if (!baseId || !targetId) {
    state.dailySummaryEl.innerHTML = "<div class='mw-empty'>Need at least two snapshots to show daily changes.</div>";
    return;
  }

  const baseSnapshot = getSnapshotById(baseId);
  const targetSnapshot = getSnapshotById(targetId);
  if (!baseSnapshot || !targetSnapshot) {
    state.dailySummaryEl.innerHTML = "<div class='mw-empty'>Unable to load baseline snapshots.</div>";
    return;
  }

  const diffRows = computeDiffRows(baseSnapshot, targetSnapshot);
  const invalidReadRows = diffRows.filter((row) => row.readsDelta !== null && row.readsDelta < -CHANGE_EPSILON);
  const invalidWarningHtml = invalidReadRows.length
    ? `
      <div class="mw-warning">
        Invalid comparison: Reads decreased for ${invalidReadRows.length} stor${invalidReadRows.length === 1 ? "y" : "ies"}, which should not happen for cumulative reads. Review Medium filters and recapture snapshots.
      </div>
    `
    : "";

  const metricFilters = getDailySummaryMetricFilters();
  if (!Object.values(metricFilters).some(Boolean)) {
    state.dailySummaryEl.innerHTML = `
      <div class="mw-summary-head">Comparing ${formatTimestamp(baseSnapshot.capturedAt)} to ${formatTimestamp(targetSnapshot.capturedAt)}</div>
      ${invalidWarningHtml}
      <div class='mw-empty'>Enable at least one metric filter to show stories.</div>
    `;
    return;
  }

  const changedRows = diffRows
    .filter((row) => hasAnyTrackedChange(row, metricFilters))
    .sort((a, b) => {
      const earningsA = Math.abs(a.earningsDelta || 0);
      const earningsB = Math.abs(b.earningsDelta || 0);
      if (earningsA !== earningsB) {
        return earningsB - earningsA;
      }
      const readsA = Math.abs(a.readsDelta || 0);
      const readsB = Math.abs(b.readsDelta || 0);
      if (readsA !== readsB) {
        return readsB - readsA;
      }
      return a.storyName.localeCompare(b.storyName);
    });

  if (!changedRows.length) {
    state.dailySummaryEl.innerHTML = `
      <div class="mw-summary-head">Comparing ${formatTimestamp(baseSnapshot.capturedAt)} to ${formatTimestamp(targetSnapshot.capturedAt)}</div>
      ${invalidWarningHtml}
      <div class='mw-empty'>No tracked changes detected across stories.</div>
    `;
    return;
  }

  const items = changedRows.map((row) => {
    const presentationsTone = toneClass(row.presentationsDelta);
    const viewsTone = toneClass(row.viewsDelta);
    const readsTone = toneClass(row.readsDelta);
    const earningsTone = toneClass(row.earningsDelta);
    const statusText = row.status === "existing" ? "changed" : row.status;

    return `
      <div class="mw-change-item">
        <div class="mw-change-title">${renderStoryTitleHtml(row.storyName, row.storyUrl)}</div>
        <div class="mw-change-meta">status: ${statusText}</div>
        <div class="mw-change-deltas">
          <span class="${presentationsTone}">Presentations ${formatSignedNumber(row.presentationsDelta)}</span>
          <span class="${viewsTone}">Views ${formatSignedNumber(row.viewsDelta)}</span>
          <span class="${readsTone}">Reads ${formatSignedNumber(row.readsDelta)}</span>
          <span class="${earningsTone}">Earnings ${formatSignedCurrency(row.earningsDelta)}</span>
        </div>
      </div>
    `;
  }).join("");

  state.dailySummaryEl.innerHTML = `
    <div class="mw-summary-head">Comparing ${formatTimestamp(baseSnapshot.capturedAt)} to ${formatTimestamp(targetSnapshot.capturedAt)}</div>
    ${invalidWarningHtml}
    <div class="mw-summary-count">Stories with changes: ${changedRows.length}</div>
    <div class="mw-change-list">${items}</div>
  `;
}

function hasPositiveDailyReadOrEarningsChange() {
  const [baseId, targetId] = findDefaultComparison();
  if (!baseId || !targetId) {
    return false;
  }

  const baseSnapshot = getSnapshotById(baseId);
  const targetSnapshot = getSnapshotById(targetId);
  if (!baseSnapshot || !targetSnapshot) {
    return false;
  }

  const rows = computeDiffRows(baseSnapshot, targetSnapshot);
  return rows.some((row) => (row.readsDelta !== null && row.readsDelta > 0) || (row.earningsDelta !== null && row.earningsDelta > 0));
}

function updateLauncherSignal() {
  if (!state.launcherEl) {
    return;
  }

  const hasIncrease = hasPositiveDailyReadOrEarningsChange();
  if (hasIncrease) {
    state.launcherEl.style.background = "#b7e4c7";
    state.launcherEl.style.borderColor = "#2d6a4f";
    state.launcherEl.style.color = "#1b4332";
    state.launcherEl.title = "Open Writer Success Stats for Medium (reads/earnings increased since prior day)";
    return;
  }

  state.launcherEl.style.background = "#fff";
  state.launcherEl.style.borderColor = "#111";
  state.launcherEl.style.color = "#111";
  state.launcherEl.title = "Open Writer Success Stats for Medium";
}

function getSortIndicator(sortKey) {
  if (state.compareSortKey !== sortKey) {
    return "";
  }
  return state.compareSortDirection === "asc" ? " ▲" : " ▼";
}

function compareNullableNumbers(a, b, direction) {
  const aMissing = a === null || a === undefined || Number.isNaN(a);
  const bMissing = b === null || b === undefined || Number.isNaN(b);

  if (aMissing && bMissing) {
    return 0;
  }
  if (aMissing) {
    return 1;
  }
  if (bMissing) {
    return -1;
  }

  if (a === b) {
    return 0;
  }

  if (direction === "asc") {
    return a < b ? -1 : 1;
  }
  return a > b ? -1 : 1;
}

function sortCompareRows(rows) {
  if (!state.compareSortKey) {
    return rows;
  }

  const key = state.compareSortKey;
  const direction = state.compareSortDirection;

  return [...rows].sort((a, b) => {
    if (key === "storyName" || key === "status") {
      const left = String(a[key] || "");
      const right = String(b[key] || "");
      const cmp = left.localeCompare(right);
      if (cmp === 0) {
        return 0;
      }
      return direction === "asc" ? cmp : -cmp;
    }

    const numericCmp = compareNullableNumbers(a[key], b[key], direction);
    if (numericCmp !== 0) {
      return numericCmp;
    }

    return String(a.storyName || "").localeCompare(String(b.storyName || ""));
  });
}

function toggleCompareSort(sortKey) {
  if (!sortKey) {
    return;
  }

  if (state.compareSortKey === sortKey) {
    state.compareSortDirection = state.compareSortDirection === "asc" ? "desc" : "asc";
  } else {
    state.compareSortKey = sortKey;
    state.compareSortDirection = sortKey === "storyName" || sortKey === "status" ? "asc" : "desc";
  }

  scheduleCompareRender();
}

function scheduleCompareRender() {
  if (state.compareRenderTimer) {
    window.clearTimeout(state.compareRenderTimer);
  }

  state.compareRenderTimer = window.setTimeout(() => {
    state.compareRenderTimer = null;
    renderDiff(state.selectCompareA ? state.selectCompareA.value : "", state.selectCompareB ? state.selectCompareB.value : "");
  }, COMPARE_AUTO_RENDER_DEBOUNCE_MS);
}

function renderDiff(baseId, targetId) {
  if (!state.diffContainerEl) {
    return;
  }
  const baseSnapshot = getSnapshotById(baseId);
  const targetSnapshot = getSnapshotById(targetId);

  if (!baseSnapshot || !targetSnapshot) {
    state.diffContainerEl.innerHTML = "<div class='mw-empty'>Select two snapshots to compare.</div>";
    return;
  }

  const metricFilters = getCompareMetricFilters();
  if (!Object.values(metricFilters).some(Boolean)) {
    state.diffContainerEl.innerHTML = "<div class='mw-empty'>Enable at least one Compare filter to show stories.</div>";
    return;
  }

  const filteredRows = computeDiffRows(baseSnapshot, targetSnapshot)
    .filter((row) => hasAnyTrackedChange(row, metricFilters));
  const rows = sortCompareRows(filteredRows);

  const totals = {
    presentations: 0,
    views: 0,
    reads: 0,
    earnings: 0
  };

  rows.forEach((row) => {
    if (metricFilters.presentations && row.presentationsDelta !== null && row.presentationsDelta !== undefined) {
      totals.presentations += row.presentationsDelta;
    }
    if (metricFilters.views && row.viewsDelta !== null && row.viewsDelta !== undefined) {
      totals.views += row.viewsDelta;
    }
    if (metricFilters.reads && row.readsDelta !== null && row.readsDelta !== undefined) {
      totals.reads += row.readsDelta;
    }
    if (metricFilters.earnings && row.earningsDelta !== null && row.earningsDelta !== undefined) {
      totals.earnings += row.earningsDelta;
    }
  });

  const totalsItems = [];
  if (metricFilters.presentations) {
    totalsItems.push(`<span class="mw-compare-total-item ${toneClass(totals.presentations)}">Presentations ${formatSignedNumber(totals.presentations)}</span>`);
  }
  if (metricFilters.views) {
    totalsItems.push(`<span class="mw-compare-total-item ${toneClass(totals.views)}">Views ${formatSignedNumber(totals.views)}</span>`);
  }
  if (metricFilters.reads) {
    totalsItems.push(`<span class="mw-compare-total-item ${toneClass(totals.reads)}">Reads ${formatSignedNumber(totals.reads)}</span>`);
  }
  if (metricFilters.earnings) {
    totalsItems.push(`<span class="mw-compare-total-item ${toneClass(totals.earnings)}">Earnings ${formatSignedCurrency(totals.earnings)}</span>`);
  }

  const header = `
    <div class="mw-compare-head">
      <div class="mw-compare-title">Comparing ${formatTimestamp(baseSnapshot.capturedAt)} to ${formatTimestamp(targetSnapshot.capturedAt)}</div>
      <div class="mw-compare-totals-box">
        <div class="mw-compare-totals-label">Totals (${rows.length} stories)</div>
        <div class="mw-compare-totals-items">${totalsItems.join("")}</div>
      </div>
    </div>
  `;

  const tableRows = rows.map((row) => `
    <tr>
      <td>${renderStoryTitleHtml(row.storyName, row.storyUrl)}</td>
      <td>${row.status}</td>
      <td>${formatNumber(row.viewsA)}</td>
      <td>${formatNumber(row.viewsB)}</td>
      <td class="${toneClass(row.viewsDelta)}">${formatSignedNumber(row.viewsDelta)}</td>
      <td>${formatNumber(row.readsA)}</td>
      <td>${formatNumber(row.readsB)}</td>
      <td class="${toneClass(row.readsDelta)}">${formatSignedNumber(row.readsDelta)}</td>
      <td>${formatCurrency(row.earningsA)}</td>
      <td>${formatCurrency(row.earningsB)}</td>
      <td class="${toneClass(row.earningsDelta)}">${formatSignedCurrency(row.earningsDelta)}</td>
    </tr>
  `).join("");

  state.diffContainerEl.innerHTML = `
    ${header}
    <div class="mw-table-wrap">
      <table class="mw-table">
        <thead>
          <tr>
            <th class="mw-sortable" data-sort-key="storyName">Story${getSortIndicator("storyName")}</th>
            <th class="mw-sortable" data-sort-key="status">Status${getSortIndicator("status")}</th>
            <th class="mw-sortable" data-sort-key="viewsA">Views A${getSortIndicator("viewsA")}</th>
            <th class="mw-sortable" data-sort-key="viewsB">Views B${getSortIndicator("viewsB")}</th>
            <th class="mw-sortable" data-sort-key="viewsDelta">Views Δ${getSortIndicator("viewsDelta")}</th>
            <th class="mw-sortable" data-sort-key="readsA">Reads A${getSortIndicator("readsA")}</th>
            <th class="mw-sortable" data-sort-key="readsB">Reads B${getSortIndicator("readsB")}</th>
            <th class="mw-sortable" data-sort-key="readsDelta">Reads Δ${getSortIndicator("readsDelta")}</th>
            <th class="mw-sortable" data-sort-key="earningsA">Earnings A${getSortIndicator("earningsA")}</th>
            <th class="mw-sortable" data-sort-key="earningsB">Earnings B${getSortIndicator("earningsB")}</th>
            <th class="mw-sortable" data-sort-key="earningsDelta">Earnings Δ${getSortIndicator("earningsDelta")}</th>
          </tr>
        </thead>
        <tbody>
          ${tableRows || "<tr><td colspan='11'>No comparable rows found.</td></tr>"}
        </tbody>
      </table>
    </div>
  `;
}

function analyzeSnapshotQuality(snapshot) {
  const stories = Array.isArray(snapshot && snapshot.stories) ? snapshot.stories : [];
  const total = stories.length;
  if (!total) {
    return {
      total,
      missingIdentity: 0,
      missingCoreMetrics: 0,
      readsGreaterThanViews: 0,
      duplicateIdentity: 0,
      score: 0
    };
  }

  let missingIdentity = 0;
  let missingCoreMetrics = 0;
  let readsGreaterThanViews = 0;
  let duplicateIdentity = 0;
  const seenIdentities = new Set();

  stories.forEach((story) => {
    const identity = getComparisonIdentity(story);
    const primaryIdentity = identity.idKey || identity.urlKey || identity.nameKey;

    if (!identity.idKey && !identity.urlKey) {
      missingIdentity += 1;
    }

    if (!Number.isFinite(Number(story.views)) || !Number.isFinite(Number(story.reads)) || !Number.isFinite(Number(story.earnings))) {
      missingCoreMetrics += 1;
    }

    const views = Number(story.views);
    const reads = Number(story.reads);
    if (Number.isFinite(views) && Number.isFinite(reads) && reads - views > CHANGE_EPSILON) {
      readsGreaterThanViews += 1;
    }

    if (seenIdentities.has(primaryIdentity)) {
      duplicateIdentity += 1;
    } else {
      seenIdentities.add(primaryIdentity);
    }
  });

  const missingIdentityRate = missingIdentity / total;
  const missingCoreRate = missingCoreMetrics / total;
  const readsGreaterRate = readsGreaterThanViews / total;
  const duplicateRate = duplicateIdentity / total;

  const score = Math.max(
    0,
    Math.round(
      100
      - missingIdentityRate * 25
      - missingCoreRate * 35
      - readsGreaterRate * 20
      - duplicateRate * 20
    )
  );

  return {
    total,
    missingIdentity,
    missingCoreMetrics,
    readsGreaterThanViews,
    duplicateIdentity,
    score
  };
}

function getQualityLabel(score) {
  if (score >= 85) {
    return "Excellent";
  }
  if (score >= 70) {
    return "Good";
  }
  if (score >= 50) {
    return "Fair";
  }
  return "Poor";
}

function getQualityToneClass(score) {
  if (score >= 70) {
    return "mw-pos";
  }
  if (score >= 50) {
    return "mw-neutral";
  }
  return "mw-neg";
}

function buildSnapshotAuditReport(baseSnapshot, targetSnapshot) {
  const rows = computeDiffRows(baseSnapshot, targetSnapshot)
    .filter((row) => row.status === "existing")
    .sort((a, b) => a.storyName.localeCompare(b.storyName));

  const suspicious = rows.filter((row) => {
    const negativeReads = row.readsDelta !== null && row.readsDelta < -CHANGE_EPSILON;
    const readsEqualsViewsInTarget =
      row.viewsB !== null && row.readsB !== null && Math.abs(row.viewsB - row.readsB) <= CHANGE_EPSILON;
    const earningsDroppedToZero =
      row.earningsA !== null && row.earningsA > CHANGE_EPSILON && row.earningsB !== null && Math.abs(row.earningsB) <= CHANGE_EPSILON;
    return negativeReads || (readsEqualsViewsInTarget && earningsDroppedToZero);
  });

  const baseQuality = analyzeSnapshotQuality(baseSnapshot);
  const targetQuality = analyzeSnapshotQuality(targetSnapshot);

  const baseTotal = Array.isArray(baseSnapshot.stories) ? baseSnapshot.stories.length : 0;
  const targetTotal = Array.isArray(targetSnapshot.stories) ? targetSnapshot.stories.length : 0;
  const largerSnapshotSize = Math.max(baseTotal, targetTotal, 1);
  const overlapRate = rows.length / largerSnapshotSize;
  const suspiciousRate = rows.length ? suspicious.length / rows.length : 1;

  const pairScore = Math.max(
    0,
    Math.round(
      100
      - (1 - overlapRate) * 55
      - suspiciousRate * 45
    )
  );

  return {
    rows,
    suspicious,
    baseQuality,
    targetQuality,
    baseTotal,
    targetTotal,
    overlapRate,
    suspiciousRate,
    overlapPercent: Math.round(overlapRate * 100),
    suspiciousPercent: rows.length ? Math.round(suspiciousRate * 100) : 100,
    pairScore,
    pairLabel: getQualityLabel(pairScore),
    pairTone: getQualityToneClass(pairScore)
  };
}

function renderSnapshotAudit(baseId, targetId) {
  if (!state.auditContainerEl) {
    return;
  }

  const baseSnapshot = getSnapshotById(baseId);
  const targetSnapshot = getSnapshotById(targetId);
  if (!baseSnapshot || !targetSnapshot) {
    state.auditContainerEl.innerHTML = "<div class='mw-empty'>Select two snapshots to inspect raw stored values.</div>";
    return;
  }

  const audit = buildSnapshotAuditReport(baseSnapshot, targetSnapshot);
  const { rows, suspicious, baseQuality, targetQuality } = audit;

  const header = `
    <div class="mw-summary-head">Snapshot Audit: ${formatTimestamp(baseSnapshot.capturedAt)} to ${formatTimestamp(targetSnapshot.capturedAt)}</div>
    <div class="mw-summary-count">Existing stories: ${rows.length}. Suspicious rows: ${suspicious.length}.</div>
    <div class="mw-summary-count ${audit.pairTone}">Pair Quality: ${audit.pairScore}/100 (${audit.pairLabel}) • Overlap ${audit.overlapPercent}% • Suspicious ${audit.suspiciousPercent}%</div>
    <div class="mw-summary-count">
      Base Quality: <span class="${getQualityToneClass(baseQuality.score)}">${baseQuality.score}/100 (${getQualityLabel(baseQuality.score)})</span>
      • Target Quality: <span class="${getQualityToneClass(targetQuality.score)}">${targetQuality.score}/100 (${getQualityLabel(targetQuality.score)})</span>
    </div>
    <div class="mw-summary-count">
      Base checks: missing identity ${baseQuality.missingIdentity}, missing core metrics ${baseQuality.missingCoreMetrics}, reads>views ${baseQuality.readsGreaterThanViews}, duplicate identity ${baseQuality.duplicateIdentity}.
    </div>
    <div class="mw-summary-count">
      Target checks: missing identity ${targetQuality.missingIdentity}, missing core metrics ${targetQuality.missingCoreMetrics}, reads>views ${targetQuality.readsGreaterThanViews}, duplicate identity ${targetQuality.duplicateIdentity}.
    </div>
  `;

  if (!rows.length) {
    state.auditContainerEl.innerHTML = `${header}<div class='mw-empty'>No overlapping stories between these snapshots.</div>`;
    return;
  }

  const suspiciousRowsHtml = suspicious.map((row) => `
    <tr>
      <td>${renderStoryTitleHtml(row.storyName, row.storyUrl)}</td>
      <td>${formatNumber(row.viewsA)}</td>
      <td>${formatNumber(row.viewsB)}</td>
      <td>${formatNumber(row.readsA)}</td>
      <td>${formatNumber(row.readsB)}</td>
      <td class="${toneClass(row.readsDelta)}">${formatSignedNumber(row.readsDelta)}</td>
      <td>${formatCurrency(row.earningsA)}</td>
      <td>${formatCurrency(row.earningsB)}</td>
      <td class="${toneClass(row.earningsDelta)}">${formatSignedCurrency(row.earningsDelta)}</td>
    </tr>
  `).join("");

  state.auditContainerEl.innerHTML = `
    ${header}
    ${suspicious.length ? "" : "<div class='mw-empty'>No suspicious row patterns detected for this snapshot pair.</div>"}
    ${
      suspicious.length
        ? `
      <div class="mw-table-wrap">
        <table class="mw-table">
          <thead>
            <tr>
              <th>Story</th>
              <th>Views A</th>
              <th>Views B</th>
              <th>Reads A</th>
              <th>Reads B</th>
              <th>Reads Delta</th>
              <th>Earnings A</th>
              <th>Earnings B</th>
              <th>Earnings Delta</th>
            </tr>
          </thead>
          <tbody>
            ${suspiciousRowsHtml}
          </tbody>
        </table>
      </div>
    `
        : ""
    }
  `;
}

async function exportSnapshotAuditJson(baseId, targetId) {
  const baseSnapshot = getSnapshotById(baseId);
  const targetSnapshot = getSnapshotById(targetId);
  if (!baseSnapshot || !targetSnapshot) {
    throw new Error("Select valid A/B snapshots before exporting audit JSON.");
  }

  const audit = buildSnapshotAuditReport(baseSnapshot, targetSnapshot);
  const payload = {
    exportedAt: nowIso(),
    type: "snapshot-audit-report",
    baseSnapshotId: baseId,
    targetSnapshotId: targetId,
    baseCapturedAt: baseSnapshot.capturedAt,
    targetCapturedAt: targetSnapshot.capturedAt,
    pairQuality: {
      score: audit.pairScore,
      label: audit.pairLabel,
      overlapPercent: audit.overlapPercent,
      suspiciousPercent: audit.suspiciousPercent,
      existingStories: audit.rows.length,
      suspiciousStories: audit.suspicious.length
    },
    snapshotQuality: {
      base: audit.baseQuality,
      target: audit.targetQuality
    },
    suspiciousRows: audit.suspicious.map((row) => ({
      storyName: row.storyName,
      storyUrl: row.storyUrl,
      viewsA: row.viewsA,
      viewsB: row.viewsB,
      readsA: row.readsA,
      readsB: row.readsB,
      readsDelta: row.readsDelta,
      earningsA: row.earningsA,
      earningsB: row.earningsB,
      earningsDelta: row.earningsDelta
    }))
  };

  const json = JSON.stringify(payload, null, 2);
  const outputEl = document.getElementById("mw-export-json-output");
  if (outputEl) {
    outputEl.value = json;
  }

  let copied = false;
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(json);
      copied = true;
    } catch {
      copied = false;
    }
  }

  if (!copied && outputEl) {
    outputEl.focus();
    outputEl.select();
  }

  setStatus(
    copied
      ? "Audit report JSON exported and copied to clipboard."
      : "Audit report JSON exported. Clipboard unavailable; copy from the text box.",
    false
  );
}

function buildSnapshotExportPayload(baseId, targetId) {
  const baseSnapshot = getSnapshotById(baseId);
  const targetSnapshot = getSnapshotById(targetId);
  if (!baseSnapshot || !targetSnapshot) {
    return null;
  }

  return {
    exportedAt: nowIso(),
    baseSnapshotId: baseId,
    targetSnapshotId: targetId,
    baseSnapshot,
    targetSnapshot
  };
}

async function exportSelectedSnapshotsJson(baseId, targetId) {
  const payload = buildSnapshotExportPayload(baseId, targetId);
  if (!payload) {
    throw new Error("Select valid A/B snapshots before exporting.");
  }

  const json = JSON.stringify(payload, null, 2);
  const outputEl = document.getElementById("mw-export-json-output");
  if (outputEl) {
    outputEl.value = json;
  }

  let copied = false;
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(json);
      copied = true;
    } catch {
      copied = false;
    }
  }

  if (!copied && outputEl) {
    outputEl.focus();
    outputEl.select();
  }

  setStatus(
    copied
      ? "A/B snapshot JSON exported and copied to clipboard."
      : "A/B snapshot JSON exported. Clipboard unavailable; copy from the text box.",
    false
  );
}

async function exportAllSnapshotsJson() {
  const result = await getStorage([STORAGE_KEYS.snapshots, STORAGE_KEYS.lastAutoSnapshotDate]);
  const payload = {
    exportedAt: nowIso(),
    mwSnapshots: Array.isArray(result[STORAGE_KEYS.snapshots]) ? result[STORAGE_KEYS.snapshots] : [],
    mwLastAutoSnapshotDate: result[STORAGE_KEYS.lastAutoSnapshotDate] || ""
  };

  const json = JSON.stringify(payload, null, 2);
  const outputEl = document.getElementById("mw-transfer-json-output");
  if (outputEl) {
    outputEl.value = json;
  }

  let copied = false;
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(json);
      copied = true;
    } catch {
      copied = false;
    }
  }

  if (!copied && outputEl) {
    outputEl.focus();
    outputEl.select();
  }

  setStatus(
    copied
      ? "All snapshots exported and copied to clipboard."
      : "All snapshots exported. Clipboard unavailable; copy from the text box.",
    false
  );
}

async function importAllSnapshotsJson(rawJson) {
  if (!rawJson || !rawJson.trim()) {
    throw new Error("Paste exported JSON into the box before importing.");
  }

  let parsed;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    throw new Error("Import JSON is invalid.");
  }

  const importedSnapshots = Array.isArray(parsed.mwSnapshots) ? parsed.mwSnapshots : [];
  const importedLastAutoDate = parsed.mwLastAutoSnapshotDate || "";

  await setStorage({
    [STORAGE_KEYS.snapshots]: importedSnapshots,
    [STORAGE_KEYS.lastAutoSnapshotDate]: importedLastAutoDate
  });

  state.snapshots = importedSnapshots;
  state.snapshots.sort((a, b) => new Date(a.capturedAt).getTime() - new Date(b.capturedAt).getTime());
  rebuildMaterializedSnapshotCache();
  refreshPanelData();
  setStatus(`Imported ${state.snapshots.length} snapshots.`);
}

function mergeDailyStories(daySnapshots, mergedCapturedAt) {
  const mergedByStoryKey = new Map();

  daySnapshots.forEach((snapshot) => {
    snapshot.stories.forEach((story) => {
      const storyKey = getStoryKey(story);
      const existing = mergedByStoryKey.get(storyKey) || {
        storyName: story.storyName,
        presentations: null,
        views: null,
        reads: null,
        earnings: null,
        mediumUrl: "",
        storyId: ""
      };

      const merged = {
        ...existing,
        storyName: story.storyName || existing.storyName,
        presentations: story.presentations !== null && story.presentations !== undefined ? story.presentations : existing.presentations,
        views: story.views !== null && story.views !== undefined ? story.views : existing.views,
        reads: story.reads !== null && story.reads !== undefined ? story.reads : existing.reads,
        earnings: story.earnings !== null && story.earnings !== undefined ? story.earnings : existing.earnings,
        mediumUrl: story.mediumUrl || existing.mediumUrl,
        storyId: story.storyId || existing.storyId
      };

      mergedByStoryKey.set(storyKey, merged);
    });
  });

  return Array.from(mergedByStoryKey.values())
    .sort((a, b) => a.storyName.localeCompare(b.storyName))
    .map((story) => ({
      key: `${story.storyName}__${mergedCapturedAt}`,
      storyName: story.storyName,
      presentations: story.presentations,
      views: story.views,
      reads: story.reads,
      earnings: story.earnings,
      timestamp: mergedCapturedAt,
      mediumUrl: story.mediumUrl || "",
      storyId: story.storyId || ""
    }));
}

function buildCoalescedDailySnapshots() {
  const materializedSnapshots = getAllMaterializedSnapshots().sort((a, b) => new Date(a.capturedAt).getTime() - new Date(b.capturedAt).getTime());
  const snapshotsByDay = new Map();

  materializedSnapshots.forEach((snapshot) => {
    const dayKey = toDateKey(snapshot.capturedAt);
    if (!snapshotsByDay.has(dayKey)) {
      snapshotsByDay.set(dayKey, []);
    }
    snapshotsByDay.get(dayKey).push(snapshot);
  });

  const dayKeys = Array.from(snapshotsByDay.keys()).sort((a, b) => new Date(a).getTime() - new Date(b).getTime());

  return dayKeys.map((dayKey) => {
    const daySnapshots = snapshotsByDay.get(dayKey) || [];
    daySnapshots.sort((a, b) => new Date(a.capturedAt).getTime() - new Date(b.capturedAt).getTime());
    const lastSnapshot = daySnapshots[daySnapshots.length - 1];
    const mergedCapturedAt = lastSnapshot.capturedAt;
    const mergedStories = mergeDailyStories(daySnapshots, mergedCapturedAt);

    return {
      id: lastSnapshot.id,
      mode: "prune-coalesced",
      capturedAt: mergedCapturedAt,
      sourceUrl: lastSnapshot.sourceUrl,
      storageMode: "full",
      stories: mergedStories
    };
  });
}

async function pruneSnapshotsCoalescedDaily() {
  if (!state.snapshots.length) {
    setStatus("No snapshots available to prune.");
    return;
  }

  const beforeCount = state.snapshots.length;
  const before = [...state.snapshots].sort((a, b) => new Date(a.capturedAt).getTime() - new Date(b.capturedAt).getTime());
  const coalesced = buildCoalescedDailySnapshots();

  const afterCount = coalesced.length;
  const removedCount = beforeCount - afterCount;
  const changedWithoutRemoval =
    removedCount === 0 &&
    (before.some((snapshot, index) => {
      const candidate = coalesced[index];
      if (!candidate) {
        return true;
      }
      if ((snapshot.storageMode || "full") !== candidate.storageMode) {
        return true;
      }
      if ((snapshot.mode || "") !== candidate.mode) {
        return true;
      }
      return (Array.isArray(snapshot.stories) ? snapshot.stories.length : 0) !== (Array.isArray(candidate.stories) ? candidate.stories.length : 0);
    }));

  if (removedCount <= 0 && !changedWithoutRemoval) {
    setStatus("No same-day snapshots to coalesce.");
    return;
  }

  const confirmMessage = `Prune Snapshots will coalesce each day into one merged full snapshot and permanently delete ${removedCount > 0 ? removedCount : 0} snapshot(s).\n\nDo you want to continue?`;
  const confirmed = window.confirm(confirmMessage);
  if (!confirmed) {
    setStatus("Prune canceled.");
    return;
  }

  state.snapshots = coalesced;
  await persistSnapshots();
  refreshPanelData();
  setStatus(`Pruned snapshots: coalesced to ${afterCount} daily snapshot(s), removed ${removedCount > 0 ? removedCount : 0}.`);
}

function getAllStoryNames() {
  const names = new Set();
  getAllMaterializedSnapshots().forEach((snapshot) => {
    snapshot.stories.forEach((story) => names.add(story.storyName));
  });
  return Array.from(names).sort((a, b) => a.localeCompare(b));
}

function getTrendGroupLetter(storyName) {
  const first = String(formatStoryTitleForDisplay(storyName || "")).trim().charAt(0).toUpperCase();
  return /^[A-Z]$/.test(first) ? first : "#";
}

function sanitizeTrendGroupMaxSize(rawValue) {
  const parsed = Number.parseInt(String(rawValue || ""), 10);
  if (!Number.isFinite(parsed)) {
    return DEFAULT_TREND_GROUP_MAX_SIZE;
  }
  if (parsed < MIN_TREND_GROUP_MAX_SIZE) {
    return MIN_TREND_GROUP_MAX_SIZE;
  }
  if (parsed > MAX_TREND_GROUP_MAX_SIZE) {
    return MAX_TREND_GROUP_MAX_SIZE;
  }
  return parsed;
}

function getTrendGroupMaxSize() {
  return sanitizeTrendGroupMaxSize(state.trendGroupMaxSize);
}

async function loadTrendGroupMaxSetting() {
  const result = await getStorage([STORAGE_KEYS.trendGroupMaxSize, STORAGE_KEYS.trendGroupMaxCustomized]);
  const rawValue = result[STORAGE_KEYS.trendGroupMaxSize];
  const customized = !!result[STORAGE_KEYS.trendGroupMaxCustomized];

  if (!customized && Number(rawValue) === 100) {
    state.trendGroupMaxSize = DEFAULT_TREND_GROUP_MAX_SIZE;
    await setStorage({
      [STORAGE_KEYS.trendGroupMaxSize]: state.trendGroupMaxSize,
      [STORAGE_KEYS.trendGroupMaxCustomized]: false
    });
    return;
  }

  state.trendGroupMaxSize = sanitizeTrendGroupMaxSize(rawValue);
}

async function persistTrendGroupMaxSetting() {
  await setStorage({
    [STORAGE_KEYS.trendGroupMaxSize]: getTrendGroupMaxSize(),
    [STORAGE_KEYS.trendGroupMaxCustomized]: true
  });
}

function buildTrendStoryGroups(stories) {
  const maxGroupSize = getTrendGroupMaxSize();
  if (!Array.isArray(stories) || stories.length <= maxGroupSize) {
    return [];
  }

  const byLetter = new Map();
  stories.forEach((storyName) => {
    const letter = getTrendGroupLetter(storyName);
    if (!byLetter.has(letter)) {
      byLetter.set(letter, []);
    }
    byLetter.get(letter).push(storyName);
  });

  const letters = Array.from(byLetter.keys()).sort((a, b) => {
    if (a === "#") {
      return 1;
    }
    if (b === "#") {
      return -1;
    }
    return a.localeCompare(b);
  });

  const groups = [];
  letters.forEach((letter) => {
    const items = byLetter.get(letter) || [];
    if (items.length <= maxGroupSize) {
      groups.push({
        key: letter,
        label: letter,
        stories: items
      });
      return;
    }

    const chunkCount = Math.ceil(items.length / maxGroupSize);
    for (let i = 0; i < chunkCount; i += 1) {
      const label = `${letter}${i + 1}`;
      groups.push({
        key: label,
        label,
        stories: items.slice(i * maxGroupSize, (i + 1) * maxGroupSize)
      });
    }
  });

  return groups;
}

function renderTrendStoryGroupFilters() {
  if (!state.trendFilterContainerEl) {
    return;
  }

  const groups = Array.isArray(state.trendStoryGroups) ? state.trendStoryGroups : [];
  if (!groups.length) {
    state.trendFilterContainerEl.style.display = "none";
    state.trendFilterContainerEl.innerHTML = "";
    return;
  }

  state.trendFilterContainerEl.style.display = "flex";
  state.trendFilterContainerEl.innerHTML = "";

  const groupsByLetter = new Map();
  groups.forEach((group) => {
    const baseLetter = group.key.charAt(0);
    if (!groupsByLetter.has(baseLetter)) {
      groupsByLetter.set(baseLetter, []);
    }
    groupsByLetter.get(baseLetter).push(group);
  });

  for (let i = 0; i < 26; i += 1) {
    const letter = String.fromCharCode(65 + i);
    const letterGroups = groupsByLetter.get(letter) || [];

    if (!letterGroups.length) {
      const emptyButton = document.createElement("button");
      emptyButton.type = "button";
      emptyButton.className = "mw-trend-filter-btn mw-trend-filter-btn-disabled";
      emptyButton.textContent = letter;
      emptyButton.disabled = true;
      state.trendFilterContainerEl.appendChild(emptyButton);
      continue;
    }

    letterGroups.forEach((group) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "mw-trend-filter-btn";
      if (group.key === state.activeTrendStoryGroupKey) {
        button.classList.add("mw-trend-filter-btn-active");
      }
      button.dataset.trendGroupKey = group.key;
      button.textContent = group.label;
      state.trendFilterContainerEl.appendChild(button);
    });
  }

  const symbolGroups = groupsByLetter.get("#") || [];
  symbolGroups.forEach((group) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "mw-trend-filter-btn";
    if (group.key === state.activeTrendStoryGroupKey) {
      button.classList.add("mw-trend-filter-btn-active");
    }
    button.dataset.trendGroupKey = group.key;
    button.textContent = group.label;
    state.trendFilterContainerEl.appendChild(button);
  });
}

function getTrendRows(storyName) {
  if (!storyName) {
    return [];
  }

  const rows = [];
  getAllMaterializedSnapshots().forEach((snapshot) => {
    const hit = snapshot.stories.find((story) => story.storyName === storyName);
    if (hit) {
      rows.push({
        capturedAt: snapshot.capturedAt,
        views: hit.views,
        reads: hit.reads,
        earnings: hit.earnings
      });
    }
  });

  rows.sort((a, b) => new Date(b.capturedAt).getTime() - new Date(a.capturedAt).getTime());

  const todayKey = toDateKey(nowIso());
  const seenPriorDays = new Set();
  return rows.filter((row) => {
    const rowDateKey = toDateKey(row.capturedAt);
    if (rowDateKey === todayKey) {
      return true;
    }
    if (seenPriorDays.has(rowDateKey)) {
      return false;
    }
    seenPriorDays.add(rowDateKey);
    return true;
  });
}

function formatTrendDateLabel(iso) {
  const raw = String(iso || "").trim();
  const dayKeyMatch = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (dayKeyMatch) {
    return `${dayKeyMatch[2]}/${dayKeyMatch[3]}`;
  }

  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return String(iso || "");
  }

  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${month}/${day}`;
}

function buildTrendXPositionsByDay(rowsAsc, left, width) {
  if (!Array.isArray(rowsAsc) || !rowsAsc.length) {
    return {
      xPositions: [],
      dayKeys: [],
      dayAnchors: []
    };
  }

  const dayKeys = Array.from(new Set(rowsAsc.map((row) => toDateKey(row.capturedAt))));
  const dayCount = dayKeys.length;
  const dayStep = dayCount <= 1 ? width : width / (dayCount - 1);
  const dayIndexByKey = new Map(dayKeys.map((dayKey, index) => [dayKey, index]));
  const dayAnchors = dayKeys.map((_, index) => (dayCount <= 1 ? left + width / 2 : left + index * dayStep));

  const indexesByDay = new Map();
  rowsAsc.forEach((row, rowIndex) => {
    const dayKey = toDateKey(row.capturedAt);
    if (!indexesByDay.has(dayKey)) {
      indexesByDay.set(dayKey, []);
    }
    indexesByDay.get(dayKey).push(rowIndex);
  });

  const xPositions = new Array(rowsAsc.length).fill(left + width / 2);
  dayKeys.forEach((dayKey) => {
    const rowIndexes = indexesByDay.get(dayKey) || [];
    if (!rowIndexes.length) {
      return;
    }

    const dayIndex = dayIndexByKey.get(dayKey);
    const anchor = dayAnchors[dayIndex];

    if (rowIndexes.length === 1) {
      xPositions[rowIndexes[0]] = anchor;
      return;
    }

    let minX;
    let maxX;
    if (dayCount <= 1) {
      minX = left;
      maxX = left + width;
    } else if (dayIndex === 0) {
      minX = anchor;
      maxX = anchor + dayStep;
    } else if (dayIndex === dayCount - 1) {
      minX = anchor - dayStep;
      maxX = anchor;
    } else {
      minX = anchor - dayStep / 2;
      maxX = anchor + dayStep / 2;
    }

    const span = Math.max(0, maxX - minX);
    rowIndexes.forEach((rowIndex, positionIndex) => {
      const t = rowIndexes.length <= 1 ? 0.5 : positionIndex / (rowIndexes.length - 1);
      xPositions[rowIndex] = minX + span * t;
    });
  });

  return { xPositions, dayKeys, dayAnchors };
}

function buildTrendSeriesGeometry(rowsAsc, key, xPositions, top, height, minValue, maxValue) {
  const seriesRows = rowsAsc
    .map((row, index) => ({ index, x: xPositions[index], value: Number(row[key]), capturedAt: row.capturedAt }))
    .filter((item) => Number.isFinite(item.value));

  if (!seriesRows.length) {
    return { path: "", circles: "" };
  }

  const min = Number.isFinite(minValue) ? minValue : 0;
  const max = Number.isFinite(maxValue) ? maxValue : min + 1;
  const span = Math.max(0.000001, max - min);

  const toY = (value) => {
    return top + height - ((value - min) / span) * height;
  };

  const points = seriesRows.map((item) => `${item.x},${toY(item.value)}`);
  const circles = seriesRows.map((item) => {
    const x = item.x;
    const y = toY(item.value);
    return `<circle cx="${x}" cy="${y}" r="2.5" />`;
  }).join("");

  return {
    path: points.length ? `M ${points.join(" L ")}` : "",
    circles
  };
}

function positionTrendChartOverlay() {
  if (!state.panelEl || !state.trendChartOverlayEl || !state.trendSectionEl) {
    return;
  }

  const header = state.panelEl.querySelector(".mw-panel-header");
  if (!header) {
    return;
  }

  const overlayTop = header.offsetTop + header.offsetHeight + 4;
  const overlayBottom = state.trendSectionEl.offsetTop - 6;
  const overlayHeight = Math.max(160, overlayBottom - overlayTop);

  state.trendChartOverlayEl.style.top = `${overlayTop}px`;
  state.trendChartOverlayEl.style.left = "8px";
  state.trendChartOverlayEl.style.right = "8px";
  state.trendChartOverlayEl.style.height = `${overlayHeight}px`;
}

function hideTrendChartOverlay() {
  if (state.trendChartOverlayEl) {
    state.trendChartOverlayEl.style.display = "none";
  }
  if (state.trendChartSvgEl) {
    state.trendChartSvgEl.innerHTML = "";
  }

  if (state.trendChartOutsideClickHandler) {
    document.removeEventListener("mousedown", state.trendChartOutsideClickHandler, true);
    state.trendChartOutsideClickHandler = null;
  }
}

function renderTrendChart(storyName) {
  if (!state.trendChartSvgEl) {
    return;
  }

  const trendRows = getTrendRows(storyName);
  if (!storyName || !trendRows.length) {
    hideTrendChartOverlay();
    return;
  }

  const rowsAsc = [...trendRows].sort((a, b) => new Date(a.capturedAt).getTime() - new Date(b.capturedAt).getTime());
  let rowsForChart = rowsAsc;
  if (rowsAsc.length > 1000) {
    rowsForChart = rowsAsc.filter((_, index) => index % 10 === 0);
    if (rowsForChart[rowsForChart.length - 1] !== rowsAsc[rowsAsc.length - 1]) {
      rowsForChart.push(rowsAsc[rowsAsc.length - 1]);
    }
  }

  const svgWidth = 1000;
  const svgHeight = 420;
  const margin = { top: 18, right: 24, bottom: 52, left: 40 };
  const plotWidth = svgWidth - margin.left - margin.right;
  const plotHeight = svgHeight - margin.top - margin.bottom;

  const xAxisY = margin.top + plotHeight;
  const latest = rowsAsc[rowsAsc.length - 1] || null;

  const latestViews = latest && Number.isFinite(Number(latest.views)) ? Number(latest.views) : 0;
  const latestReads = latest && Number.isFinite(Number(latest.reads)) ? Number(latest.reads) : 0;
  const latestEarnings = latest && Number.isFinite(Number(latest.earnings)) ? Number(latest.earnings) : 0;

  const leftAxisTop = Math.max(10, Math.floor(Math.max(latestViews, latestReads) / 10) * 10 + 10);
  const rightAxisTop = Math.max(1, Math.floor(latestEarnings) + 1);

  const xGeometry = buildTrendXPositionsByDay(rowsForChart, margin.left, plotWidth);
  const { xPositions, dayKeys: chartDayKeys, dayAnchors } = xGeometry;

  const views = buildTrendSeriesGeometry(rowsForChart, "views", xPositions, margin.top, plotHeight, 0, leftAxisTop);
  const reads = buildTrendSeriesGeometry(rowsForChart, "reads", xPositions, margin.top, plotHeight, 0, leftAxisTop);
  const earnings = buildTrendSeriesGeometry(rowsForChart, "earnings", xPositions, margin.top, plotHeight, 0, rightAxisTop);

  const latestReadPointX = xPositions.length ? xPositions[xPositions.length - 1] : (margin.left + plotWidth / 2);
  const latestReadPointY = margin.top + plotHeight - ((latestReads - 0) / Math.max(0.000001, leftAxisTop)) * plotHeight;
  const latestReadLabelX = latestReadPointX - 6;
  const latestReadLabelY = Math.max(margin.top + 10, latestReadPointY - 6);

  const tickCount = Math.min(6, chartDayKeys.length);
  const ticks = [];
  for (let i = 0; i < tickCount; i += 1) {
    const idx = tickCount === 1
      ? 0
      : Math.round((i / (tickCount - 1)) * (chartDayKeys.length - 1));
    ticks.push(idx);
  }
  const uniqueTicks = Array.from(new Set(ticks));
  const tickLabels = uniqueTicks.map((idx) => {
    const x = dayAnchors[idx] || (margin.left + plotWidth / 2);
    return `
      <line x1="${x}" y1="${xAxisY}" x2="${x}" y2="${xAxisY + 6}" stroke="#666" stroke-width="1" />
      <text x="${x}" y="${xAxisY + 20}" text-anchor="middle" font-size="11" fill="#444">${formatTrendDateLabel(chartDayKeys[idx])}</text>
    `;
  }).join("");

  state.trendChartSvgEl.innerHTML = `
    <svg viewBox="0 0 ${svgWidth} ${svgHeight}" width="100%" height="100%" preserveAspectRatio="none" role="img" aria-label="Trend line chart for selected story">
      <rect x="0" y="0" width="${svgWidth}" height="${svgHeight}" fill="#ffffff" />
      <line x1="${margin.left}" y1="${xAxisY}" x2="${margin.left + plotWidth}" y2="${xAxisY}" stroke="#999" stroke-width="1" />
      <line x1="${margin.left}" y1="${margin.top}" x2="${margin.left}" y2="${xAxisY}" stroke="#999" stroke-width="1" />
      <line x1="${margin.left + plotWidth}" y1="${margin.top}" x2="${margin.left + plotWidth}" y2="${xAxisY}" stroke="#999" stroke-width="1" />

      <text x="${margin.left}" y="${margin.top - 4}" text-anchor="start" font-size="12" font-weight="700" fill="${TREND_COLOR_VIEWS}">${formatNumber(leftAxisTop)}</text>
      <text x="${margin.left + plotWidth}" y="${margin.top - 4}" text-anchor="end" font-size="12" font-weight="700" fill="${TREND_COLOR_EARNINGS}">${formatCurrency(rightAxisTop)}</text>

      ${views.path ? `<path d="${views.path}" fill="none" stroke="${TREND_COLOR_VIEWS}" stroke-width="2" />` : ""}
      ${views.path ? `<g fill="${TREND_COLOR_VIEWS}">${views.circles}</g>` : ""}

      ${reads.path ? `<path d="${reads.path}" fill="none" stroke="${TREND_COLOR_READS}" stroke-width="2" />` : ""}
      ${reads.path ? `<g fill="${TREND_COLOR_READS}">${reads.circles}</g>` : ""}
      ${reads.path ? `<text x="${latestReadLabelX}" y="${latestReadLabelY}" text-anchor="end" font-size="10" font-weight="700" fill="${TREND_COLOR_READS}">${formatNumber(latestReads)}</text>` : ""}

      ${earnings.path ? `<path d="${earnings.path}" fill="none" stroke="${TREND_COLOR_EARNINGS}" stroke-width="2" />` : ""}
      ${earnings.path ? `<g fill="${TREND_COLOR_EARNINGS}">${earnings.circles}</g>` : ""}

      ${tickLabels}

      <text x="${margin.left + plotWidth / 2}" y="${svgHeight - 8}" text-anchor="middle" font-size="12" fill="#333">Days</text>
    </svg>
  `;
}

function showTrendChartOverlay(storyName) {
  if (!state.trendChartOverlayEl || !state.trendChartTitleEl) {
    return;
  }

  if (!storyName) {
    setStatus("Select a story before showing trend chart.", true);
    return;
  }

  state.trendChartTitleEl.textContent = `Trend Chart: ${formatStoryTitleForDisplay(storyName)}`;
  positionTrendChartOverlay();
  renderTrendChart(storyName);
  state.trendChartOverlayEl.style.display = "block";

  if (!state.trendChartOutsideClickHandler) {
    state.trendChartOutsideClickHandler = (event) => {
      if (!state.trendChartOverlayEl) {
        return;
      }
      if (!state.trendChartOverlayEl.contains(event.target)) {
        hideTrendChartOverlay();
      }
    };
    document.addEventListener("mousedown", state.trendChartOutsideClickHandler, true);
  }
}

function resolveSelectedTrendStory() {
  if (!state.selectTrendStory) {
    return "";
  }

  const selected = String(state.selectTrendStory.value || "").trim();
  if (selected) {
    return selected;
  }

  const fallback = Array.from(state.selectTrendStory.options || [])
    .map((option) => String(option.value || "").trim())
    .find((value) => value);

  if (fallback) {
    state.selectTrendStory.value = fallback;
    return fallback;
  }

  return "";
}

function renderTrend(storyName) {
  if (!state.trendContainerEl) {
    return;
  }

  if (!storyName) {
    state.trendContainerEl.innerHTML = "<div class='mw-empty'>Select a story to see trend history.</div>";
    return;
  }

  const filteredRows = getTrendRows(storyName);

  if (!filteredRows.length) {
    state.trendContainerEl.innerHTML = "<div class='mw-empty'>No trend data for this story.</div>";
    return;
  }

  let rowsForTable = filteredRows;
  let hasEllipsisGap = false;
  if (filteredRows.length > 10) {
    const rowsAsc = [...filteredRows].reverse();
    const oldestFive = rowsAsc.slice(0, 5);
    const newestFive = rowsAsc.slice(-5);
    rowsForTable = [...oldestFive, ...newestFive];
    hasEllipsisGap = true;
  }

  const tableRows = rowsForTable.map((row, index) => {
    const ellipsisRow = hasEllipsisGap && index === 5
      ? "<tr><td colspan='4' style='text-align: center;'>...</td></tr>"
      : "";
    return `${ellipsisRow}
    <tr>
      <td>${formatTimestamp(row.capturedAt)}</td>
      <td>${formatNumber(row.views)}</td>
      <td>${formatNumber(row.reads)}</td>
      <td>${formatCurrency(row.earnings)}</td>
    </tr>`;
  }).join("");

  state.trendContainerEl.innerHTML = `
    <div class="mw-table-wrap">
      <table class="mw-table">
        <thead>
          <tr>
            <th>Snapshot</th>
            <th>Views</th>
            <th>Reads</th>
            <th>Earnings</th>
          </tr>
        </thead>
        <tbody>
          ${tableRows}
        </tbody>
      </table>
    </div>
  `;
}

function togglePanel(show) {
  const panel = state.panelEl || document.getElementById(PANEL_IDS.panel);
  if (!panel) {
    return;
  }
  if (!show) {
    hideTrendChartOverlay();
  }
  panel.style.display = show ? "block" : "none";
}

function isPanelVisible() {
  const panel = state.panelEl || document.getElementById(PANEL_IDS.panel);
  if (!panel) {
    return false;
  }
  return window.getComputedStyle(panel).display !== "none";
}

function togglePanelExpanded() {
  const panel = state.panelEl || document.getElementById(PANEL_IDS.panel);
  const button = document.getElementById("mw-toggle-panel-size");
  if (!panel || !button) {
    return;
  }

  const expanded = panel.classList.toggle("mw-expanded");
  button.textContent = expanded ? ">> Collapse" : "<< Expand";
  button.title = expanded ? "Collapse panel width" : "Expand panel width";
  if (state.trendChartOverlayEl && state.trendChartOverlayEl.style.display === "block") {
    positionTrendChartOverlay();
  }
}

function refreshSnapshotSummary() {
  if (!state.summaryEl) {
    return;
  }
  const count = state.snapshots.length;
  const latest = count ? state.snapshots[count - 1] : null;
  const estimatedBytes = estimateSnapshotsStorageBytes();
  state.summaryEl.innerHTML = `
    <div><strong>Snapshots:</strong> ${count}</div>
    <div><strong>Latest:</strong> ${latest ? formatTimestamp(latest.capturedAt) : "None"}</div>
    <div><strong>Storage space used:</strong> ${formatByteSize(estimatedBytes)}</div>
  `;
}

function getSnapshotDayKey(snapshotId) {
  if (!snapshotId) {
    return "";
  }
  const snapshot = getSnapshotById(snapshotId);
  return snapshot ? toDateKey(snapshot.capturedAt) : "";
}

function buildSnapshotDayBuckets() {
  const buckets = new Map();
  state.snapshots.forEach((snapshot) => {
    const dayKey = toDateKey(snapshot.capturedAt);
    if (!buckets.has(dayKey)) {
      buckets.set(dayKey, []);
    }
    buckets.get(dayKey).push(snapshot);
  });

  buckets.forEach((list) => {
    list.sort((a, b) => new Date(a.capturedAt).getTime() - new Date(b.capturedAt).getTime());
  });

  const dayKeys = Array.from(buckets.keys()).sort((a, b) => new Date(a).getTime() - new Date(b).getTime());
  return { buckets, dayKeys };
}

function refreshSegmentedCompareSelectors(preferredAId = "", preferredBId = "") {
  if (!state.selectCompareDateA || !state.selectCompareDateB || !state.selectCompareA || !state.selectCompareB) {
    return;
  }

  const { buckets, dayKeys } = buildSnapshotDayBuckets();
  const previousDayA = getSnapshotDayKey(preferredAId) || state.selectCompareDateA.value;
  const previousDayB = getSnapshotDayKey(preferredBId) || state.selectCompareDateB.value;

  const applyDayOptions = (selectEl, previousDay, placeholder, preferLatest) => {
    selectEl.innerHTML = "";
    const empty = document.createElement("option");
    empty.value = "";
    empty.textContent = placeholder;
    selectEl.appendChild(empty);

    dayKeys.forEach((dayKey) => {
      const option = document.createElement("option");
      option.value = dayKey;
      const count = (buckets.get(dayKey) || []).length;
      option.textContent = `${dayKey} (${count})`;
      selectEl.appendChild(option);
    });

    if (previousDay && dayKeys.includes(previousDay)) {
      selectEl.value = previousDay;
      return;
    }

    if (dayKeys.length) {
      selectEl.value = preferLatest ? dayKeys[dayKeys.length - 1] : dayKeys[0];
    }
  };

  const applyTimestampOptions = (daySelectEl, timestampSelectEl, preferredSnapshotId, placeholder, preferLatest) => {
    const previousSnapshotId = preferredSnapshotId || timestampSelectEl.value;
    const dayKey = daySelectEl.value;
    const snapshotsForDay = dayKey ? buckets.get(dayKey) || [] : [];

    timestampSelectEl.innerHTML = "";
    const empty = document.createElement("option");
    empty.value = "";
    empty.textContent = placeholder;
    timestampSelectEl.appendChild(empty);

    snapshotsForDay.forEach((snapshot) => {
      const option = document.createElement("option");
      option.value = snapshot.id;
      option.textContent = `${formatTimestamp(snapshot.capturedAt)} (${snapshot.mode})`;
      timestampSelectEl.appendChild(option);
    });

    // Most days have a single snapshot; hide timestamp picker unless day has multiple snapshots.
    timestampSelectEl.style.display = snapshotsForDay.length > 1 ? "" : "none";

    if (previousSnapshotId && snapshotsForDay.some((snapshot) => snapshot.id === previousSnapshotId)) {
      timestampSelectEl.value = previousSnapshotId;
      return;
    }

    if (snapshotsForDay.length) {
      const picked = preferLatest ? snapshotsForDay[snapshotsForDay.length - 1] : snapshotsForDay[0];
      timestampSelectEl.value = picked.id;
    }
  };

  applyDayOptions(state.selectCompareDateA, previousDayA, "Base day", false);
  applyDayOptions(state.selectCompareDateB, previousDayB, "Target day", true);
  applyTimestampOptions(state.selectCompareDateA, state.selectCompareA, preferredAId, "Base snapshot", false);
  applyTimestampOptions(state.selectCompareDateB, state.selectCompareB, preferredBId, "Target snapshot", true);
}

function refreshSelectOptions(preferredTrendGroupKey = "") {
  const options = state.snapshots.map((snapshot) => ({
    value: snapshot.id,
    label: `${formatTimestamp(snapshot.capturedAt)} (${snapshot.mode})`
  }));

  const applyOptions = (selectEl, placeholder) => {
    if (!selectEl) {
      return;
    }
    const previous = selectEl.value;
    selectEl.innerHTML = "";
    const empty = document.createElement("option");
    empty.value = "";
    empty.textContent = placeholder;
    selectEl.appendChild(empty);

    options.forEach((opt) => {
      const option = document.createElement("option");
      option.value = opt.value;
      option.textContent = opt.label;
      selectEl.appendChild(option);
    });

    if (previous && options.some((opt) => opt.value === previous)) {
      selectEl.value = previous;
    }
  };

  refreshSegmentedCompareSelectors();
  applyOptions(state.selectDeleteTimestamp, "Select timestamp to delete");

  if (state.selectTrendStory) {
    const old = state.selectTrendStory.value;
    const stories = getAllStoryNames();
    const groups = buildTrendStoryGroups(stories);
    state.trendStoryGroups = groups;

    if (groups.length) {
      let nextGroupKey = preferredTrendGroupKey || state.activeTrendStoryGroupKey;
      if (old && !preferredTrendGroupKey) {
        const matched = groups.find((group) => group.stories.includes(old));
        if (matched) {
          nextGroupKey = matched.key;
        }
      }
      if (!nextGroupKey || !groups.some((group) => group.key === nextGroupKey)) {
        nextGroupKey = groups[0].key;
      }
      state.activeTrendStoryGroupKey = nextGroupKey;
    } else {
      state.activeTrendStoryGroupKey = "";
    }

    renderTrendStoryGroupFilters();

    const visibleStories = groups.length
      ? ((groups.find((group) => group.key === state.activeTrendStoryGroupKey) || groups[0]).stories || [])
      : stories;

    state.selectTrendStory.innerHTML = "";
    const empty = document.createElement("option");
    empty.value = "";
    empty.textContent = "Select a story";
    state.selectTrendStory.appendChild(empty);
    visibleStories.forEach((storyName) => {
      const option = document.createElement("option");
      option.value = storyName;
      option.textContent = formatStoryTitleForDisplay(storyName);
      state.selectTrendStory.appendChild(option);
    });
    if (old && visibleStories.includes(old)) {
      state.selectTrendStory.value = old;
    }
  }

  if (state.selectDeleteStory) {
    const old = state.selectDeleteStory.value;
    const stories = getAllStoryNames();
    state.selectDeleteStory.innerHTML = "";
    const empty = document.createElement("option");
    empty.value = "";
    empty.textContent = "Select story to delete";
    state.selectDeleteStory.appendChild(empty);
    stories.forEach((storyName) => {
      const option = document.createElement("option");
      option.value = storyName;
      option.textContent = formatStoryTitleForDisplay(storyName);
      state.selectDeleteStory.appendChild(option);
    });
    if (old && stories.includes(old)) {
      state.selectDeleteStory.value = old;
    }
  }
}

function refreshPanelData() {
  refreshSnapshotSummary();
  updateSmartCaptureHint();
  refreshSelectOptions();
  renderDailyChangesSummary();
  updateLauncherSignal();

  const [defaultA, defaultB] = findCompareDatesDefault();
  if (defaultA && defaultB && state.selectCompareA && state.selectCompareB && (!state.selectCompareA.value || !state.selectCompareB.value)) {
    refreshSegmentedCompareSelectors(defaultA, defaultB);
  }

  renderDiff(state.selectCompareA ? state.selectCompareA.value : "", state.selectCompareB ? state.selectCompareB.value : "");
  renderTrend(state.selectTrendStory ? state.selectTrendStory.value : "");
}

async function deleteByStory(storyName) {
  if (!storyName) {
    throw new Error("Select a story to delete.");
  }
  state.snapshots = state.snapshots
    .map((snapshot) => ({
      ...snapshot,
      stories: snapshot.stories.filter((story) => story.storyName !== storyName)
    }))
    .filter((snapshot) => snapshot.stories.length > 0);
  await persistSnapshots();
}

async function deleteByTimestamp(snapshotId) {
  if (!snapshotId) {
    throw new Error("Select a timestamp to delete.");
  }
  state.snapshots = state.snapshots.filter((snapshot) => snapshot.id !== snapshotId);
  await persistSnapshots();
}

function createPanelMarkup() {
  const wrapper = document.createElement("div");
  wrapper.id = PANEL_IDS.wrapper;
  wrapper.innerHTML = `
    <style>
      #${PANEL_IDS.launcher} {
        position: fixed;
        right: 16px;
        bottom: 16px;
        width: 44px;
        height: 44px;
        border-radius: 0;
        border: 0;
        background: transparent;
        color: #111;
        padding: 0;
        z-index: 2147483646;
        cursor: pointer;
      }
      #${PANEL_IDS.launcher} img {
        width: 100%;
        height: 100%;
        display: block;
      }
      #${PANEL_IDS.panel} {
        position: fixed;
        right: 16px;
        top: 16px;
        width: 420px;
        max-height: calc(100vh - 32px);
        overflow: auto;
        background: #fff;
        border: 1px solid #111;
        box-shadow: 0 10px 30px rgba(0, 0, 0, 0.18);
        z-index: 2147483647;
        padding: 12px;
        font-family: Arial, Helvetica, sans-serif;
        font-size: 12px;
        color: #111;
        display: none;
      }
      #${PANEL_IDS.panel} .mw-trend-chart-overlay {
        position: absolute;
        display: none;
        background: #ffffff;
        border: 1px solid #111;
        box-shadow: 0 8px 22px rgba(0, 0, 0, 0.15);
        z-index: 6;
        padding: 8px;
      }
      #${PANEL_IDS.panel} .mw-trend-chart-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        margin-bottom: 8px;
      }
      #${PANEL_IDS.panel} .mw-trend-chart-title {
        font-weight: 700;
        color: #1f2937;
      }
      #${PANEL_IDS.panel} .mw-trend-chart-legend {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        margin-bottom: 6px;
        font-size: 11px;
      }
      #${PANEL_IDS.panel} .mw-trend-chart-legend-item {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        color: #374151;
      }
      #${PANEL_IDS.panel} .mw-trend-chart-dot {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        display: inline-block;
      }
      #${PANEL_IDS.panel} .mw-trend-chart-svg {
        width: 100%;
        height: calc(100% - 58px);
        min-height: 120px;
      }
      #${PANEL_IDS.panel}.mw-expanded {
        width: min(92vw, 1180px);
      }
      #${PANEL_IDS.panel} .mw-row {
        display: flex;
        gap: 8px;
        flex-wrap: wrap;
        margin-bottom: 8px;
      }
      #${PANEL_IDS.panel} button,
      #${PANEL_IDS.panel} select {
        border: 1px solid #111;
        background: #fff;
        color: #111;
        padding: 4px 6px;
        font-size: 12px;
      }
      #${PANEL_IDS.panel} .mw-busy-action {
        background: #ffe8cc;
        border-color: #cc7a00;
        color: #7a2f00;
        font-weight: 700;
        animation: mwPulse 1s ease-in-out infinite;
      }
      #${PANEL_IDS.panel} .mw-title {
        font-size: 14px;
        font-weight: 700;
      }
      #${PANEL_IDS.panel} .mw-status {
        font-size: 12px;
        margin: 6px 0;
      }
      #${PANEL_IDS.panel} .mw-status-busy {
        background: #ffe8cc;
        border: 1px solid #cc7a00;
        border-radius: 4px;
        padding: 6px 8px;
        font-weight: 700;
        animation: mwPulse 1s ease-in-out infinite;
      }
      @keyframes mwPulse {
        0% {
          box-shadow: 0 0 0 0 rgba(204, 122, 0, 0.35);
        }
        70% {
          box-shadow: 0 0 0 8px rgba(204, 122, 0, 0);
        }
        100% {
          box-shadow: 0 0 0 0 rgba(204, 122, 0, 0);
        }
      }
      #${PANEL_IDS.panel} .mw-summary,
      #${PANEL_IDS.panel} .mw-section {
        border: 1px solid #ddd;
        padding: 8px;
        margin-bottom: 8px;
      }
      #${PANEL_IDS.panel} .mw-snapshot-controls {
        justify-content: space-between;
        align-items: flex-start;
      }
      #${PANEL_IDS.panel} .mw-snapshot-actions {
        margin-bottom: 0;
      }
      #${PANEL_IDS.panel} .mw-snapshot-inline-summary {
        display: none;
        color: #333;
        text-align: right;
        min-width: 180px;
        font-size: 11px;
        line-height: 1.4;
      }
      #${PANEL_IDS.panel}.mw-expanded .mw-snapshot-inline-summary {
        display: block;
      }
      #${PANEL_IDS.panel} .mw-section-title {
        font-weight: 700;
        margin-bottom: 6px;
      }
      #${PANEL_IDS.panel} .mw-panel-header {
        position: sticky;
        top: 0;
        z-index: 2;
        background: #dff3e4;
        padding-bottom: 6px;
        margin-bottom: 6px;
        border-bottom: 1px solid #8dc5a1;
      }
      #${PANEL_IDS.panel} .mw-profile-link {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 26px;
        height: 26px;
        border-radius: 50%;
        overflow: hidden;
        border: 1px solid #8dc5a1;
      }
      #${PANEL_IDS.panel} .mw-profile-link img {
        width: 100%;
        height: 100%;
        object-fit: cover;
        display: block;
      }
      #${PANEL_IDS.panel} .mw-table-wrap {
        overflow: auto;
        max-height: 200px;
        border: 1px solid #ddd;
      }
      #${PANEL_IDS.panel} .mw-table {
        width: 100%;
        border-collapse: collapse;
      }
      #${PANEL_IDS.panel} .mw-table th,
      #${PANEL_IDS.panel} .mw-table td {
        border-bottom: 1px solid #eee;
        text-align: left;
        padding: 4px;
        white-space: nowrap;
      }
      #${PANEL_IDS.panel} .mw-table th.mw-sortable {
        cursor: pointer;
        user-select: none;
      }
      #${PANEL_IDS.panel} .mw-table th.mw-sortable:hover {
        background: #f5f8f6;
      }
      #${PANEL_IDS.panel} .mw-empty {
        color: #666;
      }
      #${PANEL_IDS.panel} .mw-pos {
        color: #0f5132;
        font-weight: 700;
      }
      #${PANEL_IDS.panel} .mw-neg {
        color: #8f1111;
        font-weight: 700;
      }
      #${PANEL_IDS.panel} .mw-neutral {
        color: #444;
      }
      #${PANEL_IDS.panel} .mw-compare-title {
        font-weight: 700;
        margin-bottom: 6px;
      }
      #${PANEL_IDS.panel} .mw-compare-head {
        display: flex;
        justify-content: space-between;
        align-items: flex-start;
        gap: 8px;
        margin-bottom: 6px;
      }
      #${PANEL_IDS.panel} .mw-compare-head .mw-compare-title {
        margin-bottom: 0;
      }
      #${PANEL_IDS.panel} .mw-compare-totals-box {
        border: 1px solid #cfe2d8;
        background: #f3faf6;
        border-radius: 4px;
        padding: 6px 8px;
        min-width: 280px;
      }
      #${PANEL_IDS.panel} .mw-compare-totals-label {
        color: #2f4f43;
        font-weight: 700;
        margin-bottom: 4px;
      }
      #${PANEL_IDS.panel} .mw-compare-totals-items {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
      }
      #${PANEL_IDS.panel} .mw-compare-total-item {
        font-weight: 700;
      }
      #${PANEL_IDS.panel} .mw-summary-head {
        font-weight: 700;
        margin-bottom: 4px;
      }
      #${PANEL_IDS.panel} .mw-summary-count {
        margin-bottom: 6px;
      }
      #${PANEL_IDS.panel} .mw-change-list {
        display: flex;
        flex-direction: column;
        gap: 6px;
      }
      #${PANEL_IDS.panel} .mw-change-item {
        border: 1px solid #eee;
        padding: 6px;
      }
      #${PANEL_IDS.panel} .mw-change-title {
        font-weight: 700;
      }
      #${PANEL_IDS.panel} .mw-story-link {
        color: #0a5c36;
        text-decoration: underline;
      }
      #${PANEL_IDS.panel} .mw-story-link:hover {
        color: #08482a;
      }
      #${PANEL_IDS.panel} .mw-change-meta {
        color: #555;
        margin: 2px 0 4px;
      }
      #${PANEL_IDS.panel} .mw-danger-title {
        color: #8f1111;
      }
      #${PANEL_IDS.panel} .mw-danger-warning {
        border: 1px solid #c94b16;
        background: #fff4eb;
        color: #8a2f0a;
        padding: 6px 8px;
        margin: 0 0 8px;
        font-weight: 700;
      }
      #${PANEL_IDS.panel} .mw-warning {
        border: 1px solid #c94b16;
        background: #fff4eb;
        color: #8a2f0a;
        padding: 6px 8px;
        margin: 0 0 8px;
        font-weight: 700;
      }
      #${PANEL_IDS.panel} .mw-change-deltas {
        display: flex;
        gap: 8px;
        flex-wrap: wrap;
      }
      #${PANEL_IDS.panel} .mw-trend-filter-row {
        display: none;
        flex-wrap: wrap;
        gap: 4px;
        margin-bottom: 6px;
      }
      #${PANEL_IDS.panel} .mw-trend-filter-btn {
        background: #f4f8f6;
        border: 1px solid #c5d7cc;
        color: #2f4f43;
        font-size: 11px;
        font-weight: 700;
        line-height: 1;
        padding: 4px 6px;
        border-radius: 3px;
        cursor: pointer;
      }
      #${PANEL_IDS.panel} .mw-trend-filter-btn:hover {
        background: #eaf3ee;
      }
      #${PANEL_IDS.panel} .mw-trend-filter-btn-active {
        background: #dff3e4;
        border-color: #8dc5a1;
        color: #0a5c36;
      }
      #${PANEL_IDS.panel} .mw-trend-filter-btn-disabled {
        opacity: 0.45;
        cursor: default;
      }
      #${PANEL_IDS.panel} .mw-trend-group-settings {
        display: none;
        align-items: center;
        gap: 6px;
        margin-bottom: 6px;
      }
      #${PANEL_IDS.panel} .mw-trend-group-settings input {
        width: 72px;
      }
      #${PANEL_IDS.panel} .mw-checkbox-row {
        display: flex;
        gap: 10px;
        flex-wrap: wrap;
        margin: 6px 0 8px;
      }
      #${PANEL_IDS.panel} .mw-checkbox-row label {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        cursor: pointer;
      }
      #${PANEL_IDS.panel} .mw-export-output {
        width: 100%;
        min-height: 140px;
        border: 1px solid #111;
        margin-top: 8px;
        padding: 6px;
        font-size: 11px;
        font-family: Menlo, Monaco, Consolas, monospace;
        resize: vertical;
      }
    </style>

    <button id="${PANEL_IDS.launcher}" title="Open Writer Success Stats for Medium" aria-label="Open Writer Success Stats for Medium">
      <img src="${chrome.runtime.getURL("icon.svg")}" alt="Writer Success Stats for Medium" />
    </button>

    <aside id="${PANEL_IDS.panel}" aria-live="polite">
      <div class="mw-row mw-panel-header" style="justify-content: space-between; align-items: center;">
        <div class="mw-title">Writer Success Stats for Medium</div>
        <div class="mw-row" style="margin-bottom: 0;">
          <a class="mw-profile-link" href="https://medium.com/@frankfont123" target="_blank" rel="noopener noreferrer" title="Open @frankfont123 on Medium">
            <img src="${chrome.runtime.getURL("author.png")}" alt="Frank Font profile" />
          </a>
          <button id="mw-toggle-panel-size" type="button" title="Expand panel width"><< Expand</button>
          <button id="mw-close-panel" type="button" title="Close panel" aria-label="Close panel">X</button>
        </div>
      </div>

      <div id="mw-trend-chart-overlay" class="mw-trend-chart-overlay" aria-label="Trend chart overlay">
        <div class="mw-trend-chart-head">
          <div id="mw-trend-chart-title" class="mw-trend-chart-title">Trend Chart</div>
          <button id="mw-trend-chart-close" type="button" aria-label="Close trend chart">Close</button>
        </div>
        <div class="mw-trend-chart-legend" aria-label="Trend chart legend">
          <span class="mw-trend-chart-legend-item"><span class="mw-trend-chart-dot" style="background: ${TREND_COLOR_VIEWS};"></span>Views</span>
          <span class="mw-trend-chart-legend-item"><span class="mw-trend-chart-dot" style="background: ${TREND_COLOR_READS};"></span>Reads</span>
          <span class="mw-trend-chart-legend-item"><span class="mw-trend-chart-dot" style="background: ${TREND_COLOR_EARNINGS};"></span>Earnings</span>
        </div>
        <div id="mw-trend-chart-svg" class="mw-trend-chart-svg"></div>
      </div>

      <div id="mw-status" class="mw-status">Ready.</div>

      <div class="mw-section" id="mw-daily-summary-section">
        <div class="mw-row" style="justify-content: space-between; align-items: center;">
          <div class="mw-section-title" style="margin-bottom: 0;">Daily Changes Summary</div>
        </div>
        <div class="mw-checkbox-row" aria-label="Daily summary metric filters">
          <label><input id="mw-filter-presentations" type="checkbox" checked/>Presentations</label>
          <label><input id="mw-filter-views" type="checkbox" checked/>Views</label>
          <label><input id="mw-filter-reads" type="checkbox" checked/>Reads</label>
          <label><input id="mw-filter-earnings" type="checkbox" checked/>Earnings</label>
        </div>
        <div id="mw-daily-summary"></div>
      </div>

      <div class="mw-section">
        <div class="mw-section-title">Snapshots</div>
        <div class="mw-row mw-snapshot-controls">
          <div class="mw-row mw-snapshot-actions">
            <button id="mw-manual-snapshot-smart" type="button">Capture Snapshot</button>
            <button id="mw-prune-snapshots" type="button">Prune Snapshots</button>
          </div>
          <div id="mw-summary" class="mw-snapshot-inline-summary"></div>
        </div>
        <div id="mw-smart-capture-hint" class="mw-empty">Mode: Smart</div>
      </div>

      <div class="mw-section" id="mw-transfer-section" style="display: none;">
        <div class="mw-section-title">Advanced Features: Transfer Data</div>
        <div class="mw-row">
          <button id="mw-export-all" type="button">Export All</button>
          <button id="mw-import-all" type="button">Import All</button>
        </div>
        <textarea id="mw-transfer-json-output" class="mw-export-output" placeholder="Exported snapshot data appears here. Paste exported JSON here, then click Import All."></textarea>
      </div>

      <div class="mw-section">
        <div class="mw-section-title">Compare Any Two</div>
        <div class="mw-checkbox-row" aria-label="Compare metric filters">
          <label><input id="mw-compare-filter-presentations" type="checkbox" checked/>Presentations</label>
          <label><input id="mw-compare-filter-views" type="checkbox" checked/>Views</label>
          <label><input id="mw-compare-filter-reads" type="checkbox" checked/>Reads</label>
          <label><input id="mw-compare-filter-earnings" type="checkbox" checked/>Earnings</label>
        </div>
        <div class="mw-row">
            <select id="mw-compare-a-day"></select>
            <select id="mw-compare-a"></select>
            <select id="mw-compare-b-day"></select>
            <select id="mw-compare-b"></select>
          <button id="mw-run-default-compare" type="button">Run Default Comparison</button>
          <button id="mw-audit-compare" type="button" style="display: none;" title="Hold Shift while clicking Run Default Comparison to show this">Advanced Features: Audit Snapshot Pair</button>
          <button id="mw-export-audit-json" type="button" style="display: none;" title="Hold Shift while clicking Run Default Comparison to show this">Advanced Features: Export Audit JSON</button>
          <button id="mw-export-compare-json" type="button" style="display: none;" title="Hold Shift while clicking Run Default Comparison to show this">Advanced Features: Export A/B JSON</button>
          <button id="mw-hide-advanced-features" type="button" style="display: none;">Hide Advanced Features</button>
        </div>
        <div id="mw-diff"></div>
        <div id="mw-audit-export-section" style="display: none; margin-top: 8px;">
          <div id="mw-audit"></div>
          <textarea id="mw-export-json-output" class="mw-export-output" readonly placeholder="Exported A/B snapshot JSON appears here."></textarea>
        </div>
      </div>

      <div class="mw-section" id="mw-trend-section">
        <div class="mw-section-title">Trend Over Time</div>
        <div id="mw-trend-filters" class="mw-trend-filter-row" aria-label="Trend story starting-letter filters"></div>
        <div id="mw-trend-group-settings" class="mw-trend-group-settings" aria-label="Trend list size settings">
          <label for="mw-trend-group-max">Max stories per filter</label>
          <input id="mw-trend-group-max" type="number" min="2" max="1000" step="1" value="50" />
          <button id="mw-trend-group-apply" type="button">Set Max</button>
        </div>
        <div class="mw-row">
          <select id="mw-trend-story"></select>
          <button id="mw-trend-run" type="button">Show Trend</button>
        </div>
        <div id="mw-trend"></div>
      </div>

      <div class="mw-section" id="mw-delete-section" style="display: none;">
        <div class="mw-section-title mw-danger-title">Advanced Features: Delete Data</div>
        <div class="mw-danger-warning">Warning: deleted snapshots and deleted story data cannot be recovered.</div>
        <!-- Delete Story controls are intentionally hidden for now; keep markup for future restore. -->
        <div class="mw-row" style="display: none;" aria-hidden="true">
          <select id="mw-delete-story"></select>
          <button id="mw-delete-story-btn" type="button">Delete Story</button>
        </div>
        <div class="mw-row">
          <select id="mw-delete-timestamp"></select>
          <button id="mw-delete-timestamp-btn" type="button">Delete Timestamp</button>
        </div>
      </div>
    </aside>
  `;

  document.body.appendChild(wrapper);
}

function wirePanelEvents() {
  const launcher = document.getElementById(PANEL_IDS.launcher);
  const panel = document.getElementById(PANEL_IDS.panel);
  if (!launcher || !panel) {
    return;
  }

  state.launcherEl = launcher;
  state.panelEl = panel;
  state.statusEl = document.getElementById("mw-status");
  state.summaryEl = document.getElementById("mw-summary");
  state.dailySummaryEl = document.getElementById("mw-daily-summary");
  state.dailyFilterPresentationsEl = document.getElementById("mw-filter-presentations");
  state.dailyFilterViewsEl = document.getElementById("mw-filter-views");
  state.dailyFilterReadsEl = document.getElementById("mw-filter-reads");
  state.dailyFilterEarningsEl = document.getElementById("mw-filter-earnings");
  state.compareFilterPresentationsEl = document.getElementById("mw-compare-filter-presentations");
  state.compareFilterViewsEl = document.getElementById("mw-compare-filter-views");
  state.compareFilterReadsEl = document.getElementById("mw-compare-filter-reads");
  state.compareFilterEarningsEl = document.getElementById("mw-compare-filter-earnings");
  state.selectCompareDateA = document.getElementById("mw-compare-a-day");
  state.selectCompareDateB = document.getElementById("mw-compare-b-day");
  state.selectCompareA = document.getElementById("mw-compare-a");
  state.selectCompareB = document.getElementById("mw-compare-b");
  state.diffContainerEl = document.getElementById("mw-diff");
  state.auditSectionEl = document.getElementById("mw-audit-export-section");
  state.auditContainerEl = document.getElementById("mw-audit");
  state.selectTrendStory = document.getElementById("mw-trend-story");
  state.trendFilterContainerEl = document.getElementById("mw-trend-filters");
  state.trendGroupSettingsEl = document.getElementById("mw-trend-group-settings");
  state.trendGroupMaxInputEl = document.getElementById("mw-trend-group-max");
  state.trendSectionEl = document.getElementById("mw-trend-section");
  state.trendChartOverlayEl = document.getElementById("mw-trend-chart-overlay");
  state.trendChartTitleEl = document.getElementById("mw-trend-chart-title");
  state.trendChartSvgEl = document.getElementById("mw-trend-chart-svg");
  state.trendChartCloseBtnEl = document.getElementById("mw-trend-chart-close");
  state.trendContainerEl = document.getElementById("mw-trend");
  state.selectDeleteStory = document.getElementById("mw-delete-story");
  state.selectDeleteTimestamp = document.getElementById("mw-delete-timestamp");
  state.smartCaptureHintEl = document.getElementById("mw-smart-capture-hint");
  state.transferSectionEl = document.getElementById("mw-transfer-section");
  state.deleteSectionEl = document.getElementById("mw-delete-section");
  setAuditSectionVisible(false);
  setTransferSectionVisible(false);
  setDeleteSectionVisible(false);
  setAdvancedFeaturesVisible(false);
  setTrendGroupSettingsVisible(false);

  if (state.trendGroupMaxInputEl) {
    state.trendGroupMaxInputEl.value = String(getTrendGroupMaxSize());
  }

  if (state.diffContainerEl) {
    state.diffContainerEl.addEventListener("click", (event) => {
      const target = event.target;
      if (!(target instanceof Element)) {
        return;
      }

      const sortableHeader = target.closest("th[data-sort-key]");
      if (!sortableHeader) {
        return;
      }

      const sortKey = sortableHeader.getAttribute("data-sort-key") || "";
      toggleCompareSort(sortKey);
    });
  }

  launcher.addEventListener("click", () => togglePanel(!isPanelVisible()));
  document.getElementById("mw-toggle-panel-size").addEventListener("click", () => togglePanelExpanded());
  document.getElementById("mw-close-panel").addEventListener("click", () => togglePanel(false));
  panel.addEventListener("scroll", () => {
    if (state.trendChartOverlayEl && state.trendChartOverlayEl.style.display === "block") {
      positionTrendChartOverlay();
    }
  });

  if (state.trendChartCloseBtnEl) {
    state.trendChartCloseBtnEl.addEventListener("click", () => {
      hideTrendChartOverlay();
    });
  }

  [
    state.dailyFilterPresentationsEl,
    state.dailyFilterViewsEl,
    state.dailyFilterReadsEl,
    state.dailyFilterEarningsEl
  ].forEach((checkbox) => {
    if (!checkbox) {
      return;
    }
    checkbox.addEventListener("change", () => {
      renderDailyChangesSummary();
    });
  });

  [
    state.compareFilterPresentationsEl,
    state.compareFilterViewsEl,
    state.compareFilterReadsEl,
    state.compareFilterEarningsEl
  ].forEach((checkbox) => {
    if (!checkbox) {
      return;
    }
    checkbox.addEventListener("change", () => {
      scheduleCompareRender();
    });
  });

  document.getElementById("mw-manual-snapshot-smart").addEventListener("click", async (event) => {
    try {
      const forceFull = !!event.shiftKey;
      const forceDelta = !!event.altKey;
      let decision;

      if (forceFull) {
        decision = { mode: "full" };
      } else if (forceDelta) {
        decision = { mode: "sparse" };
      } else {
        decision = getSmartCaptureDecision();
      }

      await captureSnapshot("manual", decision.mode, "mw-manual-snapshot-smart");
    } catch (err) {
      setStatus(err.message || "Manual snapshot failed.", true);
    }
  });

  document.getElementById("mw-run-default-compare").addEventListener("click", (event) => {
    const [a, b] = findCompareDatesDefault();
    if (!a || !b) {
      setStatus("Need at least two snapshots for default comparison.", true);
      return;
    }

    setAdvancedFeaturesVisible(!!event.shiftKey);

    refreshSegmentedCompareSelectors(a, b);
    renderDiff(a, b);
    setStatus("Default comparison rendered.");
  });

  document.getElementById("mw-hide-advanced-features").addEventListener("click", () => {
    setAdvancedFeaturesVisible(false);
    setStatus("Advanced Features hidden.");
  });

  if (state.selectCompareDateA) {
    state.selectCompareDateA.addEventListener("change", () => {
      refreshSegmentedCompareSelectors("", state.selectCompareB ? state.selectCompareB.value : "");
      scheduleCompareRender();
    });
  }

  if (state.selectCompareDateB) {
    state.selectCompareDateB.addEventListener("change", () => {
      refreshSegmentedCompareSelectors(state.selectCompareA ? state.selectCompareA.value : "", "");
      scheduleCompareRender();
    });
  }

  if (state.selectCompareA) {
    state.selectCompareA.addEventListener("change", () => {
      scheduleCompareRender();
    });
  }

  if (state.selectCompareB) {
    state.selectCompareB.addEventListener("change", () => {
      scheduleCompareRender();
    });
  }

  document.getElementById("mw-prune-snapshots").addEventListener("click", async () => {
    try {
      await pruneSnapshotsCoalescedDaily();
    } catch (err) {
      setStatus(err.message || "Prune snapshots failed.", true);
    }
  });

  document.getElementById("mw-export-all").addEventListener("click", async () => {
    try {
      await exportAllSnapshotsJson();
    } catch (err) {
      setStatus(err.message || "Export all failed.", true);
    }
  });

  document.getElementById("mw-import-all").addEventListener("click", async () => {
    try {
      const outputEl = document.getElementById("mw-transfer-json-output");
      const raw = outputEl ? outputEl.value : "";
      await importAllSnapshotsJson(raw);
    } catch (err) {
      setStatus(err.message || "Import all failed.", true);
    }
  });

  document.getElementById("mw-audit-compare").addEventListener("click", () => {
    const a = state.selectCompareA.value;
    const b = state.selectCompareB.value;
    setAuditSectionVisible(true);
    renderSnapshotAudit(a, b);
    setStatus("Snapshot audit rendered.");
  });

  document.getElementById("mw-export-compare-json").addEventListener("click", async () => {
    try {
      const a = state.selectCompareA.value;
      const b = state.selectCompareB.value;
      setAuditSectionVisible(true);
      renderSnapshotAudit(a, b);
      await exportSelectedSnapshotsJson(a, b);
    } catch (err) {
      setStatus(err.message || "Export failed.", true);
    }
  });

  document.getElementById("mw-export-audit-json").addEventListener("click", async () => {
    try {
      const a = state.selectCompareA.value;
      const b = state.selectCompareB.value;
      setAuditSectionVisible(true);
      renderSnapshotAudit(a, b);
      await exportSnapshotAuditJson(a, b);
    } catch (err) {
      setStatus(err.message || "Audit export failed.", true);
    }
  });

  document.getElementById("mw-trend-run").addEventListener("click", (event) => {
    if (event.shiftKey) {
      setTrendGroupSettingsVisible(true);
      if (state.trendGroupMaxInputEl) {
        state.trendGroupMaxInputEl.value = String(getTrendGroupMaxSize());
      }
      setStatus("Trend group size settings revealed.");
    }
    const selectedStory = resolveSelectedTrendStory();
    renderTrend(selectedStory);
    showTrendChartOverlay(selectedStory);
  });

  document.getElementById("mw-trend-group-apply").addEventListener("click", async () => {
    const input = state.trendGroupMaxInputEl;
    if (!input) {
      return;
    }

    const parsed = Number.parseInt(String(input.value || ""), 10);
    if (!Number.isFinite(parsed) || parsed < MIN_TREND_GROUP_MAX_SIZE || parsed > MAX_TREND_GROUP_MAX_SIZE) {
      setStatus(`Max stories per filter must be a whole number from ${MIN_TREND_GROUP_MAX_SIZE} to ${MAX_TREND_GROUP_MAX_SIZE}.`, true);
      input.value = String(getTrendGroupMaxSize());
      return;
    }

    state.trendGroupMaxSize = sanitizeTrendGroupMaxSize(parsed);
    await persistTrendGroupMaxSetting();
    input.value = String(getTrendGroupMaxSize());
    refreshSelectOptions();
    renderTrend(state.selectTrendStory ? state.selectTrendStory.value : "");
    setStatus(`Trend filter max set to ${state.trendGroupMaxSize} stories per group.`);
  });

  if (state.trendFilterContainerEl) {
    state.trendFilterContainerEl.addEventListener("click", (event) => {
      const target = event.target;
      if (!(target instanceof Element)) {
        return;
      }

      const button = target.closest("button[data-trend-group-key]");
      if (!button) {
        return;
      }

      const groupKey = button.getAttribute("data-trend-group-key") || "";
      if (!groupKey || groupKey === state.activeTrendStoryGroupKey) {
        return;
      }

      state.activeTrendStoryGroupKey = groupKey;
      refreshSelectOptions(groupKey);
      renderTrend(state.selectTrendStory ? state.selectTrendStory.value : "");
    });
  }

  document.getElementById("mw-delete-story-btn").addEventListener("click", async () => {
    try {
      await deleteByStory(state.selectDeleteStory.value);
      refreshPanelData();
      setStatus("Story data deleted.");
    } catch (err) {
      setStatus(err.message || "Delete by story failed.", true);
    }
  });

  document.getElementById("mw-delete-timestamp-btn").addEventListener("click", async () => {
    try {
      await deleteByTimestamp(state.selectDeleteTimestamp.value);
      refreshPanelData();
      setStatus("Timestamp snapshot deleted.");
    } catch (err) {
      setStatus(err.message || "Delete by timestamp failed.", true);
    }
  });

  state.selectTrendStory.addEventListener("change", () => renderTrend(state.selectTrendStory.value));
}

function wireKeyboardShortcuts() {
  if (state.keyboardShortcutsWired) {
    return;
  }
  state.keyboardShortcutsWired = true;

  document.addEventListener("keydown", async (event) => {
    if (!(event.altKey && event.shiftKey)) {
      return;
    }

    if (!isTargetPage()) {
      return;
    }

    if (event.code === "KeyS") {
      event.preventDefault();
      togglePanel(true);
      try {
        await captureSnapshot("manual", "auto");
      } catch (err) {
        setStatus(err.message || "Shortcut snapshot failed.", true);
      }
      return;
    }

    if (event.code === "Digit0") {
      event.preventDefault();
      togglePanel(true);
      if (state.selectCompareA) {
        state.selectCompareA.focus();
      }
      return;
    }

    if (event.code === "KeyD") {
      event.preventDefault();
      togglePanel(true);
      renderDailyChangesSummary();
      const section = document.getElementById("mw-daily-summary-section");
      if (section) {
        section.scrollIntoView({ behavior: "smooth", block: "start" });
      }
    }
  });
}

function wireRuntimeMessages() {
  if (state.runtimeMessagesWired) {
    return;
  }
  state.runtimeMessagesWired = true;

  if (!chrome.runtime || !chrome.runtime.onMessage) {
    return;
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    (async () => {
      try {
        if (!message || !message.action) {
          sendResponse({ ok: false, error: "No action provided." });
          return;
        }

        if (message.action === "openPanel") {
          if (!isTargetPage()) {
            sendResponse({ ok: false, error: "Open https://medium.com/me/stats to use this extension." });
            return;
          }
          togglePanel(true);
          sendResponse({ ok: true });
          return;
        }

        if (message.action === "captureManualSnapshot") {
          if (!isTargetPage()) {
            sendResponse({ ok: false, error: "Open https://medium.com/me/stats to use this extension." });
            return;
          }
          togglePanel(true);
          await captureSnapshot("manual", "auto");
          sendResponse({ ok: true });
          return;
        }

        if (message.action === "focusComparison") {
          if (!isTargetPage()) {
            sendResponse({ ok: false, error: "Open https://medium.com/me/stats to use this extension." });
            return;
          }
          togglePanel(true);
          if (state.selectCompareA) {
            state.selectCompareA.focus();
          }
          sendResponse({ ok: true });
          return;
        }

        sendResponse({ ok: false, error: `Unknown action: ${message.action}` });
      } catch (err) {
        sendResponse({ ok: false, error: err.message || "Unhandled runtime message error." });
      }
    })();

    return true;
  });
}

async function runAutomaticSnapshotIfNeeded() {
  const today = toDateKey(nowIso());
  const result = await getStorage([STORAGE_KEYS.lastAutoSnapshotDate]);
  const lastDate = result[STORAGE_KEYS.lastAutoSnapshotDate] || "";

  if (lastDate === today) {
    return;
  }

  try {
    const decision = getSmartCaptureDecision();
    await captureSnapshot("auto", decision.mode);
    await setStorage({
      [STORAGE_KEYS.lastAutoSnapshotDate]: today
    });
  } catch (err) {
    setStatus(`Auto snapshot failed: ${err.message || "unknown error"}`, true);
  }
}

async function init() {
  if (!isTargetPage()) {
    return;
  }
  if (document.getElementById(PANEL_IDS.wrapper)) {
    return;
  }

  createPanelMarkup();
  wirePanelEvents();
  wireKeyboardShortcuts();
  wireRuntimeMessages();
  startRouteWatcher();
  syncPanelVisibilityToRoute();

  await loadTrendGroupMaxSetting();
  await loadSnapshots();
  refreshPanelData();

  state.panelReady = true;
  setStatus("Ready.");

  await runAutomaticSnapshotIfNeeded();
}

init().catch((err) => {
  const msg = err && err.message ? err.message : "Initialization failed.";
  console.error("Writer Success Stats for Medium init error:", msg);
});