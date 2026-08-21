const state = {
  families: [],
  suggestedLinks: [],
  searchResults: null, // null = showing the normal tracked-document list, an array = showing search results
  selectedId: null,
  view: "documents",
  viewingHash: null, // which version is currently loaded in the reading frame
  lastKnownHeadVersion: null, // headVersion as of the last time we synced with the server
  bulkSelectedIds: new Set(), // family ids checked for bulk actions, persists across list re-renders
};

// Bumped by every selectFamily() call. A concurrent background refresh
// (from an SSE event or window focus) checks this before acting on its own
// response - without it, a refresh that started before a fresh selection
// but resolves after it can compare against not-yet-set null values and
// falsely report "a new version arrived" when nothing actually changed.
let selectionToken = 0;

const el = {
  banner: document.getElementById("reconnect-banner"),
  navDocuments: document.getElementById("nav-documents"),
  navSettings: document.getElementById("nav-settings"),
  viewDocuments: document.getElementById("view-documents"),
  viewSettings: document.getElementById("view-settings"),
  familyList: document.getElementById("family-list"),
  familyListLabel: document.getElementById("family-list-label"),
  bulkActionsBar: document.getElementById("bulk-actions-bar"),
  bulkActionsCount: document.getElementById("bulk-actions-count"),
  bulkUntrackButton: document.getElementById("bulk-untrack-button"),
  bulkClearButton: document.getElementById("bulk-clear-button"),
  searchInput: document.getElementById("search-input"),
  searchClear: document.getElementById("search-clear"),
  familyEmpty: document.getElementById("family-empty"),
  familyDetail: document.getElementById("family-detail"),
  detailTitle: document.getElementById("detail-title"),
  detailMeta: document.getElementById("detail-meta"),
  detailTags: document.getElementById("detail-tags"),
  renameButton: document.getElementById("rename-button"),
  openInTab: document.getElementById("open-in-tab"),
  downloadVersion: document.getElementById("download-version"),
  lavishPromptButton: document.getElementById("lavish-prompt-button"),
  lavishPromptStatus: document.getElementById("lavish-prompt-status"),
  untrackButton: document.getElementById("untrack-button"),
  revertButton: document.getElementById("revert-button"),
  openCompareButton: document.getElementById("open-compare-button"),
  compareModal: document.getElementById("compare-modal"),
  compareModalClose: document.getElementById("compare-modal-close"),
  compareFrom: document.getElementById("compare-from"),
  compareTo: document.getElementById("compare-to"),
  compareButton: document.getElementById("compare-button"),
  compareOutput: document.getElementById("compare-output"),
  compareModeText: document.getElementById("compare-mode-text"),
  compareModeRendered: document.getElementById("compare-mode-rendered"),
  compareRendered: document.getElementById("compare-rendered"),
  compareFrameFrom: document.getElementById("compare-frame-from"),
  compareFrameTo: document.getElementById("compare-frame-to"),
  timeline: document.getElementById("timeline"),
  readingFrame: document.getElementById("reading-frame"),
  versionBanner: document.getElementById("version-banner"),
  versionBannerAction: document.getElementById("version-banner-action"),
  settingsForm: document.getElementById("settings-form"),
  snapshotRemoteToken: document.getElementById("snapshot-remote-token"),
  clearTokenButton: document.getElementById("clear-token-button"),
  tokenStatus: document.getElementById("token-status"),
  checkSshButton: document.getElementById("check-ssh-button"),
  sshCheckOutput: document.getElementById("ssh-check-output"),
  themeSystem: document.getElementById("theme-system"),
  themeLight: document.getElementById("theme-light"),
  themeDark: document.getElementById("theme-dark"),
  stopCoreButton: document.getElementById("stop-core-button"),
  stopCoreStatus: document.getElementById("stop-core-status"),
  snapshotRemote: document.getElementById("snapshot-remote"),
  settingsStatus: document.getElementById("settings-status"),
  trackForm: document.getElementById("track-form"),
  trackPaths: document.getElementById("track-paths"),
  trackPreview: document.getElementById("track-preview"),
  trackRelink: document.getElementById("track-relink"),
  trackRelinkReason: document.getElementById("track-relink-reason"),
  trackStatus: document.getElementById("track-status"),
  trackCollisions: document.getElementById("track-collisions"),
};

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body !== undefined ? { "content-type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(json?.error ?? `Request failed with status ${res.status}`);
  }
  return json;
}

function formatDate(iso) {
  if (!iso) return "";
  return new Date(iso).toLocaleString();
}

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text ?? "";
  return div.innerHTML;
}

// The server marks a search snippet's matched terms with **...** (a plain,
// terminal-friendly convention the CLI shows as-is) - escape the real
// document text first, THEN turn the markers into <mark> tags, so this
// never re-interprets anything from the document's own content as markup.
function highlightSnippet(text) {
  return escapeHtml(text).replace(/\*\*(.+?)\*\*/g, "<mark>$1</mark>");
}

const DOC_ICON =
  '<svg viewBox="0 0 20 20" fill="none" width="16" height="16"><path d="M5 2.5h7l3.5 3.5V17a.5.5 0 0 1-.5.5H5a.5.5 0 0 1-.5-.5V3a.5.5 0 0 1 .5-.5Z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M12 2.5V6h3.5" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>';

// Maps each family id to the OTHER synthetic paths a cheap heuristic (title
// or structural match, see suggest.js) thinks it might be the same document
// as - suggestion-only, never acted on automatically, so this only ever
// renders an informational badge, never a "link" action of its own.
function possibleDuplicatesByFamilyId() {
  const map = new Map();
  for (const s of state.suggestedLinks) {
    if (!map.has(s.a.id)) map.set(s.a.id, []);
    map.get(s.a.id).push(s.b.syntheticPath);
    if (!map.has(s.b.id)) map.set(s.b.id, []);
    map.get(s.b.id).push(s.a.syntheticPath);
  }
  return map;
}

function renderSearchResults() {
  el.familyListLabel.textContent = `Search results (${state.searchResults.length})`;
  if (state.searchResults.length === 0) {
    el.familyList.innerHTML = '<p class="empty">No matching documents.</p>';
    return;
  }

  const items = state.searchResults
    .map((r) => {
      const isSelected = r.id === state.selectedId;
      const selected = isSelected ? " selected" : "";
      const checked = state.bulkSelectedIds.has(r.id) ? " checked" : "";
      return `<li class="${selected.trim()}" data-id="${r.id}" role="button" tabindex="0" aria-current="${isSelected}">
        <input type="checkbox" class="family-select" data-id="${r.id}"${checked} aria-label="Select for bulk actions" />
        ${DOC_ICON}
        <div class="item-text">
          <div class="path">${escapeHtml(r.syntheticPath)}</div>
          <div class="meta search-snippet">${highlightSnippet(r.snippet ?? r.docTitle ?? "")}</div>
        </div>
      </li>`;
    })
    .join("");
  el.familyList.innerHTML = `<ul>${items}</ul>`;
  wireFamilyListItems();
}

function renderFamilyList() {
  if (state.searchResults !== null) {
    renderSearchResults();
    return;
  }
  el.familyListLabel.textContent = "Tracked documents";

  if (state.families.length === 0) {
    el.familyList.innerHTML = '<p class="empty">Nothing tracked yet.</p>';
    return;
  }

  const duplicates = possibleDuplicatesByFamilyId();

  const items = state.families
    .map((family) => {
      const isSelected = family.id === state.selectedId;
      const selected = isSelected ? " selected" : "";
      const checked = state.bulkSelectedIds.has(family.id) ? " checked" : "";
      const otherPaths = duplicates.get(family.id);
      const dupBadge = otherPaths
        ? `<span class="dup-badge" title="Possibly the same document as ${escapeHtml(otherPaths.join(", "))}">possible duplicate</span>`
        : "";
      const tagBadges = (family.tags ?? [])
        .map((t) => `<span class="tag-chip tag-chip-small">${escapeHtml(t)}</span>`)
        .join("");
      return `<li class="${selected.trim()}" data-id="${family.id}" role="button" tabindex="0" aria-current="${isSelected}">
        <input type="checkbox" class="family-select" data-id="${family.id}"${checked} aria-label="Select for bulk actions" />
        ${DOC_ICON}
        <div class="item-text">
          <div class="path">${escapeHtml(family.syntheticPath)}</div>
          <div class="meta">${family.versionCount} version${family.versionCount === 1 ? "" : "s"}${dupBadge}${tagBadges}</div>
        </div>
      </li>`;
    })
    .join("");

  el.familyList.innerHTML = `<ul>${items}</ul>`;
  wireFamilyListItems();
}

// Activates a row on Enter/Space the same way a real <button> would,
// without swallowing every other key (Tab, arrows) so normal keyboard
// scrolling/focus movement through the list keeps working unchanged.
// Ignores the event when it bubbled up from a real nested control (e.g. the
// timeline's own per-chip delete <button>) - keydown bubbles even though
// that button's own click handler calls stopPropagation(), so without this
// guard, deleting a version with the keyboard would also wrongly select it.
function onActivateKeydown(handler) {
  return (event) => {
    if (event.target !== event.currentTarget) return;
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    handler();
  };
}

function wireFamilyListItems() {
  for (const li of el.familyList.querySelectorAll("li")) {
    li.addEventListener("click", () => selectFamily(li.dataset.id));
    li.addEventListener("keydown", onActivateKeydown(() => selectFamily(li.dataset.id)));
  }
  for (const checkbox of el.familyList.querySelectorAll(".family-select")) {
    checkbox.addEventListener("click", (event) => event.stopPropagation());
    checkbox.addEventListener("change", () => {
      const id = checkbox.dataset.id;
      if (checkbox.checked) {
        state.bulkSelectedIds.add(id);
      } else {
        state.bulkSelectedIds.delete(id);
      }
      updateBulkActionsBar();
    });
  }
}

function updateBulkActionsBar() {
  const count = state.bulkSelectedIds.size;
  el.bulkActionsBar.hidden = count === 0;
  el.bulkActionsCount.textContent = `${count} selected`;
}

el.bulkClearButton.addEventListener("click", () => {
  state.bulkSelectedIds.clear();
  updateBulkActionsBar();
  renderFamilyList();
});

el.bulkUntrackButton.addEventListener("click", async () => {
  const ids = [...state.bulkSelectedIds];
  if (ids.length === 0) return;
  const confirmed = window.confirm(
    `Stop tracking ${ids.length} document${ids.length === 1 ? "" : "s"}? This removes their version history from docmanager - it does not touch the real files on disk.`,
  );
  if (!confirmed) return;

  try {
    await api("POST", "/documents/untrack", { ids });
    state.bulkSelectedIds.clear();
    updateBulkActionsBar();
    if (state.selectedId && ids.includes(state.selectedId)) {
      state.selectedId = null;
      el.familyDetail.hidden = true;
      el.familyEmpty.hidden = false;
    }
    refreshDocuments();
  } catch (err) {
    window.alert(`Could not untrack: ${err.message}`);
  }
});

function renderDetailHeader(family) {
  state.detailFamily = family; // cached so rename/tag actions always read the currently-shown family's own fresh data, not a possibly-stale state.families entry
  el.detailTitle.textContent = family.syntheticPath;
  el.detailMeta.textContent = `${family.id} · tracked since ${formatDate(family.createdAt)}`;
  renderTags(family.tags ?? []);
}

const REMOVE_TAG_ICON =
  '<svg viewBox="0 0 16 16" fill="none" width="8" height="8"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>';

function renderTags(tags) {
  const chips = tags
    .map(
      (t) => `<span class="tag-chip">
        ${escapeHtml(t)}
        <button type="button" class="tag-remove" data-tag="${escapeHtml(t)}" aria-label="Remove tag ${escapeHtml(t)}">${REMOVE_TAG_ICON}</button>
      </span>`,
    )
    .join("");
  el.detailTags.innerHTML = `${chips}<button type="button" id="add-tag-button" class="tag-chip tag-add">+ tag</button>`;
  el.detailTags.querySelector("#add-tag-button").addEventListener("click", addTag);
  for (const btn of el.detailTags.querySelectorAll(".tag-remove")) {
    btn.addEventListener("click", () => removeTag(btn.dataset.tag));
  }
}

async function saveTags(tags) {
  if (!state.selectedId) return;
  try {
    const { family } = await api("POST", `/families/${state.selectedId}/tags`, { tags });
    state.detailFamily = family;
    renderTags(family.tags ?? []);
    // Keep the sidebar's own tag badges in step without waiting for the
    // next full refresh/SSE event.
    const listed = state.families.find((f) => f.id === state.selectedId);
    if (listed) listed.tags = family.tags ?? [];
    renderFamilyList();
  } catch (err) {
    window.alert(`Could not update tags: ${err.message}`);
  }
}

function addTag() {
  const existing = state.detailFamily?.tags ?? [];
  const input = window.prompt("Add tag:");
  if (!input) return;
  const tag = input.trim();
  if (!tag || existing.includes(tag)) return;
  saveTags([...existing, tag]);
}

function removeTag(tag) {
  const existing = state.detailFamily?.tags ?? [];
  saveTags(existing.filter((t) => t !== tag));
}

// A compact horizontal strip, not a vertical rail competing with the
// reading pane for width - version control stays visible in one place
// without taking real space away from actually reading the document.
const DELETE_ICON =
  '<svg viewBox="0 0 16 16" fill="none" width="9" height="9"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>';

function renderTimeline(family) {
  const versions = family.versions.slice().reverse();
  // Deleting a family's only remaining version isn't a real operation (the
  // store refuses it too - untrack is the actual "get rid of this document"
  // action), so don't even offer the icon when there's nothing to fall back to.
  const canDelete = versions.length > 1;
  el.timeline.innerHTML = versions
    .map((v) => {
      const isCurrent = v.hash === family.headVersion;
      const isViewing = v.hash === state.viewingHash;
      const classes = ["version-chip", isCurrent && "current", isViewing && "viewing"].filter(Boolean).join(" ");
      const title = `${v.sourceFileName ?? "version"} · ${formatDate(v.createdAt)} · ${v.hash}`;
      const deleteButton = canDelete
        ? `<button type="button" class="version-delete" data-hash="${v.hash}" data-current="${isCurrent}" title="Delete this version" aria-label="Delete this version">${DELETE_ICON}</button>`
        : "";
      return `<li class="${classes}" data-hash="${v.hash}" title="${escapeHtml(title)}" role="button" tabindex="0" aria-current="${isViewing}">
        <span class="dot"></span>${escapeHtml(formatDate(v.createdAt))}${deleteButton}
      </li>`;
    })
    .join("");

  for (const li of el.timeline.querySelectorAll("li")) {
    li.addEventListener("click", () => viewVersion(li.dataset.hash));
    li.addEventListener("keydown", onActivateKeydown(() => viewVersion(li.dataset.hash)));
  }
  for (const btn of el.timeline.querySelectorAll(".version-delete")) {
    btn.addEventListener("click", (event) => {
      event.stopPropagation();
      deleteVersionChip(btn.dataset.hash, btn.dataset.current === "true");
    });
  }
}

async function deleteVersionChip(hash, isCurrent) {
  if (!state.selectedId) return;
  const message = isCurrent
    ? "Delete this version? It's the current version, so docmanager will fall back to whichever version came before it. This only changes docmanager's own history - it does not touch the real file on disk (which will be re-captured as a new version on the next check if it still holds this exact content)."
    : "Delete this version? This permanently removes it from docmanager's history. The real file on disk is never touched, but this cannot be undone through docmanager itself.";
  if (!window.confirm(message)) return;

  try {
    const { family } = await api("DELETE", `/families/${state.selectedId}/versions/${encodeURIComponent(hash)}`);
    const wasViewing = state.viewingHash === hash;
    state.lastKnownHeadVersion = family.headVersion;
    renderDetailHeader(family);
    renderTimeline(family);
    populateCompareSelects(family);
    if (wasViewing) {
      viewVersion(family.headVersion);
    } else {
      el.revertButton.hidden = state.viewingHash === family.headVersion;
    }
  } catch (err) {
    window.alert(`Could not delete this version: ${err.message}`);
  }
}

// A short, readable filename for the downloaded file - the document's own
// synthetic path plus a short hash prefix disambiguates one version from
// another without needing the full 64-character hash in the filename.
function downloadFileName(hash) {
  const base = (state.detailFamily?.syntheticPath ?? "document").replace(/^\/+/, "").replace(/\//g, "-") || "document";
  return `${base}-${hash.slice(0, 8)}.html`;
}

function viewVersion(hash) {
  state.viewingHash = hash;
  el.readingFrame.src = `/content/${hash}`;
  el.openInTab.href = `/content/${hash}`;
  el.downloadVersion.href = `/content/${hash}`;
  el.downloadVersion.download = downloadFileName(hash);
  el.versionBanner.hidden = true;
  // Only offer to revert TO a version you're not already on - reverting to
  // the current head would be a no-op the core already handles idempotently,
  // but there's no reason to invite the click at all.
  el.revertButton.hidden = hash === state.lastKnownHeadVersion;
  for (const li of el.timeline.querySelectorAll("li")) {
    li.classList.toggle("viewing", li.dataset.hash === hash);
  }
}

// Newest-first, matching the timeline's own order. Defaults to comparing
// the two most recent versions, the single most common real use of a diff.
function populateCompareSelects(family) {
  const versions = family.versions.slice().reverse();
  const options = versions
    .map((v) => `<option value="${v.hash}">${escapeHtml(formatDate(v.createdAt))}${v.current ? " (current)" : ""}</option>`)
    .join("");
  el.compareFrom.innerHTML = options;
  el.compareTo.innerHTML = options;
  if (versions.length >= 2) {
    el.compareFrom.value = versions[1].hash;
    el.compareTo.value = versions[0].hash;
  }
  el.compareOutput.hidden = true;
  el.compareOutput.textContent = "";
  el.compareRendered.hidden = true;
}

let compareMode = "text";

function setCompareMode(mode) {
  compareMode = mode;
  el.compareModeText.classList.toggle("active", mode === "text");
  el.compareModeText.setAttribute("aria-pressed", String(mode === "text"));
  el.compareModeRendered.classList.toggle("active", mode === "rendered");
  el.compareModeRendered.setAttribute("aria-pressed", String(mode === "rendered"));
}

function renderDiff(parts) {
  const hasChanges = parts.some((part) => part.added || part.removed);
  if (!hasChanges) {
    el.compareOutput.textContent = "No differences (both versions normalize to the same content).";
    return;
  }
  el.compareOutput.innerHTML = parts
    .map((part) => {
      const cls = part.added ? "diff-added" : part.removed ? "diff-removed" : "diff-context";
      const prefix = part.added ? "+ " : part.removed ? "- " : "  ";
      return part.value
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => `<span class="${cls}">${prefix}${escapeHtml(line)}</span>`)
        .join("\n");
    })
    .join("\n");
}

async function selectFamily(id) {
  const token = ++selectionToken;
  state.selectedId = id;
  state.viewingHash = null;
  state.lastKnownHeadVersion = null;
  state.detailFamily = null;
  closeCompareModal(); // a stale compare view referencing the old selection shouldn't linger
  renderFamilyList();

  el.familyEmpty.hidden = true;
  el.familyDetail.hidden = false;

  try {
    const { family } = await api("GET", `/families/${id}`);
    if (token !== selectionToken) return; // a newer selection has already superseded this one
    state.lastKnownHeadVersion = family.headVersion;
    renderDetailHeader(family);
    renderTimeline(family);
    populateCompareSelects(family);
    viewVersion(family.headVersion);
  } catch (err) {
    if (token !== selectionToken) return;
    el.detailTitle.textContent = "Could not load this document";
    el.detailMeta.textContent = err.message;
    el.timeline.innerHTML = "";
  }
}

// Re-syncs the currently selected document's metadata without touching
// whatever is actually loaded in the reading frame. If a new version
// arrived since we last checked, this shows a banner instead of silently
// swapping the content out from under someone mid-read - see
// ARCHITECTURE.md section 5. Guarded against selectionToken changing
// mid-flight, so a refresh that was already in progress when the user
// picked a different (or the same) document again can never act on stale
// state once a fresher selection has taken over.
async function refreshSelectedFamily() {
  if (!state.selectedId) return;
  const tokenAtStart = selectionToken;
  try {
    const { family } = await api("GET", `/families/${state.selectedId}`);
    if (tokenAtStart !== selectionToken) return;
    renderDetailHeader(family);
    renderTimeline(family);
    populateCompareSelects(family);
    if (family.headVersion !== state.lastKnownHeadVersion) {
      state.lastKnownHeadVersion = family.headVersion;
      el.revertButton.hidden = state.viewingHash === family.headVersion;
      if (state.viewingHash !== family.headVersion) {
        el.versionBanner.hidden = false;
      }
    }
  } catch {
    // The family may have been removed (e.g. merged via link) - a full
    // refreshDocuments() call elsewhere handles that; nothing to do here.
  }
}

el.versionBannerAction.addEventListener("click", () => {
  if (state.selectedId) {
    api("GET", `/families/${state.selectedId}`).then(({ family }) => viewVersion(family.headVersion));
  }
});

async function refreshDocuments() {
  try {
    const { families, suggestedLinks } = await api("GET", "/families");
    state.families = families;
    state.suggestedLinks = suggestedLinks ?? [];
    const stillTracked = new Set(families.map((f) => f.id));
    for (const id of state.bulkSelectedIds) {
      if (!stillTracked.has(id)) state.bulkSelectedIds.delete(id);
    }
    updateBulkActionsBar();
    renderFamilyList();
    if (state.selectedId && families.some((f) => f.id === state.selectedId)) {
      await refreshSelectedFamily();
    } else if (state.selectedId) {
      // Selected family no longer exists (e.g. merged away by a link).
      state.selectedId = null;
      el.familyDetail.hidden = true;
      el.familyEmpty.hidden = false;
    }
  } catch (err) {
    el.familyList.innerHTML = `<p class="empty">Could not load documents: ${escapeHtml(err.message)}</p>`;
  }
}

// An HTTPS-style remote is the only case the access token field applies to
// - an SSH-style remote authenticates via SSH key regardless (see the "Check
// SSH setup" action below), so disabling the field for any other value is
// what keeps the UI honest about which mechanism actually applies, per
// ARCHITECTURE.md's explicit requirement not to present one generic "auth"
// concept.
function updateTokenFieldAvailability() {
  const isHttps = /^https?:\/\//i.test(el.snapshotRemote.value.trim());
  el.snapshotRemoteToken.disabled = !isHttps;
  el.snapshotRemoteToken.placeholder = isHttps ? "Not set" : "Only applies to an HTTPS remote";
}

async function loadSettings() {
  const settings = await api("GET", "/settings");
  el.snapshotRemote.value = settings.snapshotRemote ?? "";
  // The real token is never sent back by the API (see server.js's
  // redactSettings()) - the field always starts empty, and "Saved." vs
  // "Not set" is communicated through the placeholder/clear-button
  // visibility instead of ever trying to display the actual value.
  el.snapshotRemoteToken.value = "";
  el.clearTokenButton.hidden = !settings.snapshotRemoteTokenSet;
  el.tokenStatus.textContent = settings.snapshotRemoteTokenSet ? "A token is currently saved." : "";
  updateTokenFieldAvailability();
}

// Persisted client-side only (this browser, this machine) - it's a display
// preference, not app state, so it never goes through the core's /settings
// API the way snapshotRemote etc. do. The actual attribute is already set
// before first paint by a small inline script in index.html's <head> (to
// avoid a flash of the wrong theme); this just keeps the toggle buttons and
// any later change in sync with that same storage key.
const THEME_STORAGE_KEY = "docmanager-theme";

function getStoredTheme() {
  try {
    const value = localStorage.getItem(THEME_STORAGE_KEY);
    return value === "light" || value === "dark" ? value : "system";
  } catch {
    return "system"; // localStorage can throw in some private-browsing modes
  }
}

function updateThemeButtons(theme) {
  for (const [button, value] of [
    [el.themeSystem, "system"],
    [el.themeLight, "light"],
    [el.themeDark, "dark"],
  ]) {
    button.classList.toggle("active", theme === value);
    button.setAttribute("aria-pressed", String(theme === value));
  }
}

function applyTheme(theme) {
  if (theme === "light" || theme === "dark") {
    document.documentElement.dataset.theme = theme;
  } else {
    delete document.documentElement.dataset.theme;
  }
  try {
    if (theme === "system") {
      localStorage.removeItem(THEME_STORAGE_KEY);
    } else {
      localStorage.setItem(THEME_STORAGE_KEY, theme);
    }
  } catch {
    // Applies for this page load regardless; it just won't persist.
  }
  updateThemeButtons(theme);
}

el.themeSystem.addEventListener("click", () => applyTheme("system"));
el.themeLight.addEventListener("click", () => applyTheme("light"));
el.themeDark.addEventListener("click", () => applyTheme("dark"));

// The attribute itself is already set (or not) by the anti-flash inline
// script in <head> - only the button UI needs to catch up on load.
updateThemeButtons(getStoredTheme());

function switchView(view) {
  state.view = view;
  el.viewDocuments.hidden = view !== "documents";
  el.viewSettings.hidden = view !== "settings";
  el.navDocuments.classList.toggle("nav-active", view === "documents");
  el.navSettings.classList.toggle("nav-active", view === "settings");
  if (view === "settings") loadSettings();
}

el.navDocuments.addEventListener("click", () => switchView("documents"));
el.navSettings.addEventListener("click", () => switchView("settings"));

el.snapshotRemote.addEventListener("input", updateTokenFieldAvailability);

el.settingsForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  el.settingsStatus.textContent = "Saving…";
  try {
    const patch = { snapshotRemote: el.snapshotRemote.value.trim() || null };
    // The token field always starts empty (the real value is never sent
    // back), so an empty field here means "no change," not "clear it" -
    // only include it in the patch when the user actually typed something
    // this session. Clearing is its own explicit action below.
    if (el.snapshotRemoteToken.value !== "") {
      patch.snapshotRemoteToken = el.snapshotRemoteToken.value;
    }
    await api("PUT", "/settings", patch);
    el.settingsStatus.textContent = "Saved.";
    await loadSettings();
  } catch (err) {
    el.settingsStatus.textContent = `Error: ${err.message}`;
  }
});

el.clearTokenButton.addEventListener("click", async () => {
  if (!window.confirm("Remove the saved access token? You'll need to enter it again to push or pull an HTTPS remote that needs it.")) return;
  try {
    await api("PUT", "/settings", { snapshotRemoteToken: null });
    await loadSettings();
  } catch (err) {
    el.tokenStatus.textContent = `Error: ${err.message}`;
  }
});

el.checkSshButton.addEventListener("click", async () => {
  el.sshCheckOutput.hidden = false;
  el.sshCheckOutput.textContent = "Checking…";
  try {
    const result = await api("GET", "/ssh-check");
    el.sshCheckOutput.textContent = formatSshCheck(result);
  } catch (err) {
    el.sshCheckOutput.textContent = `Error: ${err.message}`;
  }
});

function formatSshCheck(result) {
  if (!result.remoteConfigured) return "No snapshot remote configured yet.";
  if (!result.isSshRemote) return "The configured remote is not an SSH-style URL - this check doesn't apply.";

  const lines = [`Host: ${result.host}`];
  if (result.keys.length === 0) {
    lines.push(
      "No SSH key found on this machine.",
      "Generating one is a real change to this machine - ask your agent to do it only after you've explicitly approved, docmanager never does this on its own.",
    );
    return lines.join("\n");
  }

  lines.push(`Key(s) found: ${result.keys.map((k) => k.path).join(", ")}`);
  if (result.connection.status === "ok") {
    lines.push(`Connected successfully to ${result.host}.`);
  } else if (result.connection.status === "failed") {
    lines.push(
      `Could not authenticate to ${result.host} with the key(s) above.`,
      "Add one of their public keys to the host's SSH settings if you haven't already.",
    );
  } else {
    lines.push("Connection attempt completed, but the result could not be classified:", result.connection.output);
  }
  return lines.join("\n");
}

el.stopCoreButton.addEventListener("click", async () => {
  const confirmed = window.confirm(
    "Stop docmanager? This page will stop working until you or an agent runs a docmanager command again.",
  );
  if (!confirmed) return;

  el.stopCoreStatus.textContent = "Stopping…";
  try {
    await api("POST", "/core/stop");
    el.stopCoreStatus.textContent = "Stopped. This page will no longer update.";
  } catch {
    // The connection dropping as the server shuts down IS success here -
    // there is no response to read once the process has actually exited.
    el.stopCoreStatus.textContent = "Stopped. This page will no longer update.";
  }
});

el.renameButton.addEventListener("click", async () => {
  if (!state.selectedId || !state.detailFamily) return;
  const current = state.detailFamily.syntheticPath;
  const input = window.prompt("Rename this document's synthetic path:", current);
  if (input === null) return;
  const newPath = input.trim();
  if (!newPath || newPath === current) return;

  try {
    const { family } = await api("POST", `/families/${state.selectedId}/rename`, { syntheticPath: newPath });
    renderDetailHeader(family);
    refreshDocuments();
  } catch (err) {
    window.alert(`Could not rename: ${err.message}`);
  }
});

// A ready-to-paste message for whichever agent the user is talking to - not
// something this UI can act on itself (the UI has no agent connection of
// its own, see ARCHITECTURE.md section 5). Deliberately minimal: the full
// workflow (why this order, why the exact printed command and not npx, the
// relink+status step to save the result) already lives in docmanager's own
// Agent Skill, loaded once and reused - repeating all of that in every
// generated prompt would just be the same explanation paid for in tokens
// on every single use. This only needs to supply what the skill can't
// already know on its own: which specific version of which document.
function buildLavishPrompt(family, hash) {
  return `Edit version ${hash.slice(0, 8)} of "${family.syntheticPath}" (docmanager family ${family.id}) in Lavish Editor - run \`docmanager families lavish ${family.id} ${hash}\`, then follow docmanager's own skill for the rest of the workflow.`;
}

el.lavishPromptButton.addEventListener("click", async () => {
  if (!state.detailFamily || !state.viewingHash) return;
  const text = buildLavishPrompt(state.detailFamily, state.viewingHash);
  try {
    await navigator.clipboard.writeText(text);
    el.lavishPromptStatus.textContent = "Copied - paste it to your agent.";
  } catch {
    // Clipboard access can fail (permissions, an unusual browser context) -
    // fall back to something the user can still copy by hand rather than
    // just failing silently.
    window.prompt("Copy this and paste it to your agent:", text);
    return;
  }
  setTimeout(() => {
    el.lavishPromptStatus.textContent = "";
  }, 4000);
});

el.untrackButton.addEventListener("click", async () => {
  if (!state.selectedId) return;
  const syntheticPath = el.detailTitle.textContent;
  const confirmed = window.confirm(
    `Stop tracking "${syntheticPath}"? This removes its version history from docmanager - it does not touch the real file on disk.`,
  );
  if (!confirmed) return;

  try {
    await api("POST", "/documents/untrack", { ids: [state.selectedId] });
    state.selectedId = null;
    el.familyDetail.hidden = true;
    el.familyEmpty.hidden = false;
    refreshDocuments();
  } catch (err) {
    window.alert(`Could not untrack: ${err.message}`);
  }
});

async function runSearch(query) {
  if (!query) {
    state.searchResults = null;
    el.searchClear.hidden = true;
    renderFamilyList();
    return;
  }
  try {
    const { results } = await api("GET", `/search?q=${encodeURIComponent(query)}`);
    state.searchResults = results;
    el.searchClear.hidden = false;
    renderFamilyList();
  } catch (err) {
    el.familyList.innerHTML = `<p class="empty">Search failed: ${escapeHtml(err.message)}</p>`;
  }
}

el.searchInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    runSearch(el.searchInput.value.trim());
  }
});

// Clearing the box by hand (not just the explicit Clear button) should also
// drop back to the normal tracked-document list, not leave stale results.
el.searchInput.addEventListener("input", () => {
  if (el.searchInput.value.trim() === "") runSearch("");
});

el.searchClear.addEventListener("click", () => {
  el.searchInput.value = "";
  runSearch("");
});

el.revertButton.addEventListener("click", async () => {
  if (!state.selectedId || !state.viewingHash) return;
  const confirmed = window.confirm(
    "Make this the current version? This only changes docmanager's own history - it does not touch the real file on disk. If the real file on disk still holds newer content, the next status check will report it as behind until you edit it yourself.",
  );
  if (!confirmed) return;

  try {
    await api("POST", `/families/${state.selectedId}/revert`, { hash: state.viewingHash });
    await refreshSelectedFamily();
    // The version just reverted TO is now genuinely current - re-viewing it
    // directly (not through the "newer version" banner) is correct here,
    // and this also updates the revert button's own visibility.
    viewVersion(state.viewingHash);
  } catch (err) {
    window.alert(`Could not revert: ${err.message}`);
  }
});

function openCompareModal() {
  if (!state.selectedId) return;
  el.compareModal.hidden = false;
  document.addEventListener("keydown", onCompareModalKeydown);
}

function closeCompareModal() {
  el.compareModal.hidden = true;
  document.removeEventListener("keydown", onCompareModalKeydown);
  // Stop each iframe's own content (and its scroll-sync listener) rather
  // than leaving it running invisibly in the background until the next compare.
  el.compareFrameFrom.src = "about:blank";
  el.compareFrameTo.src = "about:blank";
}

function onCompareModalKeydown(event) {
  if (event.key === "Escape") closeCompareModal();
}

el.openCompareButton.addEventListener("click", openCompareModal);
el.compareModalClose.addEventListener("click", closeCompareModal);
el.compareModal.addEventListener("click", (event) => {
  if (event.target === el.compareModal) closeCompareModal();
});

// The rendered diff's two iframes are sandboxed (allow-scripts, no
// allow-same-origin - ARCHITECTURE.md section 5), so this page cannot reach
// into either one directly to read or set its scroll position; each served
// document runs its own small injected script that reports its scroll
// ratio via postMessage on scroll and accepts a ratio to scroll to. This
// just relays between the two, identifying the sender via event.source
// (valid for comparison and posting back to, even across the sandbox's
// opaque origin) rather than trusting the message's own claimed origin.
window.addEventListener("message", (event) => {
  const data = event.data;
  if (!data || data.source !== "docmanager-diff-scroll") return;
  const target = event.source === el.compareFrameFrom.contentWindow ? el.compareFrameTo : el.compareFrameFrom;
  target.contentWindow?.postMessage({ source: "docmanager-diff-scroll-to", ratio: data.ratio }, "*");
});

el.compareModeText.addEventListener("click", () => setCompareMode("text"));
el.compareModeRendered.addEventListener("click", () => setCompareMode("rendered"));

el.compareButton.addEventListener("click", async () => {
  if (!state.selectedId) return;
  const hashA = el.compareFrom.value;
  const hashB = el.compareTo.value;
  if (!hashA || !hashB) return;

  if (compareMode === "rendered") {
    el.compareOutput.hidden = true;
    el.compareRendered.hidden = false;
    // Each iframe loads its own version, annotated against the other - the
    // highlighting has to live inside the served HTML itself, since the
    // sandbox (deliberately allow-scripts without allow-same-origin, see
    // ARCHITECTURE.md section 5) means this page can't reach into either
    // iframe's content to style it from the outside.
    el.compareFrameFrom.src = `/content/${encodeURIComponent(hashA)}/diff-against/${encodeURIComponent(hashB)}?mode=removed`;
    el.compareFrameTo.src = `/content/${encodeURIComponent(hashB)}/diff-against/${encodeURIComponent(hashA)}?mode=added`;
    return;
  }

  el.compareRendered.hidden = true;
  el.compareOutput.hidden = false;
  el.compareOutput.textContent = "Loading…";
  try {
    const { parts } = await api(
      "GET",
      `/families/${state.selectedId}/diff?a=${encodeURIComponent(hashA)}&b=${encodeURIComponent(hashB)}`,
    );
    renderDiff(parts);
  } catch (err) {
    el.compareOutput.textContent = `Error: ${err.message}`;
  }
});

// Mirrors trackPath()'s own defaultSyntheticPath() (src/core/track.js) just
// closely enough for a client-side preview - basename, extension stripped,
// leading slash. Only meaningful for a single-file line; a folder path
// can't be previewed without walking the real filesystem, which the
// browser has no access to, so a folder line always shows as "new" here
// even though tracking it for real may expand into several files.
function clientDefaultSyntheticPath(rawPath) {
  const normalized = rawPath.replace(/\\/g, "/").replace(/\/+$/, "");
  const base = normalized.split("/").pop() ?? "";
  const dot = base.lastIndexOf(".");
  const name = dot > 0 ? base.slice(0, dot) : base;
  return `/${name}`;
}

// Turns a blind batch submission into an inspectable one: for each pasted
// line, shows whether it will create a new document or reconnect to one
// that already exists, before the Track button is ever pressed. The
// checkbox only ever does something when at least one line actually
// matches - disabled with a plain reason otherwise, rather than sitting
// there identically whether it's useful or not.
function updateTrackPreview() {
  const lines = el.trackPaths.value
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (lines.length === 0) {
    el.trackPreview.innerHTML = "";
    el.trackRelink.disabled = false;
    el.trackRelinkReason.hidden = true;
    return;
  }

  let anyMatch = false;
  el.trackPreview.innerHTML = lines
    .map((line) => {
      const synthetic = clientDefaultSyntheticPath(line);
      const match = state.families.find((f) => f.syntheticPath === synthetic);
      if (match) {
        anyMatch = true;
        const count = match.versionCount ?? Object.keys(match.versions ?? {}).length;
        return `<div class="track-preview-row match">${escapeHtml(line)} → Reconnects to: "${escapeHtml(match.syntheticPath)}" (${count} version${count === 1 ? "" : "s"})</div>`;
      }
      return `<div class="track-preview-row">${escapeHtml(line)} → New document</div>`;
    })
    .join("");

  el.trackRelink.disabled = !anyMatch;
  el.trackRelinkReason.hidden = anyMatch;
  if (!anyMatch) el.trackRelink.checked = false;
}

function debounce(fn, ms) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

const debouncedUpdateTrackPreview = debounce(updateTrackPreview, 200);
el.trackPaths.addEventListener("input", debouncedUpdateTrackPreview);
el.trackPaths.addEventListener("blur", updateTrackPreview);

// A colliding path gets its own small resolution card - showing the REAL
// existing document it matched (title, version count, when it was last
// touched) - rather than a blind checkbox the user has to trust upfront.
// The batch checkbox above still exists for the "I already know I'm
// reconnecting a whole snapshot-pulled folder, link everything" case; this
// is for the everyday, one-collision-at-a-time case where the user didn't
// (and shouldn't have needed to) predict the collision beforehand.
function renderTrackCollisions(collisions) {
  el.trackCollisions.innerHTML = collisions
    .map((c, i) => {
      const ef = c.existingFamily;
      return `<div class="track-collision" data-index="${i}">
        <p><strong>${escapeHtml(c.path)}</strong> already matches an existing document:</p>
        <p class="track-collision-match">${escapeHtml(ef.syntheticPath)} · ${ef.versionCount} version${ef.versionCount === 1 ? "" : "s"} · last touched ${escapeHtml(formatDate(ef.headCreatedAt))}</p>
        <div class="track-collision-actions">
          <button type="button" class="secondary-button" data-action="link">Link this file to that history</button>
          <button type="button" class="link-button" data-action="rename">Use a different name instead</button>
        </div>
        <span class="status-message" data-role="status" role="status"></span>
      </div>`;
    })
    .join("");

  el.trackCollisions.querySelectorAll(".track-collision").forEach((card, i) => {
    const collision = collisions[i];
    const statusEl = card.querySelector('[data-role="status"]');

    card.querySelector('[data-action="link"]').addEventListener("click", async () => {
      statusEl.textContent = "Linking…";
      try {
        await api("POST", "/documents/track", {
          paths: [collision.path],
          as: collision.existingFamily.syntheticPath,
          relink: true,
        });
        card.remove();
        refreshDocuments();
      } catch (err) {
        statusEl.textContent = `Error: ${err.message}`;
      }
    });

    card.querySelector('[data-action="rename"]').addEventListener("click", async () => {
      const newPath = window.prompt("Track this file under a different synthetic path:");
      if (!newPath || !newPath.trim()) return;
      statusEl.textContent = "Tracking…";
      try {
        await api("POST", "/documents/track", { paths: [collision.path], as: newPath.trim() });
        card.remove();
        refreshDocuments();
      } catch (err) {
        statusEl.textContent = `Error: ${err.message}`;
      }
    });
  });
}

el.trackForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const paths = el.trackPaths.value
    .split("\n")
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

  if (paths.length === 0) {
    el.trackStatus.textContent = "Enter at least one path.";
    return;
  }

  el.trackStatus.textContent = "Tracking…";
  el.trackCollisions.innerHTML = "";
  try {
    const { results, summary } = await api("POST", "/documents/track", {
      paths,
      relink: el.trackRelink.checked,
    });
    el.trackStatus.textContent = `${summary.trackedCount} tracked, ${summary.alreadyTrackedCount} already tracked, ${summary.relinkedCount} relinked, ${summary.errorCount} failed.`;

    const collisions = results.filter((r) => r.code === "FAMILY_PATH_EXISTS" && r.existingFamily);
    if (collisions.length > 0) {
      renderTrackCollisions(collisions);
    }
    if (summary.errorCount === 0) {
      el.trackPaths.value = "";
      updateTrackPreview();
    }
    refreshDocuments();
  } catch (err) {
    el.trackStatus.textContent = `Error: ${err.message}`;
  }
});

// Refetch on load and whenever the tab regains focus - there is no live
// filesystem watcher in v1, so this is what catches an external edit made
// while the tab was in the background. See ARCHITECTURE.md section 5.
window.addEventListener("focus", () => {
  if (state.view === "documents") refreshDocuments();
});

// EventSource retries a dropped connection on its own; onerror fires on
// every drop, including a normal blip that recovers moments later, not
// just a genuine permanent failure. Showing the banner immediately on the
// first error would make routine, harmless reconnects look alarming.
// Waiting for a short grace period, and cancelling it the moment the
// connection actually comes back, means the banner only ever appears for
// a real, sustained outage.
const RECONNECT_GRACE_MS = 4000;

function connectEvents() {
  let graceTimer = null;
  const source = new EventSource("/events");

  source.addEventListener("families-changed", () => {
    if (state.view === "documents") refreshDocuments();
  });

  source.onerror = () => {
    if (graceTimer) return;
    graceTimer = setTimeout(() => {
      el.banner.hidden = false;
      graceTimer = null;
    }, RECONNECT_GRACE_MS);
  };

  source.onopen = () => {
    if (graceTimer) {
      clearTimeout(graceTimer);
      graceTimer = null;
    }
    el.banner.hidden = true;
  };
}

setCompareMode("text");
refreshDocuments();
connectEvents();
