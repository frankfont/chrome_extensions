/*
  Medium Writer Success Stats content script

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
const AUTO_SCROLL_MAX_ITERATIONS = 40;
const AUTO_SCROLL_DELAY_MS = 450;
const ROUTE_CHECK_INTERVAL_MS = 500;

const STORAGE_KEYS = {
  snapshots: "mwSnapshots",
  lastAutoSnapshotDate: "mwLastAutoSnapshotDate"
};

const PANEL_IDS = {
  wrapper: "mw-stats-panel-wrapper",
  panel: "mw-stats-panel",
  launcher: "mw-stats-launcher"
};

const state = {
  snapshots: [],
  panelReady: false,
  launcherEl: null,
  panelEl: null,
  selectCompareDateA: null,
  selectCompareDateB: null,
  selectCompareA: null,
  selectCompareB: null,
  selectTrendStory: null,
  selectDeleteStory: null,
  selectDeleteTimestamp: null,
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
  transferSectionEl: null
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
  const match = String(url).match(/\/p\/([a-zA-Z0-9]+)/);
  return match ? match[1] : "";
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

function getStorage(keys) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get(keys, (result) => {
      const err = chrome.runtime.lastError;
      if (err) {
        reject(new Error(err.message));
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
        reject(new Error(err.message));
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

function setSnapshotCaptureUiBusy(isBusy) {
  const button = document.getElementById("mw-manual-snapshot");
  if (!button) {
    return;
  }
  button.disabled = !!isBusy;
  button.classList.toggle("mw-busy-action", !!isBusy);
  button.textContent = isBusy ? "Creating snapshot now..." : "Capture Manual Snapshot";

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

async function autoScrollForDataRows() {
  let stableLoops = 0;
  let lastCount = countPotentialRows();

  for (let i = 0; i < AUTO_SCROLL_MAX_ITERATIONS; i += 1) {
    window.scrollTo(0, document.body.scrollHeight);
    await sleep(AUTO_SCROLL_DELAY_MS);

    const currentCount = countPotentialRows();
    if (currentCount <= lastCount) {
      stableLoops += 1;
    } else {
      stableLoops = 0;
      lastCount = currentCount;
    }

    if (stableLoops >= AUTO_SCROLL_STABLE_ITERATIONS) {
      break;
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
    const mediumUrl = storyLink ? storyLink.href : "";
    const storyId = getStoryIdFromUrl(mediumUrl);

    // Require a Medium story link to avoid parsing unrelated page tables.
    const hasMediumStoryLink =
      !!storyLink &&
      (mediumUrl.includes("medium.com/me/stats/post/") || mediumUrl.includes("medium.com/p/") || mediumUrl.includes("/p/"));
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

function buildSnapshot(rows, mode) {
  const capturedAt = nowIso();
  const stories = rows.map((row) => ({
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

  return {
    id: capturedAt,
    mode,
    capturedAt,
    sourceUrl: window.location.href,
    stories
  };
}

async function loadSnapshots() {
  const result = await getStorage([STORAGE_KEYS.snapshots]);
  state.snapshots = Array.isArray(result[STORAGE_KEYS.snapshots]) ? result[STORAGE_KEYS.snapshots] : [];
  state.snapshots.sort((a, b) => new Date(a.capturedAt).getTime() - new Date(b.capturedAt).getTime());
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

async function captureSnapshot(mode) {
  ensureTargetPage();
  setStatus("Creating snapshot now...");
  setSnapshotCaptureUiBusy(true);

  try {
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

    const previousSnapshot = findLatestSnapshot();
    const readDecreases = findReadDecreasesComparedToSnapshot(rows, previousSnapshot);
    if (readDecreases.length) {
      const sample = readDecreases[0];
      throw new Error(
        `Snapshot not saved: Reads decreased for ${readDecreases.length} story(s) vs previous snapshot (example: ${formatStoryTitleForDisplay(sample.storyName)} ${formatNumber(sample.previousReads)} -> ${formatNumber(sample.currentReads)}). Refresh stats and ensure the same Medium date filter before capturing.`
      );
    }

    const snapshot = buildSnapshot(rows, mode);
    state.snapshots.push(snapshot);
    state.snapshots.sort((a, b) => new Date(a.capturedAt).getTime() - new Date(b.capturedAt).getTime());
    await persistSnapshots();
    refreshPanelData();
    setStatus(`Snapshot captured: ${snapshot.stories.length} stories (${mode}).`);
  } finally {
    setSnapshotCaptureUiBusy(false);
  }
}

function getSnapshotById(id) {
  return state.snapshots.find((snapshot) => snapshot.id === id) || null;
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

function computeDiffRows(baseSnapshot, targetSnapshot) {
  const baseMap = buildStoryMap(baseSnapshot);
  const targetMap = buildStoryMap(targetSnapshot);
  const keys = new Set([...baseMap.keys(), ...targetMap.keys()]);

  const diffRows = [];
  keys.forEach((key) => {
    const a = baseMap.get(key) || null;
    const b = targetMap.get(key) || null;

    const storyName = (b && b.storyName) || (a && a.storyName) || "(Unknown Story)";
    const storyUrl = (b && getStatsPostUrl(b)) || (a && getStatsPostUrl(a)) || "";
    const status = !a && b ? "new" : a && !b ? "removed" : "existing";

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
    state.launcherEl.title = "Open Medium Stats panel (reads/earnings increased since prior day)";
    return;
  }

  state.launcherEl.style.background = "#fff";
  state.launcherEl.style.borderColor = "#111";
  state.launcherEl.style.color = "#111";
  state.launcherEl.title = "Open Medium Stats panel";
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

  const rows = computeDiffRows(baseSnapshot, targetSnapshot)
    .filter((row) => hasAnyTrackedChange(row, metricFilters));
  const header = `<div class="mw-compare-title">Comparing ${formatTimestamp(baseSnapshot.capturedAt)} to ${formatTimestamp(targetSnapshot.capturedAt)}</div>`;

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
      <td class="${toneClass(row.earningsPct)}">${formatSignedPercent(row.earningsPct)}</td>
    </tr>
  `).join("");

  state.diffContainerEl.innerHTML = `
    ${header}
    <div class="mw-table-wrap">
      <table class="mw-table">
        <thead>
          <tr>
            <th>Story</th>
            <th>Status</th>
            <th>Views A</th>
            <th>Views B</th>
            <th>Views Δ</th>
            <th>Reads A</th>
            <th>Reads B</th>
            <th>Reads Δ</th>
            <th>Earnings A</th>
            <th>Earnings B</th>
            <th>Earnings Δ</th>
            <th>Earnings %</th>
          </tr>
        </thead>
        <tbody>
          ${tableRows || "<tr><td colspan='12'>No comparable rows found.</td></tr>"}
        </tbody>
      </table>
    </div>
  `;
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

  const header = `
    <div class="mw-summary-head">Snapshot Audit: ${formatTimestamp(baseSnapshot.capturedAt)} to ${formatTimestamp(targetSnapshot.capturedAt)}</div>
    <div class="mw-summary-count">Existing stories: ${rows.length}. Suspicious rows: ${suspicious.length}.</div>
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
  refreshPanelData();
  setStatus(`Imported ${state.snapshots.length} snapshots.`);
}

async function pruneSnapshotsKeepEarliestPerDay() {
  if (!state.snapshots.length) {
    setStatus("No snapshots available to prune.");
    return;
  }

  const sorted = [...state.snapshots].sort((a, b) => new Date(a.capturedAt).getTime() - new Date(b.capturedAt).getTime());
  const earliestByDay = new Map();

  sorted.forEach((snapshot) => {
    const dayKey = toDateKey(snapshot.capturedAt);
    if (!earliestByDay.has(dayKey)) {
      earliestByDay.set(dayKey, snapshot);
    }
  });

  const pruned = Array.from(earliestByDay.values()).sort((a, b) => new Date(a.capturedAt).getTime() - new Date(b.capturedAt).getTime());
  const beforeCount = state.snapshots.length;
  const afterCount = pruned.length;
  const removedCount = beforeCount - afterCount;

  if (removedCount <= 0) {
    setStatus("No duplicate same-day snapshots found to prune.");
    return;
  }

  const confirmMessage = `Prune Snapshots will permanently delete ${removedCount} snapshot(s) and keep ${afterCount} earliest-of-day snapshot(s).\n\nDo you want to continue?`;
  const confirmed = window.confirm(confirmMessage);
  if (!confirmed) {
    setStatus("Prune canceled.");
    return;
  }

  state.snapshots = pruned;
  await persistSnapshots();
  refreshPanelData();
  setStatus(`Pruned snapshots: removed ${removedCount}, kept ${afterCount}.`);
}

function getAllStoryNames() {
  const names = new Set();
  state.snapshots.forEach((snapshot) => {
    snapshot.stories.forEach((story) => names.add(story.storyName));
  });
  return Array.from(names).sort((a, b) => a.localeCompare(b));
}

function renderTrend(storyName) {
  if (!state.trendContainerEl) {
    return;
  }

  if (!storyName) {
    state.trendContainerEl.innerHTML = "<div class='mw-empty'>Select a story to see trend history.</div>";
    return;
  }

  const rows = [];
  state.snapshots.forEach((snapshot) => {
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
  const filteredRows = rows.filter((row) => {
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

  if (!filteredRows.length) {
    state.trendContainerEl.innerHTML = "<div class='mw-empty'>No trend data for this story.</div>";
    return;
  }

  const tableRows = filteredRows.map((row) => `
    <tr>
      <td>${formatTimestamp(row.capturedAt)}</td>
      <td>${formatNumber(row.views)}</td>
      <td>${formatNumber(row.reads)}</td>
      <td>${formatCurrency(row.earnings)}</td>
    </tr>
  `).join("");

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
  button.textContent = expanded ? "Collapse" : "Expand";
  button.title = expanded ? "Collapse panel width" : "Expand panel width";
}

function refreshSnapshotSummary() {
  if (!state.summaryEl) {
    return;
  }
  const count = state.snapshots.length;
  const latest = count ? state.snapshots[count - 1] : null;
  state.summaryEl.innerHTML = `
    <div><strong>Snapshots:</strong> ${count}</div>
    <div><strong>Latest:</strong> ${latest ? formatTimestamp(latest.capturedAt) : "None"}</div>
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

function refreshSelectOptions() {
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
    state.selectTrendStory.innerHTML = "";
    const empty = document.createElement("option");
    empty.value = "";
    empty.textContent = "Select a story";
    state.selectTrendStory.appendChild(empty);
    stories.forEach((storyName) => {
      const option = document.createElement("option");
      option.value = storyName;
      option.textContent = formatStoryTitleForDisplay(storyName);
      state.selectTrendStory.appendChild(option);
    });
    if (old && stories.includes(old)) {
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
        border-radius: 22px;
        border: 1px solid #111;
        background: #fff;
        color: #111;
        z-index: 2147483646;
        font-size: 14px;
        font-weight: 700;
        cursor: pointer;
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

    <button id="${PANEL_IDS.launcher}" title="Open Medium Stats panel">MWS</button>

    <aside id="${PANEL_IDS.panel}" aria-live="polite">
      <div class="mw-row mw-panel-header" style="justify-content: space-between; align-items: center;">
        <div class="mw-title">Medium Writer Success Stats</div>
        <div class="mw-row" style="margin-bottom: 0;">
          <a class="mw-profile-link" href="https://medium.com/@frankfont123" target="_blank" rel="noopener noreferrer" title="Open @frankfont123 on Medium">
            <img src="${chrome.runtime.getURL("author.png")}" alt="Frank Font profile" />
          </a>
          <button id="mw-toggle-panel-size" type="button" title="Expand panel width">Expand</button>
          <button id="mw-close-panel" type="button">Close</button>
        </div>
      </div>

      <div id="mw-status" class="mw-status">Ready.</div>
      <div id="mw-summary" class="mw-summary"></div>

      <div class="mw-section" id="mw-daily-summary-section">
        <div class="mw-row" style="justify-content: space-between; align-items: center;">
          <div class="mw-section-title" style="margin-bottom: 0;">Daily Changes Summary</div>
          <button id="mw-refresh-daily-summary" type="button">Refresh</button>
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
        <div class="mw-row">
          <button id="mw-manual-snapshot" type="button">Capture Manual Snapshot</button>
          <button id="mw-run-default-compare" type="button">Run Default Comparison</button>
          <button id="mw-open-transfer-data" type="button">Transfer Data</button>
          <button id="mw-prune-snapshots" type="button">Prune Snapshots</button>
        </div>
      </div>

      <div class="mw-section" id="mw-transfer-section" style="display: none;">
        <div class="mw-section-title">Transfer Data</div>
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
          <button id="mw-compare-run" type="button">Compare</button>
          <button id="mw-audit-compare" type="button">Audit Snapshot Pair</button>
          <button id="mw-export-compare-json" type="button">Export A/B JSON</button>
        </div>
        <div id="mw-diff"></div>
        <div id="mw-audit-export-section" style="display: none; margin-top: 8px;">
          <div id="mw-audit"></div>
          <textarea id="mw-export-json-output" class="mw-export-output" readonly placeholder="Exported A/B snapshot JSON appears here."></textarea>
        </div>
      </div>

      <div class="mw-section">
        <div class="mw-section-title">Trend Over Time</div>
        <div class="mw-row">
          <select id="mw-trend-story"></select>
          <button id="mw-trend-run" type="button">Show Trend</button>
        </div>
        <div id="mw-trend"></div>
      </div>

      <div class="mw-section">
        <div class="mw-section-title">Delete Data</div>
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
  state.trendContainerEl = document.getElementById("mw-trend");
  state.selectDeleteStory = document.getElementById("mw-delete-story");
  state.selectDeleteTimestamp = document.getElementById("mw-delete-timestamp");
  state.transferSectionEl = document.getElementById("mw-transfer-section");
  setAuditSectionVisible(false);
  setTransferSectionVisible(false);

  launcher.addEventListener("click", () => togglePanel(!isPanelVisible()));
  document.getElementById("mw-toggle-panel-size").addEventListener("click", () => togglePanelExpanded());
  document.getElementById("mw-close-panel").addEventListener("click", () => togglePanel(false));
  document.getElementById("mw-refresh-daily-summary").addEventListener("click", () => {
    renderDailyChangesSummary();
    setStatus("Daily changes summary refreshed.");
  });

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
      renderDiff(state.selectCompareA ? state.selectCompareA.value : "", state.selectCompareB ? state.selectCompareB.value : "");
    });
  });

  document.getElementById("mw-manual-snapshot").addEventListener("click", async () => {
    try {
      await captureSnapshot("manual");
    } catch (err) {
      setStatus(err.message || "Manual snapshot failed.", true);
    }
  });

  document.getElementById("mw-run-default-compare").addEventListener("click", () => {
    const [a, b] = findCompareDatesDefault();
    if (!a || !b) {
      setStatus("Need at least two snapshots for default comparison.", true);
      return;
    }
    refreshSegmentedCompareSelectors(a, b);
    renderDiff(a, b);
    setStatus("Default comparison rendered.");
  });

  if (state.selectCompareDateA) {
    state.selectCompareDateA.addEventListener("change", () => {
      refreshSegmentedCompareSelectors("", state.selectCompareB ? state.selectCompareB.value : "");
    });
  }

  if (state.selectCompareDateB) {
    state.selectCompareDateB.addEventListener("change", () => {
      refreshSegmentedCompareSelectors(state.selectCompareA ? state.selectCompareA.value : "", "");
    });
  }

  document.getElementById("mw-open-transfer-data").addEventListener("click", () => {
    setTransferSectionVisible(true);
    setStatus("Transfer Data section opened.");
  });

  document.getElementById("mw-prune-snapshots").addEventListener("click", async () => {
    try {
      await pruneSnapshotsKeepEarliestPerDay();
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

  document.getElementById("mw-compare-run").addEventListener("click", () => {
    const a = state.selectCompareA.value;
    const b = state.selectCompareB.value;
    renderDiff(a, b);
    setStatus("Comparison rendered.");
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

  document.getElementById("mw-trend-run").addEventListener("click", () => {
    renderTrend(state.selectTrendStory.value);
  });

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
        await captureSnapshot("manual");
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
          await captureSnapshot("manual");
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
    await captureSnapshot("auto");
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

  await loadSnapshots();
  refreshPanelData();

  state.panelReady = true;
  setStatus("Ready.");

  await runAutomaticSnapshotIfNeeded();
}

init().catch((err) => {
  const msg = err && err.message ? err.message : "Initialization failed.";
  console.error("Medium Writer Success Stats init error:", msg);
});