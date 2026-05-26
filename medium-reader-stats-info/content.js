/*
  Medium Reader Stats Info content script

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
  trendContainerEl: null
};

function isTargetPage() {
  return window.location.href.startsWith(TARGET_URL_PREFIX);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toDateKey(iso) {
  return new Date(iso).toISOString().slice(0, 10);
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
  state.statusEl.style.color = isError ? "#8f1111" : "#0f5132";
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

async function captureSnapshot(mode) {
  ensureTargetPage();
  setStatus("Capturing snapshot...");

  await autoScrollForDataRows();
  const rows = extractStoryRows();
  if (!rows.length) {
    throw new Error("No story rows found. Confirm you are logged into Medium and your stats page is loaded.");
  }

  const snapshot = buildSnapshot(rows, mode);
  state.snapshots.push(snapshot);
  state.snapshots.sort((a, b) => new Date(a.capturedAt).getTime() - new Date(b.capturedAt).getTime());
  await persistSnapshots();
  refreshPanelData();
  setStatus(`Snapshot captured: ${snapshot.stories.length} stories (${mode}).`);
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

  const metricFilters = getDailySummaryMetricFilters();
  if (!Object.values(metricFilters).some(Boolean)) {
    state.dailySummaryEl.innerHTML = `
      <div class="mw-summary-head">Comparing ${formatTimestamp(baseSnapshot.capturedAt)} to ${formatTimestamp(targetSnapshot.capturedAt)}</div>
      <div class='mw-empty'>Enable at least one metric filter to show stories.</div>
    `;
    return;
  }

  const changedRows = computeDiffRows(baseSnapshot, targetSnapshot)
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
        <div class="mw-change-title">${row.storyName}</div>
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
      <td>${row.storyName}</td>
      <td>${row.status}</td>
      <td>${formatNumber(row.viewsA)}</td>
      <td>${formatNumber(row.viewsB)}</td>
      <td class="${toneClass(row.viewsDelta)}">${formatSignedNumber(row.viewsDelta)}</td>
      <td class="${toneClass(row.viewsPct)}">${formatSignedPercent(row.viewsPct)}</td>
      <td>${formatNumber(row.readsA)}</td>
      <td>${formatNumber(row.readsB)}</td>
      <td class="${toneClass(row.readsDelta)}">${formatSignedNumber(row.readsDelta)}</td>
      <td class="${toneClass(row.readsPct)}">${formatSignedPercent(row.readsPct)}</td>
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
            <th>Views %</th>
            <th>Reads A</th>
            <th>Reads B</th>
            <th>Reads Δ</th>
            <th>Reads %</th>
            <th>Earnings A</th>
            <th>Earnings B</th>
            <th>Earnings Δ</th>
            <th>Earnings %</th>
          </tr>
        </thead>
        <tbody>
          ${tableRows || "<tr><td colspan='14'>No comparable rows found.</td></tr>"}
        </tbody>
      </table>
    </div>
  `;
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

  applyOptions(state.selectCompareA, "Select base snapshot");
  applyOptions(state.selectCompareB, "Select target snapshot");
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
      option.textContent = storyName;
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
      option.textContent = storyName;
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
  if (state.selectCompareA && !state.selectCompareA.value && defaultA) {
    state.selectCompareA.value = defaultA;
  }
  if (state.selectCompareB && !state.selectCompareB.value && defaultB) {
    state.selectCompareB.value = defaultB;
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
      #${PANEL_IDS.panel} .mw-title {
        font-size: 14px;
        font-weight: 700;
      }
      #${PANEL_IDS.panel} .mw-status {
        font-size: 12px;
        margin: 6px 0;
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
      #${PANEL_IDS.panel} .mw-change-meta {
        color: #555;
        margin: 2px 0 4px;
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
    </style>

    <button id="${PANEL_IDS.launcher}" title="Open Medium Stats panel">MW</button>

    <aside id="${PANEL_IDS.panel}" aria-live="polite">
      <div class="mw-row" style="justify-content: space-between; align-items: center;">
        <div class="mw-title">Medium Reader Stats</div>
        <div class="mw-row" style="margin-bottom: 0;">
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
        </div>
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
          <select id="mw-compare-a"></select>
          <select id="mw-compare-b"></select>
          <button id="mw-compare-run" type="button">Compare</button>
        </div>
        <div id="mw-diff"></div>
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
        <div class="mw-row">
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
  state.selectCompareA = document.getElementById("mw-compare-a");
  state.selectCompareB = document.getElementById("mw-compare-b");
  state.diffContainerEl = document.getElementById("mw-diff");
  state.selectTrendStory = document.getElementById("mw-trend-story");
  state.trendContainerEl = document.getElementById("mw-trend");
  state.selectDeleteStory = document.getElementById("mw-delete-story");
  state.selectDeleteTimestamp = document.getElementById("mw-delete-timestamp");

  launcher.addEventListener("click", () => togglePanel(panel.style.display === "none"));
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
    state.selectCompareA.value = a;
    state.selectCompareB.value = b;
    renderDiff(a, b);
    setStatus("Default comparison rendered.");
  });

  document.getElementById("mw-compare-run").addEventListener("click", () => {
    const a = state.selectCompareA.value;
    const b = state.selectCompareB.value;
    renderDiff(a, b);
    setStatus("Comparison rendered.");
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
  document.addEventListener("keydown", async (event) => {
    if (!(event.altKey && event.shiftKey)) {
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
          togglePanel(true);
          sendResponse({ ok: true });
          return;
        }

        if (message.action === "captureManualSnapshot") {
          togglePanel(true);
          await captureSnapshot("manual");
          sendResponse({ ok: true });
          return;
        }

        if (message.action === "focusComparison") {
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

  await loadSnapshots();
  refreshPanelData();

  state.panelReady = true;
  setStatus("Ready.");

  await runAutomaticSnapshotIfNeeded();
}

init().catch((err) => {
  const msg = err && err.message ? err.message : "Initialization failed.";
  console.error("Medium Reader Stats init error:", msg);
});