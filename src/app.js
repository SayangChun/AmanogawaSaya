import { CHARACTER, getAffinityRank } from "./character/profile.js";
import { speak, timeBucket } from "./character/dialogue.js";
import { createMotionController } from "./character/motion.js";
import { createWanderController } from "./character/wander.js";
import {
  createZoneTracker,
  isZonePosesEnabled,
} from "./character/screen-zone.js";
import { loadState, saveState, gainAffinity } from "./state.js";

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
/** Bottom shortcut dock open (right-click). */
let dockOpen = false;
/** Secondary dock submenu: affinity / stats (under 星轨). */
let dockStatsOpen = false;
/**
 * Where the dock sits relative to Saya: below feet (default) or above head.
 * Chosen from free work-area space so the window can grow without shoving her.
 * @type {"above" | "below"}
 */
let dockPlacement = "below";
/** Last applied OS mouse-ignore state (true = click-through empty pixels). */
let mouseIgnoreActive = null;
/**
 * Last known pointer position in window client coords.
 * Used when refreshMouseIgnore() is called without a sample point (e.g. after
 * pointerup) so we do not default to click-through while still over Saya.
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

const zoneTracker = createZoneTracker({
  getBounds: () => window.petApi?.bounds?.() ?? Promise.resolve(null),
  getWorkArea: () => window.petApi?.workArea?.() ?? Promise.resolve(null),
  enabled: () => isZonePosesEnabled(),
});

const motion = createMotionController({
  getZoneSnapshot: (opts) => zoneTracker.getSnapshot(opts),
  getLastZoneId: () => zoneTracker.getZoneId(),
  onZoneSit: (_zoneId) => {
    // Quiet by default; occasional place-aware line only.
    if (bubbleOpen || Math.random() >= 0.15) return;
    const line = speak("zoneSit", { affinity: state.affinity });
    currentLine = line.text;
    openBubble(3500);
    updateBubbleDom();
  },
});

/**
 * Stage focus: no full settings panel; speech bubble + bottom shortcut dock.
 * Dock opens on right-click (replaces the old floating context menu).
 */
const UI_MINIMAL = true;
/** When true, dialogue bubble is rendered even in minimal stage mode. */
const SHOW_BUBBLE = true;
let bubbleOpen = false;
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

function isPointerBlocked() {
  return isDragging || pointerArmed || Date.now() < suppressClickUntil;
}

const wander = createWanderController({
  motion,
  moveBy: (delta) => window.petApi?.moveBy?.(delta),
  getBounds: () => window.petApi?.bounds?.() ?? Promise.resolve(null),
  getWorkArea: () => window.petApi?.workArea?.() ?? Promise.resolve(null),
  getRoamBias: (opts) => zoneTracker.getRoamBias(opts),
  // Only real drag sessions block locomotion — not post-drag click suppress.
  isBlocked: () => isDragging || pointerArmed,
  onRoamStart: (_kind) => {
    if (Math.random() < 0.15 && !bubbleOpen) {
      const line = speak(timeBucket(), { affinity: state.affinity });
      currentLine = line.text;
      openBubble(4500);
    }
  },
});

/**
 * After a real window drag: unpause without resuming pre-drag clip,
 * then play a single settle or idle (no double force-play).
 * @param {{ deferUi?: boolean }} [opts] deferUi=true when a post-drag UI callback will run
 */
async function finishDragWithZone(opts = {}) {
  motion.setPaused?.(false, { skipResume: true });
  wander.resume();

  // If deferred UI or dock owns the next beat, only restore idle once.
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

  // Post-await: user may have grabbed her again.
  if (isDragging || pointerArmed || motion.isPaused?.()) return;

  if (snap?.zoneId) {
    const actor = document.querySelector("#pet-actor");
    if (actor) actor.dataset.zone = snap.zoneId;
  }

  if (snap && Math.random() < 0.45) {
    const z = snap.zoneId || "";
    if ((z.startsWith("corner-b") || z === "edge-bottom") && Math.random() < 0.35) {
      motion.playBehavior("settleCorner", { force: true, holdMs: 3500 });
      // Rare quiet place-aware line
      if (Math.random() < 0.15 && !bubbleOpen) {
        const line = speak("zoneSit", { affinity: state.affinity });
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

  // Open area: soft multi-action settle or plain idle
  if (Math.random() < 0.4) {
    motion.playBehavior("settle", { force: true });
  } else {
    motion.play("idle", { force: true, fromIdle: true });
  }
}

function setDraggingLock(on) {
  window.petApi?.setDragging?.(Boolean(on));
  // Dragging always needs a solid hit target under the cursor.
  if (on) applyMouseIgnore(false);
  else refreshMouseIgnore();
}

/**
 * Remember last pointer client position for hit-testing after pointerup.
 * @param {number} [x]
 * @param {number} [y]
 */
function notePointerClient(x, y) {
  if (typeof x === "number" && Number.isFinite(x)) lastPointerClientX = x;
  if (typeof y === "number" && Number.isFinite(y)) lastPointerClientY = y;
}

/**
 * Keep the window solid for a short period after pet interaction so continuous
 * clicks cannot race past setIgnoreMouseEvents into the desktop below.
 * When the sticky window ends, re-run hit-test (or passthrough if the cursor left).
 * @param {number} [ms]
 */
function armStickyHit(ms = STICKY_HIT_MS) {
  stickyHitUntil = Math.max(stickyHitUntil, Date.now() + ms);
  if (stickyHitTimer) clearTimeout(stickyHitTimer);
  const remain = Math.max(0, stickyHitUntil - Date.now());
  stickyHitTimer = setTimeout(() => {
    stickyHitTimer = null;
    if (isDragging || pointerArmed || dockOpen) return;
    // If sticky was extended again, wait for the later timer.
    if (Date.now() < stickyHitUntil) return;
    refreshMouseIgnore(lastPointerClientX, lastPointerClientY);
  }, remain + 1);
}

/**
 * OS-level click-through: transparent chrome must not steal desktop clicks.
 * @param {boolean} ignore
 */
function applyMouseIgnore(ignore) {
  const next = Boolean(ignore);
  if (mouseIgnoreActive === next) return;
  mouseIgnoreActive = next;
  window.petApi?.setIgnoreMouseEvents?.(next, { forward: true });
}

/**
 * True when the element (or an ancestor) is a real interactive surface.
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
 * Recompute mouse ignore from pointer position / UI state.
 * Without explicit coords, reuses the last known pointer sample instead of
 * blindly enabling passthrough (that was dropping rapid pet clicks through).
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
    // No sample point yet (boot / left window) — allow desktop passthrough.
    applyMouseIgnore(true);
    return;
  }
  const el = document.elementFromPoint(clientX, clientY);
  applyMouseIgnore(!isInteractiveTarget(el));
}

/**
 * Pick dock side from free work-area space around the current window.
 * Prefer below; use above when the bar would not fit under the feet.
 * @returns {Promise<"above" | "below">}
 */
async function chooseDockPlacement() {
  try {
    const [bounds, work] = await Promise.all([
      window.petApi?.bounds?.() ?? Promise.resolve(null),
      window.petApi?.workArea?.() ?? Promise.resolve(null),
    ]);
    if (!bounds || !work) return "below";

    // Extra height to grow when opening dock chrome (compact → dock / dockStats).
    const need = dockStatsOpen ? 250 : 140;
    const spaceBelow = work.y + work.height - (bounds.y + bounds.height);
    const spaceAbove = bounds.y - work.y;

    if (spaceBelow >= need) return "below";
    if (spaceAbove >= need) return "above";
    return spaceAbove > spaceBelow ? "above" : "below";
  } catch {
    return "below";
  }
}

/**
 * Apply dock-above / dock-below classes on the shell so flex order places
 * the bar next to Saya without shifting her layout slot incorrectly.
 */
function applyDockPlacementClass() {
  const shell = document.querySelector(".shell");
  if (!shell) return;
  shell.classList.toggle("dock-placement-above", dockOpen && dockPlacement === "above");
  shell.classList.toggle("dock-placement-below", dockOpen && dockPlacement === "below");
}

/**
 * Desktop Y of the pet-hit bottom edge (feet line), for jump-free chrome resize.
 * @returns {Promise<number | null>}
 */
async function measurePetFeetScreenY() {
  const pet = document.querySelector("#pet-hit");
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
 * Nudge the window so pet feet return to a captured screen Y (sub-pixel / CSS slack).
 * @param {number | null | undefined} targetScreenY
 */
async function correctPetFeetScreenY(targetScreenY) {
  if (targetScreenY == null || !Number.isFinite(targetScreenY)) return;
  if (!window.petApi?.moveBy) return;
  // Wait one frame so flex layout reflects the new dock / window size.
  await new Promise((r) => requestAnimationFrame(() => r()));
  const now = await measurePetFeetScreenY();
  if (now == null) return;
  const dy = Math.round(targetScreenY - now);
  if (dy !== 0) window.petApi.moveBy({ dx: 0, dy });
}

/**
 * Distance from the window client bottom to the pet-hit bottom (measured).
 * @returns {number | null}
 */
function measureFeetFromBottomClient() {
  const pet = document.querySelector("#pet-hit");
  if (!pet) return null;
  const bottom = pet.getBoundingClientRect().bottom;
  return Math.max(0, Math.round(window.innerHeight - bottom));
}

/**
 * Grow the OS window when bubble / dock need room; shrink back to body-only.
 * Main-process setMode keeps character *feet* fixed; dockPlacement chooses
 * whether chrome grows above or below so Saya does not jump.
 * Skips while dragging (main process locks size); call again after release.
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

  // Keep CSS mode in sync so dock layout rules apply.
  const cssMode = dockOpen ? "dock" : "compact";
  app.classList.remove("mode-compact", "mode-dock", "mode-panel");
  app.classList.add(`mode-${cssMode}`);
  applyDockPlacementClass();
  if (!UI_MINIMAL) state.mode = cssMode;

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

  /** @type {{ dockPlacement?: "above" | "below", prevFeetFromBottom?: number, feetFromBottom?: number }} */
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

// ---------- persistence helpers ----------
function persist() {
  state.lastLine = currentLine;
  state.lastScene = currentScene;
  saveState(state);
}

/**
 * Queue UI that would resize the window until drag ends.
 */
function runOrDeferWhileDragging(fn) {
  if (isDragging || pointerArmed) {
    pendingAfterDrag = fn;
    return;
  }
  fn();
}

function setMode(mode, { repaint = true } = {}) {
  // Minimal stage: no full panel; dock is toggled via toggleDock, not mode stack.
  if (UI_MINIMAL) {
    if (mode === "panel") mode = "compact";
    if (mode === "dock") {
      toggleDock(true);
      return true;
    }
    if (mode === "compact") {
      toggleDock(false);
    }
  }

  if ((isDragging || pointerArmed) && mode !== state.mode) {
    pendingAfterDrag = () => setMode(mode, { repaint });
    return false;
  }

  const changed = state.mode !== mode;
  if (!changed) {
    app.classList.remove("mode-compact", "mode-dock", "mode-panel");
    app.classList.add(`mode-${mode}`);
    return false;
  }

  state.mode = mode;
  app.classList.remove("mode-compact", "mode-dock", "mode-panel");
  app.classList.add(`mode-${mode}`);
  persist();
  if (UI_MINIMAL) {
    // Footprint is driven by bubble / dock chrome.
    windowChromeMode = "";
    syncWindowChrome();
  } else {
    window.petApi?.setMode?.(mode);
  }
  if (repaint) paint();
  return true;
}

function openBubble(ms = 8000) {
  if (!SHOW_BUBBLE) {
    bubbleOpen = false;
    syncWindowChrome();
    return;
  }
  bubbleOpen = true;
  syncWindowChrome();
  if (bubbleHideTimer) clearTimeout(bubbleHideTimer);
  bubbleHideTimer = setTimeout(() => {
    bubbleOpen = false;
    updateBubbleDom();
  }, ms);
}

function updateBubbleDom() {
  const bubble = document.querySelector("#bubble");
  const line = document.querySelector("#line-text");
  const rankEl = document.querySelector(".bubble-rank");
  if (line) line.innerHTML = escapeHtml(currentLine);
  if (rankEl) rankEl.textContent = getAffinityRank(state.affinity).title;
  if (bubble) bubble.classList.toggle("closed", !bubbleOpen);
  syncWindowChrome();
}

function setArtStyle(_art) {
  state.artStyle = "body";
  const shell = document.querySelector(".shell");
  if (shell) {
    shell.classList.remove("art-q", "art-normal", "art-orb");
    shell.classList.add("art-body");
  }
}

function say(scene, { affinityGain = 0 } = {}) {
  const line = speak(scene, { affinity: state.affinity });
  currentScene = scene;
  currentLine = line.text;

  if (affinityGain > 0) {
    const before = state.affinity;
    state = gainAffinity(state, affinityGain);
    if (state._affinityGained && state.affinity > before && state.affinity % 20 === 0) {
      const extra = speak("affinityUp", { affinity: state.affinity });
      currentLine = `${currentLine}\n${extra.text}`;
    }
    delete state._affinityGained;
  }

  setArtStyle("body");
  openBubble(9000);
  persist();

  if (document.querySelector("#pet-actor")) {
    updateBubbleDom();
    updateAffinityDom();
    motion.playScene(scene);
  } else {
    paint();
    motion.playScene(scene);
  }

  return line;
}

const TIME_BUCKET_LABELS = {
  morning: "清晨",
  noon: "正午",
  afternoon: "午后",
  evening: "傍晚",
  night: "夜晚",
  lateNight: "深夜",
};

function updateAffinityDom() {
  const rank = getAffinityRank(state.affinity);
  const valueEl = document.querySelector(".affinity-value");
  const titleEl = document.querySelector(".affinity-card .title");
  const bar = document.querySelector(".affinity-bar > i");
  const stars = document.querySelector(".stars-row");
  const total = document.querySelector("#stat-interactions");
  const periodEl = document.querySelector("#stat-period");
  if (valueEl) valueEl.textContent = String(rank.value);
  if (titleEl) titleEl.textContent = rank.title;
  if (bar) bar.style.width = `${rank.value}%`;
  if (stars) stars.textContent = starsHtml(rank.stars);
  if (total) total.textContent = String(state.totalInteractions || 0);
  if (periodEl) {
    const bucket = timeBucket();
    periodEl.textContent = TIME_BUCKET_LABELS[bucket] || "此刻";
  }
}

// ---------- particles helper ----------
function spawnParticles(x, y, symbol = "✨") {
  const stage = document.querySelector("#stage");
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

// ---------- shortcut dock (above / below character) ----------
/**
 * Show / hide the action dock (right-click).
 * Opens beside Saya (below by default, above near the bottom edge) without
 * moving her screen position — window grows around her feet.
 * @param {boolean} show
 * @param {{ clientX?: number, clientY?: number }} [pointer]
 * @returns {Promise<void>}
 */
async function toggleDock(show, pointer = {}) {
  const dock = document.querySelector("#pet-dock");
  if (!dock) return;
  const willOpen = Boolean(show);

  if (!willOpen) {
    // Capture feet before chrome collapses so close does not drop her.
    const feetY = await measurePetFeetScreenY();
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
    refreshMouseIgnore(pointer.clientX, pointer.clientY);
    return;
  }

  if (dockOpen) {
    // Already open — keep current side; still ensure chrome is applied.
    dock.classList.remove("closed");
    applyDockPlacementClass();
    applyMouseIgnore(false);
    updateDockWanderText();
    updateDockStatsPanel();
    return;
  }

  // Feet screen Y before any layout change — gold standard for no-jump open.
  const feetY = await measurePetFeetScreenY();
  const prevFeet = measureFeetFromBottomClient();

  // Resolve side first so setMode grows the correct direction.
  dockPlacement = await chooseDockPlacement();
  dockOpen = true;
  applyDockPlacementClass();

  /** @type {{ prevFeetFromBottom?: number, feetFromBottom?: number }} */
  const feetOpts = {};
  if (prevFeet != null) feetOpts.prevFeetFromBottom = prevFeet;
  if (dockPlacement === "below") {
    // Only real bar height under feet — not window slack (see main DOCK_BELOW_CHROME).
    const estChrome = dockStatsOpen ? 244 : 94;
    feetOpts.feetFromBottom = (prevFeet ?? 20) + estChrome;
  } else if (prevFeet != null) {
    // Dock above: feet stay at the bottom of the stack.
    feetOpts.feetFromBottom = prevFeet;
  }

  // Resize first (dock still closed) so the bar does not flash in a tiny window.
  await syncWindowChrome(feetOpts);
  dock.classList.remove("closed");
  applyDockPlacementClass();
  // Pixel-snap after flex layout — fixes any residual below-dock jump.
  await correctPetFeetScreenY(feetY);
  applyMouseIgnore(false);
  updateDockWanderText();
  updateDockStatsPanel();
}

/**
 * Toggle secondary stats submenu (affinity / interactions / period).
 * @param {boolean} [show]
 * @returns {Promise<void>}
 */
async function toggleDockStats(show = !dockStatsOpen) {
  if (!dockOpen && show) {
    // Ensure primary dock is visible first (await side + resize).
    await toggleDock(true);
  }
  const willShow = Boolean(show) && dockOpen;
  if (willShow === dockStatsOpen) {
    updateDockStatsPanel();
    return;
  }

  const feetY = await measurePetFeetScreenY();
  const prevFeet = measureFeetFromBottomClient();
  dockStatsOpen = willShow;

  /** @type {{ prevFeetFromBottom?: number, feetFromBottom?: number }} */
  const feetOpts = {};
  if (prevFeet != null) feetOpts.prevFeetFromBottom = prevFeet;
  if (dockPlacement === "below") {
    const estChrome = dockStatsOpen ? 244 : 94;
    // Swap under-feet chrome: remove old estimate, add new (prevFeet already includes old bar).
    const oldChrome = dockStatsOpen ? 94 : 244;
    feetOpts.feetFromBottom = (prevFeet ?? 20) - oldChrome + estChrome;
    if (feetOpts.feetFromBottom < 20) feetOpts.feetFromBottom = 20 + estChrome;
  } else if (prevFeet != null) {
    feetOpts.feetFromBottom = prevFeet;
  }

  // dock ↔ dockStats always resizes; clear skip keys.
  windowChromeMode = "";
  lastChromePlacement = "";
  await syncWindowChrome(feetOpts);
  updateDockStatsPanel();
  await correctPetFeetScreenY(feetY);
  if (dockStatsOpen) updateAffinityDom();
  applyMouseIgnore(false);
}

function updateDockStatsPanel() {
  const panel = document.querySelector("#dock-stats");
  const toggleBtn = document.querySelector("#dock-stats-toggle");
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
  const toggleBtn = document.querySelector("#dock-wander-toggle");
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

async function handleDockAction(action) {
  switch (action) {
    case "stats":
      await toggleDockStats(!dockStatsOpen);
      break;
    case "stats-close":
      await toggleDockStats(false);
      break;
    case "talk":
      say(Math.random() < 0.45 ? timeBucket() : "talk", { affinityGain: 1 });
      break;
    case "praise":
      say("praise", { affinityGain: 2 });
      spawnParticles(70, 90, "💖");
      break;
    case "walk": {
      // User-initiated: force walk even if auto-roam is off or she was sleeping.
      const before = state.affinity;
      state = gainAffinity(state, 1);
      delete state._affinityGained;
      currentScene = "talk";
      currentLine = "要在桌面上走走吗？好的~";
      openBubble(4000);
      updateBubbleDom();
      if (state.affinity > before && state.affinity % 20 === 0) {
        const extra = speak("affinityUp", { affinity: state.affinity });
        currentLine = `${currentLine}\n${extra.text}`;
        updateBubbleDom();
      }
      persist();
      updateAffinityDom();
      const ok = await wander.planWalk({ force: true });
      if (!ok) {
        currentLine = "等我一下，现在好像走不开…再试一次好吗？";
        openBubble(3500);
        updateBubbleDom();
      }
      break;
    }
    case "hop": {
      // Multi-action hop variants (hop → smile / bounce → hop …)
      motion.lockFor(2800);
      motion.playBehavior("menuHop", { force: true });
      spawnParticles(70, 90, "✨");
      break;
    }
    case "sit": {
      // lock → affinity/line → multi-action rest chain (stretch→sit etc.)
      motion.lockFor(6000);
      const before = state.affinity;
      state = gainAffinity(state, 1);
      delete state._affinityGained;
      const line = speak("menuSit", { affinity: state.affinity });
      currentScene = "talk";
      currentLine = line.text;
      if (state.affinity > before && state.affinity % 20 === 0) {
        const extra = speak("affinityUp", { affinity: state.affinity });
        currentLine = `${currentLine}\n${extra.text}`;
      }
      openBubble(5000);
      updateBubbleDom();
      updateAffinityDom();
      persist();
      motion.playBehavior("menuSit", { force: true, holdMs: 6000 });
      break;
    }
    case "toggle-wander":
      autoWanderEnabled = !autoWanderEnabled;
      if (autoWanderEnabled) {
        wander.start();
        currentScene = "talk";
        currentLine = "嗯，漫游开启啦！我会偶尔在桌面上走走。";
        openBubble(4000);
        updateBubbleDom();
      } else {
        wander.stop();
        currentScene = "talk";
        currentLine = "漫游关闭了。我就站在这里陪着你。";
        openBubble(4000);
        updateBubbleDom();
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

// ---------- render ----------
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
  // Primary dock: actions only. Affinity lives in a secondary submenu (星轨).
  const placementClass = !dockOpen
    ? ""
    : dockPlacement === "above"
      ? "dock-placement-above"
      : "dock-placement-below";
  return `
    <div class="shell art-body shell-minimal shell-with-bubble${placementClass ? ` ${placementClass}` : ""}">
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
        </div>

        <div class="dock-actions" role="group" aria-label="快捷操作">
          <div class="dock-row" role="group" aria-label="互动与动作">
            <button class="dock-btn primary" data-dock-action="talk" type="button" title="聊聊天">
              <span class="ico" aria-hidden="true">💬</span>
              <span class="lbl">聊聊</span>
            </button>
            <button class="dock-btn" data-dock-action="praise" type="button" title="夸夸沙夜">
              <span class="ico" aria-hidden="true">✨</span>
              <span class="lbl">夸奖</span>
            </button>
            <button class="dock-btn" data-dock-action="walk" type="button" title="散步走走">
              <span class="ico" aria-hidden="true">🚶</span>
              <span class="lbl">散步</span>
            </button>
            <button class="dock-btn" data-dock-action="hop" type="button" title="开心小跳">
              <span class="ico" aria-hidden="true">🦘</span>
              <span class="lbl">小跳</span>
            </button>
          </div>
          <div class="dock-row" role="group" aria-label="休息与状态">
            <button class="dock-btn" data-dock-action="sit" type="button" title="坐下休息">
              <span class="ico" aria-hidden="true">🪑</span>
              <span class="lbl">坐下</span>
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
  const count = 14;
  for (let i = 0; i < count; i++) {
    const s = document.createElement("span");
    s.className = "star";
    s.style.left = `${8 + Math.random() * 84}%`;
    s.style.top = `${6 + Math.random() * 70}%`;
    s.style.setProperty("--dur", `${2.4 + Math.random() * 3}s`);
    s.style.setProperty("--delay", `${Math.random() * 2}s`);
    host.appendChild(s);
  }
}

function bind() {
  const pet = document.querySelector("#pet-hit");
  const bubble = document.querySelector("#bubble");
  const dock = document.querySelector("#pet-dock");

  if (bubble) {
    bubble.addEventListener("click", (e) => {
      if (!bubbleOpen) return;
      e.stopPropagation();
      say(Math.random() < 0.5 ? timeBucket() : "talk", { affinityGain: 1 });
    });
  }

  if (dock) {
    dock.addEventListener("pointerdown", (e) => {
      e.stopPropagation();
    });

    dock.addEventListener("pointerup", (e) => {
      e.stopPropagation();
    });

    dock.addEventListener("click", async (e) => {
      const btn = e.target.closest("[data-dock-action]");
      if (!btn) return;
      e.stopPropagation();
      const act = btn.getAttribute("data-dock-action");
      // Keep dock open for multi-actions; hide still closes via window hide.
      if (act === "hide") toggleDock(false);
      await handleDockAction(act);
    });
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
      // Hold solid hit-testing across rapid multi-clicks / post-drag settle.
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
                // Re-arm: async settle may outlast the first sticky window.
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

      // Click (no real drag): default unpause/resume path (usually never paused).
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
      // Solid hit immediately — never let a follow-up click race into passthrough.
      pointerArmed = true;
      armStickyHit();
      applyMouseIgnore(false);
      // Drag / click on body closes the shortcut bar so it does not steal space.
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
      // Right-click toggles the bottom shortcut dock (replaces old context menu).
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
      spawnParticles(event.clientX - rect.left, event.clientY - rect.top, Math.random() < 0.5 ? "💖" : "✨");
    });
  }

  motion.attach(pet, {
    artChange: (art) => {
      if (isDragging) return;
      setArtStyle(art);
    },
    actionChange: (actionId, meta) => {
      wander.onAction(actionId, meta);
    },
  });

  paintStars();
  refreshMouseIgnore();
}

/** Forwarded mousemove while click-through is active — re-hit-test interactive surfaces. */
document.addEventListener(
  "pointermove",
  (e) => {
    notePointerClient(e.clientX, e.clientY);
    if (isDragging || pointerArmed) return;
    refreshMouseIgnore(e.clientX, e.clientY);
  },
  { passive: true, capture: true },
);

document.addEventListener("pointerleave", () => {
  if (isDragging || pointerArmed || dockOpen) return;
  // Drop the sample so post-sticky refresh does not keep a stale "over pet" hit.
  lastPointerClientX = null;
  lastPointerClientY = null;
  if (Date.now() < stickyHitUntil) {
    // Stay solid through the multi-click burst; timer will open passthrough after.
    return;
  }
  applyMouseIgnore(true);
});

document.addEventListener("click", (e) => {
  if (!dockOpen) return;
  if (e.target.closest("#pet-dock") || e.target.closest("#pet-hit")) return;
  toggleDock(false, { clientX: e.clientX, clientY: e.clientY });
});

function paint() {
  motion.detach();
  if (UI_MINIMAL && !dockOpen) state.mode = "compact";
  const cssMode = dockOpen ? "dock" : state.mode === "dock" ? "dock" : "compact";
  app.classList.remove("mode-compact", "mode-dock", "mode-panel");
  app.classList.add(`mode-${cssMode}`);
  app.innerHTML = shellHtml();
  bind();
  updateDockWanderText();
  updateDockStatsPanel();
  updateAffinityDom();
}

// ---------- boot ----------
function boot() {
  state.mode = "compact";
  bubbleOpen = false;
  app.classList.add("mode-compact");

  const greetingScene = timeBucket();
  const line = speak(Math.random() < 0.5 ? "boot" : greetingScene, {
    affinity: state.affinity,
  });
  currentScene = line.scene;
  currentLine = line.text;
  state.artStyle = "body";
  openBubble(10000);
  persist();
  zoneTracker.start();
  paint();
  motion.playScene(currentScene);
  wander.start();
  // openBubble already requested speak size; force-assert after first paint.
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
        app.classList.remove("mode-compact", "mode-dock", "mode-panel");
        app.classList.add("mode-dock");
        applyDockPlacementClass();
        updateDockStatsPanel();
      } else if (mode === "compact" && dockOpen) {
        // Main/tray forced compact — collapse dock chrome in renderer too.
        dockOpen = false;
        dockStatsOpen = false;
        lastChromePlacement = "";
        document.querySelector("#pet-dock")?.classList.add("closed");
        app.classList.remove("mode-compact", "mode-dock", "mode-panel");
        app.classList.add("mode-compact");
        applyDockPlacementClass();
        updateDockStatsPanel();
      }
      return;
    }
    if (UI_MINIMAL) {
      setMode("compact", { repaint: false });
      return;
    }
    state.mode = mode;
    paint();
  });
}

window.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
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
  }
});

boot();
