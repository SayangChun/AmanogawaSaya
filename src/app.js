import { CHARACTER, getAffinityRank } from "./character/profile.js";
import { speak, timeBucket } from "./character/dialogue.js";
import { createMotionController } from "./character/motion.js";
import { createWanderController } from "./character/wander.js";
import {
  createZoneTracker,
  isZonePosesEnabled,
} from "./character/screen-zone.js";
import { loadState, saveState, gainAffinity, setUserName } from "./state.js";
import { createChatPanel, createTypewriter } from "./ui/chat-panel.js";
import { createLocalEngine } from "./engine/local-engine.js";
import { createStreamPresence } from "./character/stream-presence.js";
import { improvFidget } from "./character/motion-improv.js";
import { createMoodEngine } from "./character/mood.js";

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
/** 伴侣聊天面板打开（chat 窗口模式：输入行在脚下，feet 上移） */
let chatOpen = false;
/** chat 模式里脚底到窗口底部的距离（给输入行留位） */
const CHAT_FEET_PAD = 64;
/** 本地记忆快照（主进程 memory-store 的缓存镜像） */
/** @type {{ events: any[], facts: any[], followUps: any[], mood: any, meta: any } | null} */
let memory = null;
/** 本地对话引擎（离线，纯规则 + 记忆注入） */
const localEngine = createLocalEngine();
/** 主动性状态：久别只提醒一次 / 时段切换 / 冷却 */
let absenceNotified = false;
let lastBucket = null;
let lastProactiveAt = 0;
const PROACTIVE_TICK_MS = 45_000;
const PROACTIVE_COOLDOWN_MS = 8 * 60_000;
/** chat 面板（输入/历史）+ 气泡打字机 */
let chatPanel = null;
let typewriter = null;
/** 久别重逢判定阈值（ms） */
const MISS_YOU_MS = 6 * 60 * 60 * 1000;
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

/** —— 直播感：指针在她身上的状态（hover / 注视） —— */
/** 指针当前是否位于 pet 身体矩形内 */
let hoverOnPet = false;
/** 指针开始静止的时刻（ms；移动会重置） */
let hoverStillSince = 0;
/** 指针上一帧坐标（静止判定） */
let hoverLastX = 0;
let hoverLastY = 0;
/** 本轮 hover 是否已触发过轻反应（离开后重置） */
let hoverNotified = false;
/** 连戳计数（时间戳窗口） */
let pokeTimes = [];
/** 直播感引擎 */
let streamPresence = null;

/**
 * 情绪引擎：五维情绪持续演化，直接决定动作合成权重。
 * 事件脉冲即时生效，空闲时向时段/亲密度基线回归 + 随机游走。
 */
const moodEngine = createMoodEngine({
  getState: () => state,
  timeBucket,
});

/** 事件脉冲入口：先推进时间（回归+游走），再叠加事件 */
function pulseMood(event, opts) {
  try {
    moodEngine.tick();
    moodEngine.pulse(event, opts);
  } catch {
    /* 情绪波动失败不影响互动 */
  }
}

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
  chatPanel: /** @type {HTMLElement|null} */ (null),
  chatInput: /** @type {HTMLInputElement|null} */ (null),
  chatScroll: /** @type {HTMLElement|null} */ (null),
  chatDockToggle: /** @type {HTMLElement|null} */ (null),
  factsList: /** @type {HTMLElement|null} */ (null),
  factsEmpty: /** @type {HTMLElement|null} */ (null),
  factsCount: /** @type {HTMLElement|null} */ (null),
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
  dom.chatPanel = document.querySelector("#chat-panel");
  dom.chatInput = document.querySelector("#chat-input");
  dom.chatScroll = document.querySelector("#chat-scroll");
  dom.chatDockToggle = document.querySelector("#dock-chat-toggle");
  dom.factsList = document.querySelector("#facts-list");
  dom.factsEmpty = document.querySelector("#facts-empty");
  dom.factsCount = document.querySelector("#facts-count");
}

const zoneTracker = createZoneTracker({
  getBounds: () => window.petApi?.bounds?.() ?? Promise.resolve(null),
  getWorkArea: () => window.petApi?.workArea?.() ?? Promise.resolve(null),
  enabled: () => isZonePosesEnabled(),
});

const motion = createMotionController({
  getZoneSnapshot: (opts) => zoneTracker.getSnapshot(opts),
  getLastZoneId: () => zoneTracker.getZoneId(),
  // 情绪快照：动作合成的核心权重来源
  getMood: () => moodEngine.snapshot(),
  onZoneSit: (_zoneId) => {
    if (bubbleOpen || Math.random() >= 0.15) return;
    const line = speakState("zoneSit");
    currentLine = line.text;
    openBubble(3500);
    updateBubbleDom();
  },
  // 闲置微动作走即兴合成（带情绪语境，每次链都现场生成）
  improvFidget: (ctx) =>
    improvFidget({
      ...ctx,
      mood: moodEngine.snapshot(),
    }),
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
 * 直播感显示出口：气泡逐字 + 即兴动作链（不打断漫游锁）。
 * 与 proactiveSay 分工：这里只负责「碎碎念层」，轻且密。
 */
function showStreamLine(text, opts = {}) {
  if (!text) return;
  if (chatOpen || dockOpen || isDragging || pointerArmed) return;
  currentScene = opts.scene || "chatter";
  currentLine = text;
  openBubble(opts.bubbleMs || 7000);
  updateBubbleDom({ typing: true });
  typewriter?.start(text);
  if (Array.isArray(opts.chain) && opts.chain.length) {
    // 非 force：漫游 / 场景锁活跃时动作自动让位，话照说
    motion.playChain(opts.chain, { fromIdle: true, force: false });
  } else {
    motion.playBehavior("ponder", { force: true });
  }
  persist();
}

/** 指针是否在 pet 身体矩形内 */
function pointerInPetRect(x, y) {
  const pet = dom.petHit || document.querySelector("#pet-hit");
  if (!pet || typeof x !== "number" || typeof y !== "number") return false;
  const r = pet.getBoundingClientRect();
  return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
}

streamPresence = createStreamPresence({
  getState: () => ({ affinity: state.affinity, userName: state.userName }),
  getFacts: () => (memory?.facts || []).filter((f) => f && f.confirmed !== false),
  isBusy: () =>
    Boolean(
      isDragging ||
        pointerArmed ||
        dockOpen ||
        chatOpen ||
        bubbleOpen ||
        typewriter?.isActive?.(),
    ),
  speakScene: (scene, vars) => speakState(scene, { vars }).text,
  showLine: (text, opts) => showStreamLine(text, opts),
  timeBucket,
  getZoneId: () => zoneTracker.getZoneId(),
  getMood: () => moodEngine.snapshot(),
  pulseMood: (event, opts) => pulseMood(event, opts),
  pointerOnPet: () => ({
    onPet: hoverOnPet && !isDragging && !pointerArmed,
    stillMs: hoverStillSince ? Date.now() - hoverStillSince : 0,
  }),
  idleSeconds: () => window.petApi?.idleSeconds?.() ?? Promise.resolve(null),
  appendEvent: (ev) => void memAppendEvent(ev),
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
  if (chatOpen && el.closest("#chat-panel")) return true;
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

  if (isDragging || pointerArmed || dockOpen || chatOpen || Date.now() < stickyHitUntil) {
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
 * @param {number} [needOverride] px of room required on the chosen side
 * @returns {Promise<"left" | "right">}
 */
async function chooseDockPlacement(needOverride) {
  try {
    const [bounds, work] = await Promise.all([
      window.petApi?.bounds?.() ?? Promise.resolve(null),
      window.petApi?.workArea?.() ?? Promise.resolve(null),
    ]);
    if (!bounds || !work) return "right";

    const need =
      typeof needOverride === "number" && Number.isFinite(needOverride)
        ? needOverride
        : dockStatsOpen
          ? 230
          : 80;
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
  /** @type {"compact" | "speak" | "dock" | "dockStats" | "chat"} */
  let next = "compact";
  if (chatOpen) next = "chat";
  else if (dockOpen && dockStatsOpen) next = "dockStats";
  else if (dockOpen) next = "dock";
  else if (bubbleOpen) next = "speak";

  const cssMode = chatOpen ? "chat" : dockOpen ? "dock" : "compact";
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
  // 记忆层镜像亲密度（主进程 mood.json）
  void window.petApi?.memory?.updateMood?.({ affinity: state.affinity });
}

/**
 * 从主进程加载记忆；旧版 localStorage 状态一次性迁移；
 * 记忆里的亲密度高于本地 state 时（换机/清过缓存）记忆优先。
 */
async function loadMemory() {
  try {
    const res = await window.petApi?.memory?.getState?.();
    if (!res?.ok || !res.snapshot) return;
    memory = {
      events: res.snapshot.events || [],
      facts: res.snapshot.facts || [],
      followUps: res.snapshot.followUps || [],
      mood: res.snapshot.mood || {},
      meta: res.snapshot.meta || {},
    };
    // 旧版迁移（只跑一次，主进程有 guarded）
    let legacy = null;
    try {
      legacy = JSON.parse(localStorage.getItem("amanogawa.saya.pet.v3") || "null");
    } catch {
      legacy = null;
    }
    if (!memory.meta.legacyImported && legacy) {
      try {
        const m = await window.petApi?.memory?.migrateLegacy?.({
          affinity: legacy.affinity,
          userName: legacy.userName,
          totalInteractions: legacy.totalInteractions,
        });
        if (m?.ok && m.result?.ok) memory.meta.legacyImported = true;
      } catch {
        /* migration is best-effort */
      }
    }
    // 记忆亲密度优先（她确实记得你，只是本地缓存丢了）
    const memAffinity = Number(memory.mood?.affinity);
    if (Number.isFinite(memAffinity) && memAffinity > state.affinity) {
      state.affinity = memAffinity;
    }
  } catch {
    /* memory unavailable — chat degrades to stateless */
  }
}

/**
 * 启动问候优先级：到期约定 > 久别重逢 > 常规时段问候。
 * @returns {{ scene: string, line: { text: string } }}
 */
function bootGreeting() {
  const now = Date.now();
  const due = (memory?.followUps || []).filter((f) => f && !f.done && Number(f.dueAt) <= now);
  if (due.length) {
    const first = due[0];
    void window.petApi?.memory?.completeFollowUp?.(first.id);
    return { scene: "followUp", line: speakState("followUp", { vars: { plan: first.text } }) };
  }
  const last = Number(memory?.mood?.lastInteractionAt) || 0;
  if (last && now - last > MISS_YOU_MS) {
    return { scene: "missYou", line: speakState("missYou") };
  }
  const greetingScene = timeBucket();
  return {
    scene: greetingScene,
    line: speakState(Math.random() < 0.5 ? "boot" : greetingScene),
  };
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

function updateBubbleDom(opts = {}) {
  if (dom.lineText) {
    if (opts.typing) {
      // 打字机模式下先留空，由 createTypewriter 逐字填充
      dom.lineText.textContent = "";
      dom.lineText.classList.add("is-typing");
    } else {
      dom.lineText.innerHTML = escapeHtml(currentLine);
      dom.lineText.classList.remove("is-typing");
    }
  }
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

  // 互动事件 → 情绪脉冲（动作合成的权重随心情变化）
  pulseMood(scene);

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

/** dock「聊天」按钮状态 */
function updateChatBtnDom() {
  const btn = dom.chatDockToggle || document.querySelector("#dock-chat-toggle");
  if (!btn) return;
  btn.classList.toggle("is-on", chatOpen);
  btn.setAttribute("aria-pressed", chatOpen ? "true" : "false");
  btn.title = chatOpen ? "收起聊天" : "打开聊天：打字和她说说话";
  const lbl = btn.querySelector(".lbl");
  if (lbl) lbl.textContent = chatOpen ? "收起" : "聊天";
}

/** 星轨面板：她记得的事实列表（可逐条遗忘） */
function updateFactsDom() {
  const list = dom.factsList || document.querySelector("#facts-list");
  const empty = dom.factsEmpty || document.querySelector("#facts-empty");
  const count = dom.factsCount || document.querySelector("#facts-count");
  const facts = Array.isArray(memory?.facts) ? memory.facts : [];
  if (count) count.textContent = `${facts.length} 条`;
  if (!list) return;
  list.textContent = "";
  if (empty) empty.style.display = facts.length ? "none" : "";
  const recent = facts.slice(0, 6);
  for (const fact of recent) {
    const row = document.createElement("div");
    row.className = "fact-item";
    const text = document.createElement("span");
    text.className = "fact-text";
    text.textContent = fact.text;
    const forget = document.createElement("button");
    forget.type = "button";
    forget.className = "fact-forget";
    forget.textContent = "✕";
    forget.title = "让她忘记这条";
    forget.setAttribute("data-fact-id", fact.id);
    forget.addEventListener("click", async (e) => {
      e.stopPropagation();
      const res = await window.petApi?.memory?.removeFact?.(fact.id);
      if (res?.ok) {
        memory.facts = memory.facts.filter((f) => f.id !== fact.id);
        updateFactsDom();
        spawnParticles(70, 120, "·");
      }
    });
    row.append(text, forget);
    list.appendChild(row);
  }
}

/** 本地记忆镜像的便捷写入（成功后同步缓存，引擎上下文即时保鲜） */
async function memAppendEvent(ev) {
  const res = await window.petApi?.memory?.appendEvent?.(ev);
  if (res?.ok && res.event && memory) {
    memory.events.push(res.event);
    if (memory.events.length > 200) memory.events = memory.events.slice(-200);
  }
}

async function memAddFact(text, opts) {
  const res = await window.petApi?.memory?.addFact?.(text, opts);
  if (res?.ok && res.fact && memory) memory.facts.push(res.fact);
  return res?.fact || null;
}

async function memAddFollowUp(input) {
  const res = await window.petApi?.memory?.addFollowUp?.(input);
  if (res?.ok && res.followUp && memory) memory.followUps.push(res.followUp);
  return res?.followUp || null;
}

/** 打开/收起聊天面板（含窗口模式切换与脚底锚点保持） */
async function toggleChat(show) {
  const willOpen = Boolean(show);
  if (willOpen === chatOpen) return;

  if (willOpen) {
    // dock 与 chat 不并存：先收起 dock（其内部会measure/correct）
    if (dockOpen) await toggleDock(false);
    const feetY = await measurePetFeetScreenY();
    const bodyX = await measurePetBodyScreenCenterX();
    const prevFeet = measureFeetFromBottomClient();
    chatOpen = true;
    updateChatBtnDom();
    await syncWindowChrome({
      prevFeetFromBottom: prevFeet ?? undefined,
      feetFromBottom: CHAT_FEET_PAD,
    });
    // 键盘输入需要窗口焦点
    window.petApi?.focus?.();
    chatPanel?.focus();
    chatPanel?.renderScrollback(recentChatRows());
    await correctPetFeetScreenY(feetY);
    await correctPetBodyScreenX(bodyX);
    applyMouseIgnore(false);
    wander.pause();
    // 她专注听：碎碎念暂停
    streamPresence?.noteChatOpen();
    return;
  }

  // 收起：先measure再缩窗，最后修正，保持她不动
  const feetY = await measurePetFeetScreenY();
  const bodyX = await measurePetBodyScreenCenterX();
  const prevFeet = measureFeetFromBottomClient();
  chatOpen = false;
  typewriter?.stop();
  updateChatBtnDom();
  await syncWindowChrome({
    prevFeetFromBottom: prevFeet ?? undefined,
    feetFromBottom: CHAT_FEET_PAD,
  });
  await correctPetFeetScreenY(feetY);
  await correctPetBodyScreenX(bodyX);
  chatPanel?.blur();
  refreshMouseIgnore(lastPointerClientX, lastPointerClientY);
  wander.resume();
  // 聊天收起：碎碎念恢复
  streamPresence?.noteChatClosed();
}

/** 最近对话（记忆事件流尾部，供回显） */
function recentChatRows(limit = 12) {
  const events = Array.isArray(memory?.events) ? memory.events : [];
  return events.slice(-limit).map((e) => ({ role: e.role, text: e.text }));
}

/** 本地引擎回复（离线，规则匹配 + 记忆注入） */
function generateLocalReply(text) {
  const ctx = {
    userName: state.userName,
    affinity: state.affinity,
    timeBucket: timeBucket(),
    facts: (memory?.facts || []).filter((f) => f && f.confirmed),
    now: Date.now(),
  };
  let reply;
  try {
    reply = localEngine.generateReply(text, ctx);
  } catch {
    reply = null;
  }
  return (
    reply || {
      text: "……风声盖住了。……再说一次好吗？",
      scene: "chatTalk",
      expression: "ponder",
      affinityDelta: 0,
    }
  );
}

/** 应用引擎回复：亲密度 / 名字 / 气泡 / 表情 / 记忆写入 */
function applyReply(reply) {
  if (reply.affinityDelta > 0) {
    const { before, gained } = applyAffinityGain(reply.affinityDelta);
    maybeAppendAffinityMilestone(before, gained);
    updateAffinityDom();
  }
  if (reply.updateUserName) {
    state = setUserName(state, reply.updateUserName);
    updateNameDom();
  }

  currentScene = reply.scene || "chatTalk";
  currentLine = reply.text;
  openBubble(14000);
  typewriter?.start(reply.text);
  updateBubbleDom({ typing: true });
  motion.playBehavior(reply.expression || "ponder", { force: true });
  persist();
  void memAppendEvent({
    role: "saya",
    text: reply.text,
    scene: reply.scene,
    action: reply.expression,
    affinityDelta: reply.affinityDelta || undefined,
  });
}

/**
 * 聊天主流程：用户输入 → 本地引擎（意图分类 + 记忆注入）→ 亲密度/事实/约定 →
 * 逐字回复 → 表情。全离线，不发任何网络请求。
 */
function sendChatText(raw) {
  const text = String(raw || "").trim();
  if (!text || !chatOpen) return;

  chatPanel?.appendRow("user", text);
  void memAppendEvent({ role: "user", text });
  absenceNotified = false;

  applyReply(generateLocalReply(text));
}

/** 「记住这句」：把输入框原文显式存为事实 */
async function rememberChatText(raw) {
  const text = String(raw || "").trim();
  if (!text) return;
  const fact = await memAddFact(text.slice(0, 120), { source: "manual", confirmed: true });
  if (!fact) return;
  updateFactsDom();
  currentScene = "factSaved";
  currentLine = speakState("factSaved").text;
  openBubble(5000);
  updateBubbleDom();
  motion.playBehavior("nod", { force: true });
  spawnParticles(70, 90, "💫");
}

/** 她主动开口前的基础条件：冷却期外、不在拖拽中 */
function canProactiveSpeak() {
  return (
    Date.now() - lastProactiveAt >= PROACTIVE_COOLDOWN_MS &&
    !isDragging &&
    !pointerArmed
  );
}

/** 她主动开口：聊天开着就直接接话，平时用气泡逐字说 */
function proactiveSay(text, { scene = "chatTalk", bubbleMs = 9000 } = {}) {
  if (!text) return;
  lastProactiveAt = Date.now();
  currentScene = scene;
  currentLine = text;
  void memAppendEvent({ role: "saya", text, scene, action: "ponder" });
  if (chatOpen) {
    chatPanel?.appendRow("saya", text);
    return;
  }
  if (dockOpen) {
    // 快捷栏开着窗口太窄，30 秒后重试
    lastProactiveAt = Date.now() - PROACTIVE_COOLDOWN_MS + 30_000;
    return;
  }
  openBubble(bubbleMs);
  updateBubbleDom({ typing: true });
  typewriter?.start(text);
  motion.playBehavior("ponder", { force: true });
  persist();
}

/** 主动性队列：到期约定 > 久别重逢 > 时段切换 > 随机想起他说过的事 */
function proactivityTick() {
  const now = Date.now();
  // 1) 到期约定：她替你记着，到点轻轻提一句
  const due = (memory?.followUps || []).filter(
    (f) => f && !f.done && Number(f.dueAt) <= now,
  );
  if (due.length && canProactiveSpeak()) {
    const first = due[0];
    void window.petApi?.memory?.completeFollowUp?.(first.id);
    if (memory) {
      const item = memory.followUps.find((f) => f.id === first.id);
      if (item) item.done = true;
    }
    proactiveSay(speakState("followUp", { vars: { plan: first.text } }).text, {
      scene: "followUp",
    });
    return;
  }
  // 2) 久别重逢（运行期间 >6h 没跟她说话；每次久别只说一次）
  const last = Number(memory?.mood?.lastInteractionAt) || 0;
  if (last && !absenceNotified && now - last > MISS_YOU_MS && canProactiveSpeak()) {
    absenceNotified = true;
    proactiveSay(speakState("missYou").text, { scene: "missYou" });
    return;
  }
  // 3) 时段切换：入夜了、天亮了，她会说一声
  const bucket = timeBucket();
  if (bucket !== lastBucket) {
    if (canProactiveSpeak()) {
      lastBucket = bucket;
      proactiveSay(speakState(bucket).text, { scene: bucket, bubbleMs: 7000 });
      return;
    }
  } else {
    lastBucket = bucket;
  }
  // 4) 随机想起你说过的事（低频，冷却期内不会连发）
  const facts = (memory?.facts || []).filter((f) => f && f.confirmed !== false);
  if (facts.length && Math.random() < 0.07 && canProactiveSpeak()) {
    const fact = facts[Math.floor(Math.random() * facts.length)];
    proactiveSay(speakState("recall", { vars: { fact: fact.text } }).text, {
      scene: "recall",
    });
  }
  // 5) 深夜还在 → 每晚一次的夜猫子关怀
  maybeNightOwl();
}

/**
 * 夜猫子关怀：22:00 之后用户还活跃（近两分钟内有输入），
 * 每个自然晚只提醒一次。
 */
function maybeNightOwl() {
  const bucket = timeBucket();
  if (bucket !== "night" && bucket !== "lateNight") return;
  const idle = streamPresence?.lastIdleSec?.() ?? null;
  if (idle == null || idle > 120) return; // 不在电脑前就不打扰
  const today = new Date().toDateString();
  try {
    if (localStorage.getItem("saya.nightOwlDate") === today) return;
    localStorage.setItem("saya.nightOwlDate", today);
  } catch {
    return; // localStorage 不可用就放弃（避免每晚轰炸）
  }
  if (bubbleOpen || chatOpen || dockOpen) return;
  proactiveSay(speakState("nightOwl").text, { scene: "nightOwl" });
}

function spawnParticles(x, y, symbol = "✨") {  const stage = dom.stage || document.querySelector("#stage");
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

  // chat 与 dock 不并存：开 dock 前先收起 chat
  if (willOpen && chatOpen) await toggleChat(false);

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

  // 星轨面板比快捷栏宽得多：打开前重新评估左右侧，避免窗口被屏幕边缘
  // 挤压后角色跟着跳位（右侧放不下就翻到左边，角色原地不动）。
  if (willShow) {
    dockPlacement = await chooseDockPlacement(230);
    applyDockPlacementClass();
  }
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
    const wasOpen = !panel.classList.contains("closed");
    panel.classList.toggle("closed", !dockStatsOpen);
    panel.setAttribute("aria-hidden", dockStatsOpen ? "false" : "true");
    // 每次展开都从顶部开始，避免上次滚动位置把「星轨信息」标题留在视口外
    if (dockStatsOpen && !wasOpen) panel.scrollTop = 0;
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
    case "chat":
    case "chat-close":
      await toggleChat(!chatOpen);
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

      <div class="chat" id="chat-panel" aria-label="和沙夜聊天">
        <div class="chat-scroll" id="chat-scroll" aria-live="polite"></div>
        <div class="chat-row">
          <input
            type="text"
            id="chat-input"
            class="chat-input"
            maxlength="200"
            placeholder="想跟沙夜说点什么…"
            autocomplete="off"
            spellcheck="false"
            aria-label="输入想对沙夜说的话"
          />
          <button class="chat-btn" id="chat-remember" type="button" title="让沙夜记住这句话">记</button>
          <button class="chat-btn" id="chat-send" type="button" title="说给她听">说</button>
          <button class="chat-btn is-close" id="chat-close" type="button" title="收起聊天">✕</button>
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
          <div class="facts-card" aria-label="沙夜记住的事">
            <div class="name-head">
              <span class="label">她记得的事</span>
              <span class="name-status" id="facts-count">0 条</span>
            </div>
            <div class="facts-list" id="facts-list"></div>
            <p class="facts-empty" id="facts-empty">还没有。聊天时说给她听，她就记住了。</p>
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
            class="dock-btn${chatOpen ? " is-on" : ""}"
            data-dock-action="chat"
            id="dock-chat-toggle"
            type="button"
            aria-pressed="${chatOpen ? "true" : "false"}"
            title="${chatOpen ? "收起聊天" : "打开聊天：打字和她说说话"}"
          >
            <span class="ico" aria-hidden="true">💭</span>
            <span class="lbl">聊天</span>
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
  chatPanel?.bind();
  typewriter = createTypewriter(() => dom.lineText, {
    onDone: () => chatPanel?.appendRow("saya", currentLine),
  });

  if (bubble) {
    bubble.addEventListener("click", (e) => {
      if (!bubbleOpen) return;
      e.stopPropagation();
      // 回复逐字输出中：点击=立即显示全文，不当成新对话
      if (typewriter?.isActive()) {
        typewriter.skip();
        return;
      }
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
      if (act !== "stats" && act !== "stats-close" && act !== "chat" && act !== "chat-close") {
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
      // 拖拽惯性回正
      motion.setDragLean(0);
      pet.classList.remove("is-dragging");
      setDraggingLock(false);

      if (!hadPointer) {
        motion.setPaused?.(false);
        wander.resume();
        return false;
      }

      if (dragged) {
        suppressClickUntil = Date.now() + CLICK_SUPPRESS_MS;
        // 直播感：被拎着跑了很远 → 晕乎乎反应
        if (session && Number(session.pathLen) > 0) {
          streamPresence?.noteDragEnd(Number(session.pathLen));
        }
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
        pathLen: 0,
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

      drag.pathLen = (drag.pathLen || 0) + Math.abs(dx) + Math.abs(dy);
      // 拖拽惯性：瞬时速度 → 身体倾斜（Flow 层平滑趋近，松手回正）
      motion.setDragLean(Math.max(-1, Math.min(1, dx * 0.35)));
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

      // 直播感：短窗口内被连戳 ≥3 次 → 她有意见了
      const pokedAt = Date.now();
      pokeTimes = pokeTimes.filter((t) => pokedAt - t < 2500);
      pokeTimes.push(pokedAt);
      if (pokeTimes.length >= 3) {
        const count = pokeTimes.length;
        pokeTimes = [];
        streamPresence?.notePokeRapid(count);
      }

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
      // 视线跟随：她在窗口内始终微微朝光标方向偏移（拖拽倾斜由 pet 局部分支管）
      motion.setFlowPointer(pointerFlowNorm(e.clientX));
      return;
    }
    trackHover(e.clientX, e.clientY);
    motion.setFlowPointer(pointerFlowNorm(e.clientX));
    scheduleRefreshMouseIgnore(e.clientX, e.clientY);
  },
  { passive: true, capture: true },
);

/**
 * 指针相对她身体中心的归一化方向（-1..1），供 Flow 层视线跟随。
 * @param {number} x
 * @returns {number | null} 窗口过窄测不出时返回 null
 */
function pointerFlowNorm(x) {
  const pet = dom.petHit || document.querySelector("#pet-hit");
  if (!pet || typeof x !== "number") return null;
  const r = pet.getBoundingClientRect();
  const cx = r.left + r.width / 2;
  const span = Math.max(60, r.width * 0.75);
  const nx = (x - cx) / span;
  return Number.isFinite(nx) ? Math.max(-1, Math.min(1, nx)) : null;
}

/**
 * 直播感 hover 跟踪：进入身体 → 轻反应；停在身上不动 → 注视。
 * @param {number} x
 * @param {number} y
 */
function trackHover(x, y) {
  const onPet = pointerInPetRect(x, y);
  if (onPet !== hoverOnPet) {
    hoverOnPet = onPet;
    hoverLastX = x;
    hoverLastY = y;
    if (onPet) {
      hoverStillSince = Date.now();
      if (!hoverNotified) {
        hoverNotified = true;
        streamPresence?.noteHoverEnter();
      }
    } else {
      hoverStillSince = 0;
      hoverNotified = false;
    }
    return;
  }
  if (hoverOnPet) {
    const moved = Math.hypot(x - hoverLastX, y - hoverLastY);
    if (moved > 8) {
      hoverStillSince = Date.now();
      hoverLastX = x;
      hoverLastY = y;
    }
  }
}

document.addEventListener("pointerleave", () => {
  hoverOnPet = false;
  hoverStillSince = 0;
  hoverNotified = false;
  // 光标离开窗口：她的视线缓缓收回（Flow 层平滑归零）
  motion.setFlowPointer(null);
  if (isDragging || pointerArmed || dockOpen || chatOpen) return;
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
  setAppCssMode(chatOpen ? "chat" : dockOpen ? "dock" : "compact");
  app.innerHTML = shellHtml();
  bind();
  updateDockWanderText();
  updateDockStatsPanel();
  updateAffinityDom();
  updateNameDom();
  updateChatBtnDom();
  updateFactsDom();
}

async function boot() {
  state.mode = "compact";
  bubbleOpen = false;
  app.classList.add("mode-compact");

  chatPanel = createChatPanel({
    onSend: (text) => sendChatText(text),
    onRemember: (text) => rememberChatText(text),
    onClose: () => toggleChat(false),
  });

  // 记忆先行：问候语可能依赖约定到期 / 久别重逢
  await loadMemory();

  const greeting = bootGreeting();
  currentScene = greeting.scene;
  currentLine = greeting.line.text;
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

  // 主动性队列（她先开口）
  lastBucket = timeBucket();
  absenceNotified = greeting.scene === "missYou" || greeting.scene === "followUp";
  setInterval(proactivityTick, PROACTIVE_TICK_MS);

  // 直播感引擎：碎碎念 / 注视 / 去留观察（启动后先安静一会儿）
  window.petApi?.onSystemEvent?.((type) => streamPresence?.noteSystemEvent(type));
  streamPresence?.start();

  // 情绪空闲漂移：没有互动时她的心情也在慢慢变化
  setInterval(() => {
    try {
      moodEngine.tick();
    } catch {
      /* 忽略 */
    }
  }, 30_000);
}

window.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  if (chatOpen) {
    toggleChat(false);
    return;
  }
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

// boot 是异步的（先加载记忆）；顶层 await 会阻塞模块执行，这里显式 void
void boot();
