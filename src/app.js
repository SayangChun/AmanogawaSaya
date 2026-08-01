import { CHARACTER, getAffinityRank } from "./character/profile.js";
import { speak, timeBucket } from "./character/dialogue.js";
import { createMotionController } from "./character/motion.js";
import { createWanderController } from "./character/wander.js";
import {
  createZoneTracker,
  isZonePosesEnabled,
} from "./character/screen-zone.js";
import { loadState, saveState, gainAffinity, setUserName } from "./state.js";

const app = document.querySelector("#app");

const DRAG_THRESHOLD_PX = 4;
const CLICK_SUPPRESS_MS = 500;
/**
 * After interacting with Saya, keep the window hit-test solid for a short
 * window so rapid multi-clicks never fall through to the desktop mid-burst.
 */
const STICKY_HIT_MS = 320;

/** @type {ReturnType<typeof loadState>} */
let state = loadState();
let currentLine = state.lastLine || "";
let currentScene = state.lastScene || "boot";

let autoWanderEnabled = true;
/** Side shortcut dock open (right-click). */
let dockOpen = false;
/** Secondary dock submenu: affinity / stats (under 星轨). */
let dockStatsOpen = false;
/**
 * Where the dock sits relative to Saya: left or right of the body.
 * @type {"left" | "right"}
 */
let dockPlacement = "right";
/** Last applied OS mouse-ignore state (true = click-through empty pixels). */
let mouseIgnoreActive = null;
/**
 * Last known pointer position in window client coords.
 * @type {number | null}
 */
let lastPointerClientX = null;
/** @type {number | null} */
let lastPointerClientY = null;
/** Keep mouse capture solid until this timestamp (rapid pet clicks). */
let stickyHitUntil = 0;
/** @type {ReturnType<typeof setTimeout> | null} */
let stickyHitTimer = null;
/** Last logical window footprint: compact | speak | dock | dockStats. */
let windowChromeMode = "compact";
/** Placement last sent with windowChromeMode (skip redundant setMode). */
let lastChromePlacement = "";
/** Coalesce hit-tests to one per animation frame. */
let mouseIgnoreRaf = 0;

let bubbleOpen = false;
/** @type {ReturnType<typeof setTimeout> | null} */
let bubbleHideTimer = null;
/**
 * Active pointer session on the pet.
 * @type {null | {
 *   pointerId: number,
 *   lastX: number,
 *   lastY: number,
 *   startX: number,
 *   startY: number,
 *   moved: boolean,
 * }}
 */
let drag = null;
/** True only after movement exceeds threshold (real window drag). */
let isDragging = false;
/** True from pointerdown until fully released — blocks mode enlarge. */
let pointerArmed = false;
let suppressClickUntil = 0;
/** @type {null | (() => void)} */
let pendingAfterDrag = null;

/** Cached DOM nodes (refreshed on paint). */
const dom = {
  shell: /** @type {HTMLElement|null} */ (null),
  bubble: /** @type {HTMLElement|null} */ (null),
  lineText: /** @type {HTMLElement|null} */ (null),
  bubbleRank: /** @type {HTMLElement|null} */ (null),
  petHit: /** @type {HTMLElement|null} */ (null),
  petActor: /** @type {HTMLElement|null} */ (null),
  stage: /** @type {HTMLElement|null} */ (null),
  dock: /** @type {HTMLElement|null} */ (null),
  dockStats: /** @type {HTMLElement|null} */ (null),
  dockStatsToggle: /** @type {HTMLElement|null} */ (null),
  dockWanderToggle: /** @type {HTMLElement|null} */ (null),
  affinityValue: /** @type {HTMLElement|null} */ (null),
  affinityTitle: /** @type {HTMLElement|null} */ (null),
  affinityBar: /** @type {HTMLElement|null} */ (null),
  starsRow: /** @type {HTMLElement|null} */ (null),
  statInteractions: /** @type {HTMLElement|null} */ (null),
  statPeriod: /** @type {HTMLElement|null} */ (null),
  nameInput: /** @type {HTMLInputElement|null} */ (null),
  nameStatus: /** @type {HTMLElement|null} */ (null),
  nameSave: /** @type {HTMLElement|null} */ (null),
};

function cacheDom() {
  dom.shell = document.querySelector(".shell");
  dom.bubble = document.querySelector("#bubble");
  dom.lineText = document.querySelector("#line-text");
  dom.bubbleRank = document.querySelector(".bubble-rank");
  dom.petHit = document.querySelector("#pet-hit");
  dom.petActor = document.querySelector("#pet-actor");
  dom.stage = document.querySelector("#stage");
  dom.dock = document.querySelector("#pet-dock");
  dom.dockStats = document.querySelector("#dock-stats");
  dom.dockStatsToggle = document.querySelector("#dock-stats-toggle");
  dom.dockWanderToggle = document.querySelector("#dock-wander-toggle");
  dom.affinityValue = document.querySelector(".affinity-value");
  dom.affinityTitle = document.querySelector(".affinity-card .title");
  dom.affinityBar = document.querySelector(".affinity-bar > i");
  dom.starsRow = document.querySelector(".stars-row");
  dom.statInteractions = document.querySelector("#stat-interactions");
  dom.statPeriod = document.querySelector("#stat-period");
  dom.nameInput = document.querySelector("#user-name-input");
  dom.nameStatus = document.querySelector("#name-status");
  dom.nameSave = document.querySelector("#name-save");
}

const zoneTracker = createZoneTracker({
  getBounds: () => window.petApi?.bounds?.() ?? Promise.resolve(null),
  getWorkArea: () => window.petApi?.workArea?.() ?? Promise.resolve(null),
  enabled: () => isZonePosesEnabled(),
});

const motion = createMotionController({
  getZoneSnapshot: (opts) => zoneTracker.getSnapshot(opts),
  getLastZoneId: () => zoneTracker.getZoneId(),
  onZoneSit: (_zoneId) => {
    if (bubbleOpen || Math.random() >= 0.15) return;
    const line = speakState("zoneSit");
    currentLine = line.text;
    openBubble(3500);
    updateBubbleDom();
  },
});

const wander = createWanderController({
  motion,
  moveBy: (delta) => window.petApi?.moveBy?.(delta),
  getBounds: () => window.petApi?.bounds?.() ?? Promise.resolve(null),
  getWorkArea: () => window.petApi?.workArea?.() ?? Promise.resolve(null),
  getRoamBias: (opts) => zoneTracker.getRoamBias(opts),
  isBlocked: () => isDragging || pointerArmed,
  onRoamStart: (_kind) => {
    if (Math.random() < 0.15 && !bubbleOpen) {
      const line = speakState(timeBucket());
      currentLine = line.text;
      openBubble(4500);
    }
  },
});

/**
 * After a real window drag: unpause without resuming pre-drag clip,
 * then play a single settle or idle (no double force-play).
 * @param {{ deferUi?: boolean }} [opts]
 */
async function finishDragWithZone(opts = {}) {
  motion.setPaused?.(false, { skipResume: true });
  wander.resume();

  if (opts.deferUi || dockOpen) {
    motion.play("idle", { force: true, fromIdle: true });
    return;
  }

  if (!isZonePosesEnabled()) {
    motion.play("idle", { force: true, fromIdle: true });
    return;
  }

  let snap = null;
  try {
    snap = await zoneTracker.refresh({ force: true });
  } catch {
    snap = null;
  }

  if (isDragging || pointerArmed || motion.isPaused?.()) return;

  if (snap?.zoneId && dom.petActor) {
    dom.petActor.dataset.zone = snap.zoneId;
  }

  if (snap && Math.random() < 0.45) {
    const z = snap.zoneId || "";
    if ((z.startsWith("corner-b") || z === "edge-bottom") && Math.random() < 0.35) {
      motion.playBehavior("settleCorner", { force: true, holdMs: 3500 });
      if (Math.random() < 0.15 && !bubbleOpen) {
        const line = speakState("zoneSit");
        currentLine = line.text;
        openBubble(3500);
        updateBubbleDom();
      }
      return;
    }
    if (z.startsWith("edge") || z.startsWith("corner")) {
      if (snap.facingHint) motion.setFacing(snap.facingHint);
      motion.playBehavior("settleEdge", { force: true });
      return;
    }
  }

  if (Math.random() < 0.4) {
    motion.playBehavior("settle", { force: true });
  } else {
    motion.play("idle", { force: true, fromIdle: true });
  }
}

function setDraggingLock(on) {
  window.petApi?.setDragging?.(Boolean(on));
  if (on) applyMouseIgnore(false);
  else refreshMouseIgnore();
}

/**
 * @param {number} [x]
 * @param {number} [y]
 */
function notePointerClient(x, y) {
  if (typeof x === "number" && Number.isFinite(x)) lastPointerClientX = x;
  if (typeof y === "number" && Number.isFinite(y)) lastPointerClientY = y;
}

/**
 * @param {number} [ms]
 */
function armStickyHit(ms = STICKY_HIT_MS) {
  stickyHitUntil = Math.max(stickyHitUntil, Date.now() + ms);
  if (stickyHitTimer) clearTimeout(stickyHitTimer);
  const remain = Math.max(0, stickyHitUntil - Date.now());
  stickyHitTimer = setTimeout(() => {
    stickyHitTimer = null;
    if (isDragging || pointerArmed || dockOpen) return;
    if (Date.now() < stickyHitUntil) return;
    refreshMouseIgnore(lastPointerClientX, lastPointerClientY);
  }, remain + 1);
}

/**
 * @param {boolean} ignore
 */
function applyMouseIgnore(ignore) {
  const next = Boolean(ignore);
  if (mouseIgnoreActive === next) return;
  mouseIgnoreActive = next;
  window.petApi?.setIgnoreMouseEvents?.(next, { forward: true });
}

/**
 * @param {Element | null} el
 */
function isInteractiveTarget(el) {
  if (!el || !(el instanceof Element)) return false;
  if (el.closest("#pet-hit")) return true;
  if (el.closest("#pet-dock") && !el.closest("#pet-dock.closed")) return true;
  if (bubbleOpen && el.closest("#bubble") && !el.closest("#bubble.closed")) return true;
  return false;
}

/**
 * @param {number} [clientX]
 * @param {number} [clientY]
 */
function refreshMouseIgnore(clientX, clientY) {
  if (clientX != null && clientY != null) {
    notePointerClient(clientX, clientY);
  } else {
    clientX = lastPointerClientX;
    clientY = lastPointerClientY;
  }

  if (isDragging || pointerArmed || dockOpen || Date.now() < stickyHitUntil) {
    applyMouseIgnore(false);
    return;
  }
  if (clientX == null || clientY == null) {
    applyMouseIgnore(true);
    return;
  }
  const el = document.elementFromPoint(clientX, clientY);
  applyMouseIgnore(!isInteractiveTarget(el));
}

/** Schedule hit-test at most once per frame (pointermove hot path). */
function scheduleRefreshMouseIgnore(clientX, clientY) {
  notePointerClient(clientX, clientY);
  if (mouseIgnoreRaf) return;
  mouseIgnoreRaf = requestAnimationFrame(() => {
    mouseIgnoreRaf = 0;
    if (isDragging || pointerArmed) return;
    refreshMouseIgnore(lastPointerClientX, lastPointerClientY);
  });
}

/**
 * Prefer the side with enough room for the vertical dock (and stats if open).
 * @returns {Promise<"left" | "right">}
 */
async function chooseDockPlacement() {
  try {
    const [bounds, work] = await Promise.all([
      window.petApi?.bounds?.() ?? Promise.resolve(null),
      window.petApi?.workArea?.() ?? Promise.resolve(null),
    ]);
    if (!bounds || !work) return "right";

    const need = dockStatsOpen ? 230 : 80;
    const spaceRight = work.x + work.width - (bounds.x + bounds.width);
    const spaceLeft = bounds.x - work.x;

    if (spaceRight >= need) return "right";
    if (spaceLeft >= need) return "left";
    return spaceLeft > spaceRight ? "left" : "right";
  } catch {
    return "right";
  }
}

function applyDockPlacementClass() {
  const shell = dom.shell || document.querySelector(".shell");
  if (!shell) return;
  shell.classList.toggle("dock-placement-left", dockOpen && dockPlacement === "left");
  shell.classList.toggle("dock-placement-right", dockOpen && dockPlacement === "right");
  shell.classList.remove("dock-placement-above", "dock-placement-below");
}

/**
 * @returns {Promise<number | null>}
 */
async function measurePetFeetScreenY() {
  const pet = dom.petHit || document.querySelector("#pet-hit");
  if (!pet || !window.petApi?.bounds) return null;
  try {
    const bounds = await window.petApi.bounds();
    if (!bounds) return null;
    return bounds.y + pet.getBoundingClientRect().bottom;
  } catch {
    return null;
  }
}

/**
 * @returns {Promise<number | null>}
 */
async function measurePetBodyScreenCenterX() {
  const pet = dom.petHit || document.querySelector("#pet-hit");
  if (!pet || !window.petApi?.bounds) return null;
  try {
    const bounds = await window.petApi.bounds();
    if (!bounds) return null;
    const r = pet.getBoundingClientRect();
    return bounds.x + (r.left + r.right) / 2;
  } catch {
    return null;
  }
}

/**
 * @param {number | null | undefined} targetScreenY
 */
async function correctPetFeetScreenY(targetScreenY) {
  if (targetScreenY == null || !Number.isFinite(targetScreenY)) return;
  if (!window.petApi?.moveBy) return;
  await new Promise((r) => requestAnimationFrame(() => r()));
  const now = await measurePetFeetScreenY();
  if (now == null) return;
  const dy = Math.round(targetScreenY - now);
  if (dy !== 0) window.petApi.moveBy({ dx: 0, dy });
}

/**
 * Keep Saya's horizontal screen position stable after a side-dock resize.
 * @param {number | null | undefined} targetScreenX
 */
async function correctPetBodyScreenX(targetScreenX) {
  if (targetScreenX == null || !Number.isFinite(targetScreenX)) return;
  if (!window.petApi?.moveBy) return;
  await new Promise((r) => requestAnimationFrame(() => r()));
  const now = await measurePetBodyScreenCenterX();
  if (now == null) return;
  const dx = Math.round(targetScreenX - now);
  if (dx !== 0) window.petApi.moveBy({ dx, dy: 0 });
}

/**
 * @returns {number | null}
 */
function measureFeetFromBottomClient() {
  const pet = dom.petHit || document.querySelector("#pet-hit");
  if (!pet) return null;
  const bottom = pet.getBoundingClientRect().bottom;
  return Math.max(0, Math.round(window.innerHeight - bottom));
}

/** Apply compact/dock CSS mode classes on #app. */
function setAppCssMode(cssMode) {
  app.classList.remove("mode-compact", "mode-dock");
  app.classList.add(`mode-${cssMode}`);
}

/**
 * Grow the OS window when bubble / dock need room; shrink back to body-only.
 * @param {{ prevFeetFromBottom?: number, feetFromBottom?: number }} [feetOpts]
 * @returns {Promise<void>}
 */
async function syncWindowChrome(feetOpts = {}) {
  if (isDragging || pointerArmed) return;
  /** @type {"compact" | "speak" | "dock" | "dockStats"} */
  let next = "compact";
  if (dockOpen && dockStatsOpen) next = "dockStats";
  else if (dockOpen) next = "dock";
  else if (bubbleOpen) next = "speak";

  const cssMode = dockOpen ? "dock" : "compact";
  setAppCssMode(cssMode);
  applyDockPlacementClass();

  const placementKey = dockOpen ? dockPlacement : "";
  const hasFeetOverride =
    feetOpts.prevFeetFromBottom != null || feetOpts.feetFromBottom != null;
  if (
    next === windowChromeMode &&
    placementKey === lastChromePlacement &&
    !hasFeetOverride
  ) {
    return;
  }
  windowChromeMode = next;
  lastChromePlacement = placementKey;

  /** @type {{ dockPlacement?: "left" | "right", prevFeetFromBottom?: number, feetFromBottom?: number }} */
  const opts = {};
  if (dockOpen) opts.dockPlacement = dockPlacement;
  if (typeof feetOpts.prevFeetFromBottom === "number") {
    opts.prevFeetFromBottom = feetOpts.prevFeetFromBottom;
  }
  if (typeof feetOpts.feetFromBottom === "number") {
    opts.feetFromBottom = feetOpts.feetFromBottom;
  }
  await window.petApi?.setMode?.(next, Object.keys(opts).length ? opts : undefined);
}

function persist() {
  state.lastLine = currentLine;
  state.lastScene = currentScene;
  saveState(state);
}

/**
 * speak() with the current affinity + userName so Saya can call the user by name.
 * @param {string} scene
 * @param {{ affinityGain?: number }} [extra]
 */
function speakState(scene, extra = {}) {
  return speak(scene, { affinity: state.affinity, userName: state.userName, ...extra });
}

/**
 * Collapse dock / compact (used by tray force-compact path).
 */
function collapseToCompact() {
  if (dockOpen) {
    void toggleDock(false);
    return;
  }
  state.mode = "compact";
  setAppCssMode("compact");
  windowChromeMode = "";
  syncWindowChrome();
}

function openBubble(ms = 8000) {
  bubbleOpen = true;
  syncWindowChrome();
  if (bubbleHideTimer) clearTimeout(bubbleHideTimer);
  bubbleHideTimer = setTimeout(() => {
    bubbleOpen = false;
    updateBubbleDom();
  }, ms);
}

function updateBubbleDom() {
  if (dom.lineText) dom.lineText.innerHTML = escapeHtml(currentLine);
  if (dom.bubbleRank) dom.bubbleRank.textContent = getAffinityRank(state.affinity).title;
  if (dom.bubble) dom.bubble.classList.toggle("closed", !bubbleOpen);
  syncWindowChrome();
}

/**
 * Apply affinity gain and optional milestone line append.
 * @param {number} amount
 * @returns {{ before: number, gained: boolean }}
 */
function applyAffinityGain(amount) {
  const before = state.affinity;
  state = gainAffinity(state, amount);
  const gained = Boolean(state._affinityGained && state.affinity > before);
  delete state._affinityGained;
  return { before, gained };
}

/**
 * Append affinity-up milestone line when crossing a 20-point boundary.
 * @param {number} before
 * @param {boolean} gained
 */
function maybeAppendAffinityMilestone(before, gained) {
  if (!gained || state.affinity % 20 !== 0) return;
  const extra = speakState("affinityUp");
  currentLine = `${currentLine}\n${extra.text}`;
}

function say(scene, { affinityGain = 0 } = {}) {
  const line = speakState(scene);
  currentScene = scene;
  currentLine = line.text;

  if (affinityGain > 0) {
    const { before, gained } = applyAffinityGain(affinityGain);
    maybeAppendAffinityMilestone(before, gained);
  }

  openBubble(9000);
  persist();
  updateBubbleDom();
  updateAffinityDom();
  motion.playScene(scene);
  return line;
}

const TIME_BUCKET_LABELS = {
  lateNight: "深夜",
  dawn: "清晨",
  morning: "早晨",
  forenoon: "上午",
  noon: "正午",
  afternoon: "下午",
  evening: "傍晚",
  earlyNight: "晚上",
  night: "夜晚",
};

function updateAffinityDom() {
  const rank = getAffinityRank(state.affinity);
  if (dom.affinityValue) dom.affinityValue.textContent = String(rank.value);
  if (dom.affinityTitle) dom.affinityTitle.textContent = rank.title;
  if (dom.affinityBar) dom.affinityBar.style.width = `${rank.value}%`;
  if (dom.starsRow) dom.starsRow.textContent = starsHtml(rank.stars);
  if (dom.statInteractions) dom.statInteractions.textContent = String(state.totalInteractions || 0);
  if (dom.statPeriod) {
    dom.statPeriod.textContent = TIME_BUCKET_LABELS[timeBucket()] || "此刻";
  }
}

/** Keep the name input / status / save button in sync with state. */
function updateNameDom() {
  if (dom.nameInput) {
    dom.nameInput.value = state.userName || "";
  }
  if (dom.nameStatus) {
    dom.nameStatus.textContent = state.userName ? `已记住·${state.userName}` : "未告诉";
    dom.nameStatus.classList.toggle("has-name", Boolean(state.userName));
  }
  if (dom.nameSave) {
    dom.nameSave.textContent = state.userName ? "改" : "记住";
  }
}

function spawnParticles(x, y, symbol = "✨") {
  const stage = dom.stage || document.querySelector("#stage");
  if (!stage) return;
  for (let i = 0; i < 5; i++) {
    const p = document.createElement("span");
    p.className = "pet-particle";
    p.textContent = symbol;
    const offsetX = (Math.random() - 0.5) * 50;
    const offsetY = (Math.random() - 0.5) * 30;
    p.style.left = `${Math.max(10, Math.min(x + offsetX, 120))}px`;
    p.style.top = `${Math.max(10, Math.min(y + offsetY, 160))}px`;
    p.style.setProperty("--dx", `${(Math.random() - 0.5) * 50}px`);
    p.style.setProperty("--dy", `${-30 - Math.random() * 40}px`);
    stage.appendChild(p);
    setTimeout(() => p.remove(), 900);
  }
}

/**
 * @param {boolean} show
 * @param {{ clientX?: number, clientY?: number }} [pointer]
 * @returns {Promise<void>}
 */
async function toggleDock(show, pointer = {}) {
  const dock = dom.dock || document.querySelector("#pet-dock");
  if (!dock) return;
  const willOpen = Boolean(show);

  if (!willOpen) {
    const feetY = await measurePetFeetScreenY();
    const bodyX = await measurePetBodyScreenCenterX();
    const prevFeet = measureFeetFromBottomClient();
    dockOpen = false;
    dockStatsOpen = false;
    dock.classList.add("closed");
    applyDockPlacementClass();
    updateDockStatsPanel();
    await syncWindowChrome(
      prevFeet != null ? { prevFeetFromBottom: prevFeet } : {},
    );
    await correctPetFeetScreenY(feetY);
    await correctPetBodyScreenX(bodyX);
    refreshMouseIgnore(pointer.clientX, pointer.clientY);
    return;
  }

  if (dockOpen) {
    dock.classList.remove("closed");
    applyDockPlacementClass();
    applyMouseIgnore(false);
    updateDockWanderText();
    updateDockStatsPanel();
    return;
  }

  const feetY = await measurePetFeetScreenY();
  const bodyX = await measurePetBodyScreenCenterX();
  const prevFeet = measureFeetFromBottomClient();

  dockPlacement = await chooseDockPlacement();
  dockOpen = true;
  applyDockPlacementClass();

  /** @type {{ prevFeetFromBottom?: number, feetFromBottom?: number }} */
  const feetOpts = {};
  if (prevFeet != null) {
    feetOpts.prevFeetFromBottom = prevFeet;
    // Side dock keeps feet at the same inset (grows sideways / upward).
    feetOpts.feetFromBottom = prevFeet;
  }

  await syncWindowChrome(feetOpts);
  dock.classList.remove("closed");
  applyDockPlacementClass();
  await correctPetFeetScreenY(feetY);
  await correctPetBodyScreenX(bodyX);
  applyMouseIgnore(false);
  updateDockWanderText();
  updateDockStatsPanel();
}

/**
 * @param {boolean} [show]
 * @returns {Promise<void>}
 */
async function toggleDockStats(show = !dockStatsOpen) {
  if (!dockOpen && show) {
    await toggleDock(true);
  }
  const willShow = Boolean(show) && dockOpen;
  if (willShow === dockStatsOpen) {
    updateDockStatsPanel();
    return;
  }

  const feetY = await measurePetFeetScreenY();
  const bodyX = await measurePetBodyScreenCenterX();
  const prevFeet = measureFeetFromBottomClient();
  dockStatsOpen = willShow;

  /** @type {{ prevFeetFromBottom?: number, feetFromBottom?: number }} */
  const feetOpts = {};
  if (prevFeet != null) {
    feetOpts.prevFeetFromBottom = prevFeet;
    feetOpts.feetFromBottom = prevFeet;
  }

  windowChromeMode = "";
  lastChromePlacement = "";
  await syncWindowChrome(feetOpts);
  updateDockStatsPanel();
  await correctPetFeetScreenY(feetY);
  await correctPetBodyScreenX(bodyX);
  if (dockStatsOpen) {
    updateAffinityDom();
    updateNameDom();
  }
  applyMouseIgnore(false);
}

function updateDockStatsPanel() {
  const panel = dom.dockStats || document.querySelector("#dock-stats");
  const toggleBtn = dom.dockStatsToggle || document.querySelector("#dock-stats-toggle");
  if (panel) {
    panel.classList.toggle("closed", !dockStatsOpen);
    panel.setAttribute("aria-hidden", dockStatsOpen ? "false" : "true");
  }
  if (toggleBtn) {
    toggleBtn.classList.toggle("is-on", dockStatsOpen);
    toggleBtn.setAttribute("aria-expanded", dockStatsOpen ? "true" : "false");
    const lbl = toggleBtn.querySelector(".lbl");
    if (lbl) lbl.textContent = dockStatsOpen ? "收起" : "星轨";
    toggleBtn.title = dockStatsOpen ? "收起星轨信息" : "查看星轨亲密度";
  }
}

function updateDockWanderText() {
  const toggleBtn = dom.dockWanderToggle || document.querySelector("#dock-wander-toggle");
  if (!toggleBtn) return;
  const on = autoWanderEnabled;
  toggleBtn.classList.toggle("is-on", on);
  const ico = toggleBtn.querySelector(".ico");
  const lbl = toggleBtn.querySelector(".lbl");
  if (ico) ico.textContent = "🌐";
  if (lbl) lbl.textContent = on ? "漫游" : "定住";
  toggleBtn.setAttribute("aria-pressed", on ? "true" : "false");
  toggleBtn.title = on ? "漫游：开启（点击关闭）" : "漫游：关闭（点击开启）";
}

/**
 * Speak a custom or scene line with optional affinity, bubble, and DOM refresh.
 * @param {{ scene?: string, text?: string, affinityGain?: number, bubbleMs?: number }} opts
 */
function speakAndShow(opts) {
  const gain = opts.affinityGain ?? 0;
  let before = state.affinity;
  let gained = false;
  if (gain > 0) {
    ({ before, gained } = applyAffinityGain(gain));
  }

  if (opts.scene) {
    const line = speakState(opts.scene);
    currentScene = opts.scene === "menuSit" || opts.scene === "menuPose" ? "talk" : opts.scene;
    currentLine = line.text;
  } else {
    currentScene = "talk";
    currentLine = opts.text || "";
  }

  maybeAppendAffinityMilestone(before, gained);
  openBubble(opts.bubbleMs ?? 5000);
  updateBubbleDom();
  if (gain > 0) updateAffinityDom();
  persist();
}

async function handleDockAction(action) {
  switch (action) {
    case "stats":
      await toggleDockStats(!dockStatsOpen);
      break;
    case "stats-close":
      await toggleDockStats(false);
      break;
    case "save-name": {
      const input = dom.nameInput || document.querySelector("#user-name-input");
      const raw = (input?.value || "").trim();
      const hadName = Boolean(state.userName);
      state = setUserName(state, raw);
      persist();
      updateNameDom();

      const scene = state.userName ? "nameSet" : "nameForget";
      currentScene = "talk";
      currentLine = speakState(scene).text;
      openBubble(6000);
      updateBubbleDom();
      if (state.userName && !hadName) spawnParticles(70, 90, "✨");
      break;
    }
    case "talk":
      say(Math.random() < 0.45 ? timeBucket() : "talk", { affinityGain: 1 });
      break;
    case "praise":
      say("praise", { affinityGain: 2 });
      spawnParticles(70, 90, "💖");
      break;
    case "move":
      // 运动：随机散步 / 小跳
      await handleDockAction(Math.random() < 0.5 ? "walk" : "hop");
      break;
    case "walk": {
      speakAndShow({
        text: "要在桌面上走走吗？好的~",
        affinityGain: 1,
        bubbleMs: 4000,
      });
      const ok = await wander.planWalk({ force: true });
      if (!ok) {
        currentLine = "等我一下，现在好像走不开…再试一次好吗？";
        openBubble(3500);
        updateBubbleDom();
      }
      break;
    }
    case "hop": {
      motion.lockFor(2800);
      motion.playBehavior("menuHop", { force: true });
      spawnParticles(70, 90, "✨");
      break;
    }
    case "rest": {
      // 休息：随机坐下 / 换姿势，至少歇一分钟以上
      const restMs = 65_000;
      const scene = Math.random() < 0.5 ? "menuSit" : "menuPose";
      motion.lockFor(restMs);
      speakAndShow({ scene, affinityGain: 1, bubbleMs: 5000 });
      motion.playBehavior(scene, { force: true, holdMs: restMs });
      break;
    }
    case "sit": {
      motion.lockFor(6000);
      speakAndShow({ scene: "menuSit", affinityGain: 1, bubbleMs: 5000 });
      motion.playBehavior("menuSit", { force: true, holdMs: 6000 });
      break;
    }
    case "pose": {
      motion.lockFor(5800);
      speakAndShow({ scene: "menuPose", affinityGain: 1, bubbleMs: 4800 });
      motion.playBehavior("menuPose", { force: true, holdMs: 5800 });
      break;
    }
    case "toggle-wander":
      autoWanderEnabled = !autoWanderEnabled;
      if (autoWanderEnabled) {
        wander.start();
        speakAndShow({
          text: "嗯，漫游开启啦！我会偶尔在桌面上走走。",
          bubbleMs: 4000,
        });
      } else {
        wander.stop();
        speakAndShow({
          text: "漫游关闭了。我就站在这里陪着你。",
          bubbleMs: 4000,
        });
      }
      updateDockWanderText();
      break;
    case "hide":
      say("hide", { affinityGain: 0 });
      setTimeout(() => window.petApi?.hide?.(), 400);
      break;
    default:
      break;
  }
}

function starsHtml(count) {
  return "★".repeat(count) + "☆".repeat(Math.max(0, 6 - count));
}

function shellHtml() {
  const rank = getAffinityRank(state.affinity);
  const bubbleClass = bubbleOpen ? "bubble" : "bubble closed";
  const dockClass = dockOpen ? "dock" : "dock closed";
  const statsClass = dockStatsOpen ? "dock-sub" : "dock-sub closed";
  const wanderOn = autoWanderEnabled;
  const periodLabel = TIME_BUCKET_LABELS[timeBucket()] || "此刻";
  const placementClass = !dockOpen
    ? ""
    : dockPlacement === "left"
      ? "dock-placement-left"
      : "dock-placement-right";
  return `
    <div class="shell art-body shell-minimal shell-with-bubble${placementClass ? ` ${placementClass}` : ""}">
      <div class="shell-col" id="shell-col">
        <div class="${bubbleClass}" id="bubble" role="status" aria-live="polite" title="点击与沙夜对话">
          <div class="bubble-meta">
            <span class="bubble-name">${CHARACTER.shortName}</span>
            <span class="bubble-rank">${rank.title}</span>
          </div>
          <p class="bubble-text" id="line-text">${escapeHtml(currentLine || "……")}</p>
        </div>

        <div class="stage" id="stage">
          <div class="stars" id="stars" aria-hidden="true"></div>
          <div class="stage-glow"></div>

          <button class="pet-hit" id="pet-hit" type="button" aria-label="拖动天之川沙夜">
            <div class="pet-actor act-idle" id="pet-actor" data-action="idle">
              <div class="pet-shadow" aria-hidden="true"></div>
              <div class="pet-body">
                <img class="pet-sprite is-visible" id="pet-layer-a" alt="${CHARACTER.name}" draggable="false" />
                <img class="pet-sprite" id="pet-layer-b" alt="" draggable="false" />
              </div>
            </div>
          </button>
        </div>
      </div>

      <div class="${dockClass}" id="pet-dock" role="toolbar" aria-label="沙夜快捷栏">
        <div
          class="${statsClass}"
          id="dock-stats"
          role="region"
          aria-label="星轨信息"
          aria-hidden="${dockStatsOpen ? "false" : "true"}"
        >
          <div class="dock-sub-head">
            <span class="dock-sub-title">星轨信息</span>
            <button class="dock-sub-close" data-dock-action="stats-close" type="button" title="收起">
              ✕
            </button>
          </div>
          <div class="affinity-card dock-affinity" aria-label="星轨亲密度">
            <div class="affinity-meta">
              <div class="label">星轨亲密度</div>
              <div class="title">${escapeHtml(rank.title)}</div>
            </div>
            <div class="affinity-value">${rank.value}</div>
            <div class="affinity-bar" aria-hidden="true"><i style="width: ${rank.value}%"></i></div>
            <div class="stars-row" aria-hidden="true">${starsHtml(rank.stars)}</div>
          </div>
          <div class="stat-grid dock-stats-grid">
            <div class="stat-pill">
              <span>互动次数</span>
              <strong id="stat-interactions">${state.totalInteractions || 0}</strong>
            </div>
            <div class="stat-pill">
              <span>此刻时段</span>
              <strong id="stat-period">${periodLabel}</strong>
            </div>
          </div>
          <div class="name-card">
            <div class="name-head">
              <span class="label">我的名字</span>
              <span class="name-status${state.userName ? " has-name" : ""}" id="name-status"
                >${state.userName ? `已记住·${escapeHtml(state.userName)}` : "未告诉"}</span
              >
            </div>
            <div class="name-row">
              <input
                type="text"
                id="user-name-input"
                class="name-input"
                maxlength="12"
                placeholder="告诉我你的名字…"
                value="${escapeHtml(state.userName)}"
                autocomplete="off"
                spellcheck="false"
                aria-label="告诉沙夜你的名字"
              />
              <button class="name-save" data-dock-action="save-name" id="name-save" type="button" title="告诉沙夜你的名字">
                ${state.userName ? "改" : "记住"}
              </button>
            </div>
            <p class="name-hint">告诉沙夜名字后，她偶尔会在对话里呼唤你。</p>
          </div>
        </div>

        <div class="dock-actions" role="group" aria-label="快捷操作">
          <button class="dock-btn primary" data-dock-action="talk" type="button" title="聊聊天">
            <span class="ico" aria-hidden="true">💬</span>
            <span class="lbl">聊聊</span>
          </button>
          <button class="dock-btn" data-dock-action="praise" type="button" title="夸夸沙夜">
            <span class="ico" aria-hidden="true">✨</span>
            <span class="lbl">夸奖</span>
          </button>
          <button class="dock-btn" data-dock-action="move" type="button" title="运动：随机散步或小跳">
            <span class="ico" aria-hidden="true">🏃</span>
            <span class="lbl">运动</span>
          </button>
          <button class="dock-btn" data-dock-action="rest" type="button" title="休息：随机坐下或换姿势">
            <span class="ico" aria-hidden="true">🌙</span>
            <span class="lbl">休息</span>
          </button>
          <button
            class="dock-btn${wanderOn ? " is-on" : ""}"
            data-dock-action="toggle-wander"
            id="dock-wander-toggle"
            type="button"
            aria-pressed="${wanderOn ? "true" : "false"}"
            title="${wanderOn ? "漫游：开启（点击关闭）" : "漫游：关闭（点击开启）"}"
          >
            <span class="ico" aria-hidden="true">🌐</span>
            <span class="lbl">${wanderOn ? "漫游" : "定住"}</span>
          </button>
          <button
            class="dock-btn${dockStatsOpen ? " is-on" : ""}"
            data-dock-action="stats"
            id="dock-stats-toggle"
            type="button"
            aria-expanded="${dockStatsOpen ? "true" : "false"}"
            title="${dockStatsOpen ? "收起星轨信息" : "查看星轨亲密度"}"
          >
            <span class="ico" aria-hidden="true">⭐</span>
            <span class="lbl">${dockStatsOpen ? "收起" : "星轨"}</span>
          </button>
          <button class="dock-btn danger" data-dock-action="hide" type="button" title="隐藏到托盘">
            <span class="ico" aria-hidden="true">📌</span>
            <span class="lbl">隐藏</span>
          </button>
        </div>
      </div>
    </div>
  `;
}

function escapeHtml(str) {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("\n", "<br/>");
}

function paintStars() {
  const host = document.querySelector("#stars");
  if (!host || host.childElementCount) return;
  const frag = document.createDocumentFragment();
  for (let i = 0; i < 14; i++) {
    const s = document.createElement("span");
    s.className = "star";
    s.style.left = `${8 + Math.random() * 84}%`;
    s.style.top = `${6 + Math.random() * 70}%`;
    s.style.setProperty("--dur", `${2.4 + Math.random() * 3}s`);
    s.style.setProperty("--delay", `${Math.random() * 2}s`);
    frag.appendChild(s);
  }
  host.appendChild(frag);
}

function bind() {
  cacheDom();
  const pet = dom.petHit;
  const bubble = dom.bubble;
  const dock = dom.dock;

  if (bubble) {
    bubble.addEventListener("click", (e) => {
      if (!bubbleOpen) return;
      e.stopPropagation();
      say(Math.random() < 0.5 ? timeBucket() : "talk", { affinityGain: 1 });
    });
  }

  if (dock) {
    dock.addEventListener("pointerdown", (e) => e.stopPropagation());
    dock.addEventListener("pointerup", (e) => e.stopPropagation());
    dock.addEventListener("click", async (e) => {
      const btn = e.target.closest?.("[data-dock-action]");
      if (!btn) return;
      e.stopPropagation();
      const act = btn.getAttribute("data-dock-action");
      await handleDockAction(act);
      if (act !== "stats" && act !== "stats-close") {
        await toggleDock(false, { clientX: e.clientX, clientY: e.clientY });
      }
    });

    const nameInput = dom.nameInput || dock.querySelector?.("#user-name-input");
    if (nameInput) {
      nameInput.addEventListener("keydown", (e) => {
        if (e.key !== "Enter") return;
        e.stopPropagation();
        handleDockAction("save-name");
      });
      nameInput.addEventListener("pointerdown", (e) => e.stopPropagation());
    }
  }

  if (pet) {
    const isDockEvent = (event) => Boolean(event.target?.closest?.("#pet-dock"));

    /**
     * @param {boolean} treatAsDrag
     * @param {{ clientX?: number, clientY?: number }} [pointer]
     */
    const finishPointer = (treatAsDrag, pointer = {}) => {
      const session = drag;
      const dragged = Boolean(treatAsDrag || isDragging || session?.moved);
      const hadPointer = Boolean(session || isDragging || pointerArmed);

      notePointerClient(pointer.clientX, pointer.clientY);
      if (hadPointer) armStickyHit();

      drag = null;
      isDragging = false;
      pointerArmed = false;
      pet.classList.remove("is-dragging");
      setDraggingLock(false);

      if (!hadPointer) {
        motion.setPaused?.(false);
        wander.resume();
        return false;
      }

      if (dragged) {
        suppressClickUntil = Date.now() + CLICK_SUPPRESS_MS;
        const deferred = pendingAfterDrag;
        pendingAfterDrag = null;
        if (deferred) {
          void finishDragWithZone({ deferUi: true }).then(() => {
            requestAnimationFrame(() => {
              if (!isDragging && !pointerArmed) {
                deferred();
                syncWindowChrome();
                armStickyHit();
                refreshMouseIgnore(lastPointerClientX, lastPointerClientY);
              }
            });
          });
        } else {
          void finishDragWithZone({ deferUi: false }).then(() => {
            syncWindowChrome();
            armStickyHit();
            refreshMouseIgnore(lastPointerClientX, lastPointerClientY);
          });
        }
        return true;
      }

      motion.setPaused?.(false);
      wander.resume();
      pendingAfterDrag = null;
      syncWindowChrome();
      refreshMouseIgnore(lastPointerClientX, lastPointerClientY);
      return false;
    };

    pet.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      if (isDockEvent(event)) return;
      notePointerClient(event.clientX, event.clientY);
      pointerArmed = true;
      armStickyHit();
      applyMouseIgnore(false);
      if (dockOpen) toggleDock(false, { clientX: event.clientX, clientY: event.clientY });
      isDragging = false;
      pendingAfterDrag = null;
      wander.pause();
      drag = {
        pointerId: event.pointerId,
        lastX: event.screenX,
        lastY: event.screenY,
        startX: event.screenX,
        startY: event.screenY,
        moved: false,
      };
      try {
        pet.setPointerCapture(event.pointerId);
      } catch {
        // ignore capture failures
      }
    });

    pet.addEventListener("pointermove", (event) => {
      if (!drag || drag.pointerId !== event.pointerId) return;
      notePointerClient(event.clientX, event.clientY);

      const totalDx = event.screenX - drag.startX;
      const totalDy = event.screenY - drag.startY;
      const dist = Math.hypot(totalDx, totalDy);

      if (dist >= DRAG_THRESHOLD_PX) {
        drag.moved = true;
      }

      if (!isDragging && dist >= DRAG_THRESHOLD_PX) {
        isDragging = true;
        pet.classList.add("is-dragging");
        pendingAfterDrag = null;
        setDraggingLock(true);
        motion.setPaused?.(true);
        wander.pause();
      }
      if (!isDragging) return;

      const dx = event.screenX - drag.lastX;
      const dy = event.screenY - drag.lastY;
      drag.lastX = event.screenX;
      drag.lastY = event.screenY;
      if (dx === 0 && dy === 0) return;

      window.petApi?.moveBy?.({ dx, dy });
    });

    pet.addEventListener("pointerup", (event) => {
      if (drag && drag.pointerId !== event.pointerId) return;
      notePointerClient(event.clientX, event.clientY);
      const moved = Boolean(drag?.moved || isDragging);
      const dragged = finishPointer(moved, {
        clientX: event.clientX,
        clientY: event.clientY,
      });
      if (dragged) return;
      if (Date.now() < suppressClickUntil) return;

      const scene = Math.random() < 0.55 ? timeBucket() : "tap";
      say(scene, { affinityGain: 1 });
      const rect = pet.getBoundingClientRect();
      spawnParticles(event.clientX - rect.left, event.clientY - rect.top, "✨");
    });

    pet.addEventListener("pointercancel", (event) => {
      if (drag && event.pointerId != null && drag.pointerId !== event.pointerId) return;
      notePointerClient(event.clientX, event.clientY);
      finishPointer(true, { clientX: event.clientX, clientY: event.clientY });
    });

    pet.addEventListener("lostpointercapture", () => {
      if (!drag && !isDragging && !pointerArmed) return;
      finishPointer(true);
    });

    pet.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (isDragging) return;
      toggleDock(!dockOpen, { clientX: event.clientX, clientY: event.clientY });
    });

    pet.addEventListener("dblclick", (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (isDragging || Date.now() < suppressClickUntil) return;
      if (dockOpen) toggleDock(false, { clientX: event.clientX, clientY: event.clientY });
      const scene = Math.random() < 0.5 ? "affinityUp" : "praise";
      say(scene, { affinityGain: 2 });
      const rect = pet.getBoundingClientRect();
      spawnParticles(
        event.clientX - rect.left,
        event.clientY - rect.top,
        Math.random() < 0.5 ? "💖" : "✨",
      );
    });
  }

  motion.attach(pet, {
    actionChange: (actionId, meta) => {
      wander.onAction(actionId, meta);
    },
  });

  paintStars();
  refreshMouseIgnore();
}

document.addEventListener(
  "pointermove",
  (e) => {
    if (isDragging || pointerArmed) {
      notePointerClient(e.clientX, e.clientY);
      return;
    }
    scheduleRefreshMouseIgnore(e.clientX, e.clientY);
  },
  { passive: true, capture: true },
);

document.addEventListener("pointerleave", () => {
  if (isDragging || pointerArmed || dockOpen) return;
  lastPointerClientX = null;
  lastPointerClientY = null;
  if (Date.now() < stickyHitUntil) return;
  applyMouseIgnore(true);
});

document.addEventListener("click", (e) => {
  if (!dockOpen) return;
  if (e.target.closest("#pet-dock") || e.target.closest("#pet-hit")) return;
  toggleDock(false, { clientX: e.clientX, clientY: e.clientY });
});

function paint() {
  motion.detach();
  if (!dockOpen) state.mode = "compact";
  setAppCssMode(dockOpen ? "dock" : "compact");
  app.innerHTML = shellHtml();
  bind();
  updateDockWanderText();
  updateDockStatsPanel();
  updateAffinityDom();
  updateNameDom();
}

function boot() {
  state.mode = "compact";
  bubbleOpen = false;
  app.classList.add("mode-compact");

  const greetingScene = timeBucket();
  const line = speakState(Math.random() < 0.5 ? "boot" : greetingScene);
  currentScene = line.scene;
  currentLine = line.text;
  openBubble(10000);
  persist();
  zoneTracker.start();
  paint();
  motion.playScene(currentScene);
  wander.start();
  windowChromeMode = "";
  syncWindowChrome();
  applyMouseIgnore(true);

  window.petApi?.onSetMode?.((mode) => {
    if (!mode) return;
    if (mode === "speak" || mode === "compact" || mode === "dock" || mode === "dockStats") {
      windowChromeMode = mode;
      if (mode === "dock" || mode === "dockStats") {
        dockOpen = true;
        dockStatsOpen = mode === "dockStats";
        lastChromePlacement = dockPlacement;
        document.querySelector("#pet-dock")?.classList.remove("closed");
        setAppCssMode("dock");
        applyDockPlacementClass();
        updateDockStatsPanel();
      } else if (mode === "compact" && dockOpen) {
        dockOpen = false;
        dockStatsOpen = false;
        lastChromePlacement = "";
        document.querySelector("#pet-dock")?.classList.add("closed");
        setAppCssMode("compact");
        applyDockPlacementClass();
        updateDockStatsPanel();
      }
      return;
    }
    collapseToCompact();
  });
}

window.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  if (dockStatsOpen) {
    toggleDockStats(false);
    return;
  }
  if (dockOpen) {
    toggleDock(false);
    return;
  }
  if (bubbleOpen) {
    bubbleOpen = false;
    updateBubbleDom();
    return;
  }
  window.petApi?.hide?.();
});

boot();
