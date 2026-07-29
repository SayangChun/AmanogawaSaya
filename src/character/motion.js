/**
 * 桌宠动作系统（VPet 风格）：帧动画序列切换 + 脚底锚点轻微补间
 *
 * 每个动作对应一组 PNG 帧（assets/animations/<action>/NN.png），
 * 按 fps 轮换显示；非循环动作结束后回 idle / sleep。
 */

import { CHARACTER } from "./profile.js";
import { ANIM_MANIFEST } from "./anim-manifest.js";

/** @typedef {string} ActionId */

/**
 * @typedef {{
 *   frames: string[],
 *   fps: number,
 *   loop?: boolean,
 *   duration: number|null,
 *   holdLast?: boolean,
 *   css?: string,
 * }} ActionDef
 */

/** @type {Record<ActionId, ActionDef>} */
export const ACTIONS = (() => {
  /** @type {Record<ActionId, ActionDef>} */
  const map = {};
  const src = ANIM_MANIFEST.actions || {};
  for (const [id, def] of Object.entries(src)) {
    map[id] = {
      frames: def.frames || [],
      fps: Number(def.fps) || 4,
      loop: Boolean(def.loop),
      duration: def.duration == null ? null : Number(def.duration),
      holdLast: Boolean(def.holdLast),
      css: `act-${id}`,
    };
  }
  // ensure idle always exists
  if (!map.idle) {
    map.idle = {
      frames: [CHARACTER.bodies.default],
      fps: 1,
      loop: true,
      duration: null,
      holdLast: false,
      css: "act-idle",
    };
  }
  return map;
})();

/** 闲置时随机切换的小动作 */
const IDLE_POOL = [
  "sway",
  "look",
  "smile",
  "nod",
  "calm",
  "soft",
  "breathe",
  "wave",
  "stretch",
  "sit",
];

const SCENE_ACTION = {
  boot: "wave",
  morning: "soft",
  noon: "calm",
  afternoon: "idle",
  evening: "coat",
  night: "sleep",
  lateNight: "sleep",
  tap: "bounce",
  talk: "talk",
  praise: "shy",
  hide: "nod",
  affinityUp: "celebrate",
};

export function actionForScene(scene) {
  return SCENE_ACTION[scene] || "talk";
}

export function bodyUrl(key) {
  const bodies = CHARACTER.bodies;
  return bodies[key] || bodies.default;
}

/** @deprecated */
export function faceUrl(key) {
  return bodyUrl(key === "idle" ? "default" : key);
}

/** @deprecated */
export function portraitUrl(key) {
  return bodyUrl(key === "calm" || key === "idle" ? "default" : key);
}

export function createMotionController() {
  /** @type {HTMLElement|null} */
  let root = null;
  /** @type {HTMLImageElement|null} */
  let layerA = null;
  /** @type {HTMLImageElement|null} */
  let layerB = null;
  /** @type {HTMLElement|null} */
  let actor = null;

  let currentAction = "idle";
  /**
   * Screen facing. Sprites are drawn facing left by default;
   * CSS flips only when facing === "right".
   * @type {"left" | "right"}
   */
  let facing = "left";
  let frontIsA = true;
  let actionTimer = null;
  let idleTimer = null;
  let frameTimer = null;
  let lockedUntil = 0;
  let enabled = true;
  let paused = false;
  let savedBeforePause = "idle";
  /** @type {(art: string) => void} */
  let onArtChange = () => {};
  /** @type {(actionId: string, meta: { fromIdle?: boolean, holdMs?: number|null }) => void} */
  let onActionChange = () => {};

  /** frame playback state */
  let frameIndex = 0;
  /** @type {string[]} */
  let frameList = [];
  let frameLoop = true;
  let holdLast = false;
  let frameIntervalMs = 250;
  let playingToken = 0;
  /** Invalidates in-flight image load handlers so stale swaps cannot double-show layers. */
  let swapToken = 0;

  function clearActionTimer() {
    if (actionTimer) {
      clearTimeout(actionTimer);
      actionTimer = null;
    }
  }

  function clearIdleTimer() {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
  }

  function clearFrameTimer() {
    if (frameTimer) {
      clearTimeout(frameTimer);
      frameTimer = null;
    }
  }

  function scheduleIdle() {
    clearIdleTimer();
    if (!enabled) return;
    const wait = 4000 + Math.random() * 6000;
    idleTimer = setTimeout(() => {
      if (!enabled || paused || Date.now() < lockedUntil) {
        scheduleIdle();
        return;
      }
      if (currentAction === "sleep") {
        play(Math.random() < 0.35 ? "breathe" : "sleep", { fromIdle: true });
        return;
      }
      if (currentAction === "drag") {
        scheduleIdle();
        return;
      }
      const pick = IDLE_POOL[Math.floor(Math.random() * IDLE_POOL.length)];
      play(pick, { fromIdle: true });
    }, wait);
  }

  function applyCss(actionId) {
    if (!actor) return;
    const def = ACTIONS[actionId] || ACTIONS.idle;
    for (const cls of [...actor.classList]) {
      if (cls.startsWith("act-")) actor.classList.remove(cls);
    }
    actor.classList.add(def.css || `act-${actionId}`);
    actor.dataset.action = actionId;
    applyFacingClass();
  }

  function applyFacingClass() {
    if (!actor) return;
    actor.classList.toggle("facing-left", facing === "left");
    actor.classList.toggle("facing-right", facing === "right");
    actor.dataset.facing = facing;
  }

  /**
   * Face left or right (sprite flip). Used by wander locomotion.
   * @param {"left" | "right" | number} dir  negative dx → left
   */
  function setFacing(dir) {
    if (typeof dir === "number") {
      if (dir === 0) return;
      facing = dir < 0 ? "left" : "right";
    } else if (dir === "left" || dir === "right") {
      facing = dir;
    } else {
      return;
    }
    applyFacingClass();
  }

  function getFacing() {
    return facing;
  }

  function resolveUrl(url) {
    try {
      return new URL(url, window.location.href).href;
    } catch {
      return url;
    }
  }

  /**
   * Atomic hard-cut frame swap (no opacity crossfade).
   * Crossfading two pink-outlined sprites stacked as a bright pink flash on
   * transparent Electron windows — always show exactly one layer.
   */
  function showFrame(url) {
    if (!layerA || !layerB) return;
    const front = frontIsA ? layerA : layerB;
    const back = frontIsA ? layerB : layerA;
    const abs = resolveUrl(url);

    if (front.src === abs && front.classList.contains("is-visible")) return;

    const token = ++swapToken;

    const commit = () => {
      if (token !== swapToken || !layerA || !layerB) return;
      // Hard cut: hide current first, then show prepared layer.
      // Never leave two pink-outlined sprites composited together.
      front.classList.remove("is-visible");
      back.classList.add("is-visible");
      frontIsA = !frontIsA;
    };

    if (back.src === abs && back.complete && back.naturalWidth > 0) {
      commit();
      return;
    }

    const onLoad = () => {
      back.removeEventListener("load", onLoad);
      back.removeEventListener("error", onError);
      if (token !== swapToken) return;
      commit();
    };
    const onError = () => {
      back.removeEventListener("load", onLoad);
      back.removeEventListener("error", onError);
    };
    back.addEventListener("load", onLoad);
    back.addEventListener("error", onError);
    back.src = url;
    // Cached decode may already be complete after setting src
    if (back.complete && back.naturalWidth > 0) onLoad();
  }

  function tickFrames(token) {
    if (token !== playingToken || !enabled) return;
    if (!frameList.length) return;

    showFrame(frameList[frameIndex]);

    const last = frameIndex >= frameList.length - 1;
    if (last) {
      if (frameLoop) {
        frameIndex = 0;
      } else if (holdLast) {
        // freeze on last frame until action timer ends
        return;
      } else {
        // one-shot finished frames — wait for duration timer to reset action
        return;
      }
    } else {
      frameIndex += 1;
    }

    frameTimer = setTimeout(() => tickFrames(token), frameIntervalMs);
  }

  function startFramePlayback(def) {
    clearFrameTimer();
    playingToken += 1;
    const token = playingToken;

    frameList = Array.isArray(def.frames) && def.frames.length
      ? def.frames
      : [bodyUrl("default")];
    frameLoop = Boolean(def.loop);
    holdLast = Boolean(def.holdLast);
    frameIndex = 0;
    const fps = Math.max(0.5, Number(def.fps) || 4);
    frameIntervalMs = Math.round(1000 / fps);

    // paint first frame immediately
    showFrame(frameList[0]);

    if (frameList.length <= 1) {
      return;
    }

    frameTimer = setTimeout(() => {
      frameIndex = 1 % frameList.length;
      tickFrames(token);
    }, frameIntervalMs);
  }

  function setPaused(value) {
    const next = Boolean(value);
    if (next === paused) return;
    paused = next;
    if (paused) {
      savedBeforePause = currentAction === "drag" ? savedBeforePause : currentAction;
      clearIdleTimer();
      play("drag", { force: true });
    } else {
      const resume = savedBeforePause === "drag" ? "idle" : savedBeforePause || "idle";
      play(resume, { force: true, fromIdle: true });
      scheduleIdle();
    }
  }

  /**
   * @param {ActionId} actionId
   * @param {{ force?: boolean, fromIdle?: boolean, holdMs?: number }} [opts]
   */
  function play(actionId, opts = {}) {
    if (!actor) return;
    if (paused && opts.fromIdle && actionId !== "drag") {
      scheduleIdle();
      return;
    }
    const def = ACTIONS[actionId] || ACTIONS.idle;
    const now = Date.now();

    if (!opts.force && opts.fromIdle && now < lockedUntil) {
      scheduleIdle();
      return;
    }

    currentAction = actionId;
    applyCss(actionId);
    startFramePlayback(def);
    onArtChange("body");

    clearActionTimer();
    // Always drop a pending idle-pool tick; re-schedule below when appropriate.
    // Otherwise a stale timer can cancel walk/hop mid-locomotion.
    clearIdleTimer();
    const hold = opts.holdMs ?? def.duration;
    // Timed actions (including looping clips like walk): hold then fall back to idle/sleep.
    if (hold && hold > 0) {
      lockedUntil = now + hold;
      const played = actionId;
      actionTimer = setTimeout(() => {
        if (currentAction !== played) {
          scheduleIdle();
          return;
        }
        const ctx = actor?.dataset.context;
        const fallback = ctx === "sleep" ? "sleep" : "idle";
        play(fallback, { force: true, fromIdle: true });
      }, hold);
    } else if (def.loop) {
      // Endless loop (idle / sleep) — idle pool may swap later.
      lockedUntil = 0;
      scheduleIdle();
    } else {
      lockedUntil = now + 800;
      scheduleIdle();
    }

    try {
      onActionChange(actionId, {
        fromIdle: Boolean(opts.fromIdle),
        holdMs: hold ?? null,
      });
    } catch {
      // ignore listener errors
    }
  }

  function setContext(ctx) {
    if (actor) actor.dataset.context = ctx || "";
  }

  function preloadAll() {
    const seen = new Set();
    for (const def of Object.values(ACTIONS)) {
      for (const url of def.frames || []) {
        if (seen.has(url)) continue;
        seen.add(url);
        const img = new Image();
        img.src = url;
      }
    }
    for (const key of Object.keys(CHARACTER.bodies)) {
      const url = bodyUrl(key);
      if (seen.has(url)) continue;
      seen.add(url);
      const img = new Image();
      img.src = url;
    }
  }

  function attach(petHitEl, { artChange, actionChange } = {}) {
    root = petHitEl;
    actor = petHitEl?.querySelector("#pet-actor");
    layerA = petHitEl?.querySelector("#pet-layer-a");
    layerB = petHitEl?.querySelector("#pet-layer-b");
    if (typeof artChange === "function") onArtChange = artChange;
    if (typeof actionChange === "function") onActionChange = actionChange;

    if (!actor || !layerA || !layerB) return;

    preloadAll();

    const def = ACTIONS[currentAction] || ACTIONS.idle;
    const first = (def.frames && def.frames[0]) || bodyUrl("default");
    layerA.src = first;
    layerA.classList.add("is-visible");
    layerB.classList.remove("is-visible");
    frontIsA = true;
    applyCss(currentAction);
    enabled = true;
    paused = false;
    startFramePlayback(def);
    scheduleIdle();
  }

  function detach() {
    enabled = false;
    clearActionTimer();
    clearIdleTimer();
    clearFrameTimer();
    playingToken += 1;
    root = null;
    actor = null;
    layerA = null;
    layerB = null;
    onActionChange = () => {};
  }

  /** Soft lock window so idle pool won't interrupt (e.g. during roam). */
  function lockFor(ms) {
    const until = Date.now() + Math.max(0, Number(ms) || 0);
    if (until > lockedUntil) lockedUntil = until;
  }

  function isPaused() {
    return paused;
  }

  function isEnabled() {
    return enabled;
  }

  function playScene(scene, extra = {}) {
    const action = actionForScene(scene);
    if (action === "sleep") setContext("sleep");
    else setContext("");
    play(action, { force: true, ...extra });
  }

  function getAction() {
    return currentAction;
  }

  return {
    attach,
    detach,
    play,
    playScene,
    setContext,
    setPaused,
    setFacing,
    getFacing,
    getAction,
    scheduleIdle,
    lockFor,
    isPaused,
    isEnabled,
  };
}
