/**
 * 桌宠动作系统（VPet 风格）：帧动画序列切换 + 脚底锚点轻微补间
 *
 * 每个动作对应一组 PNG 帧（assets/animations/<action>/NN.png），
 * 按 fps 轮换显示；非循环动作结束后回 idle / sleep。
 *
 * 行为层（behaviors.js）：一个行为可映射多条加权变体，每条变体为动作链，
 * 链内顺序播放、中间不回 idle，保证流畅衔接。
 */

import { CHARACTER } from "./profile.js";
import { timeBucket } from "./dialogue.js";
import { ANIM_MANIFEST } from "./anim-manifest.js";
import {
  ZONE_CONFIG,
  pickWeightedAction,
  markActionCooldown,
  isLookishAction,
} from "./screen-zone.js";
import {
  getBehavior,
  pickVariant,
  normalizeStep,
  estimateChainMs,
  primaryActionForBehavior,
} from "./behaviors.js";
import {
  improvFidget as defaultImprovFidget,
  improvChain,
  SCENE_BIAS,
} from "./motion-improv.js";

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

/** 闲置微动作（高频小动作：VPet 式「停不下来」的主体） */
const IDLE_MICRO_POOL = [
  "sway",
  "look",
  "smile",
  "nod",
  "calm",
  "soft",
  "breathe",
  "peek",
  "think",
  "giggle",
];

/** 闲置姿态动作（低频：累了才换姿势，交给情绪权重决定） */
const IDLE_POSE_POOL = ["stretch", "sit", "crouch", "lie", "prone", "yawn", "wave"];

/**
 * 非合成路径的单动作选择：微动作为主（~78%），姿态偶尔。
 * @returns {string}
 */
function pickIdleAction() {
  return Math.random() < 0.78
    ? IDLE_MICRO_POOL[Math.floor(Math.random() * IDLE_MICRO_POOL.length)]
    : IDLE_POSE_POOL[Math.floor(Math.random() * IDLE_POSE_POOL.length)];
}

/** 偶发「微序列」概率：连播小动作（走即兴合成） */
const IDLE_FIDGET_CHANCE = 0.72;

/** 兼容旧调用：行为 → 代表动作（首步） */
function actionForScene(scene) {
  return primaryActionForBehavior(scene) || "talk";
}

function bodyUrl(key) {
  const bodies = CHARACTER.bodies;
  return bodies[key] || bodies.default;
}

/**
 * @param {{
 *   getZoneSnapshot?: (opts?: { ensureFresh?: boolean }) =>
 *     | null
 *     | { zoneId?: string, idleWeights?: Record<string, number>, facingHint?: "left"|"right"|null }
 *     | Promise<null | { zoneId?: string, idleWeights?: Record<string, number>, facingHint?: "left"|"right"|null }>,
 *   getLastZoneId?: () => string|null,
 *   onZoneSit?: (zoneId: string|null) => void,
 *   improvFidget?: (ctx: { timeBucket?: string, zoneId?: string|null, affinity?: number }) =>
 *     | (string | { action: string, holdMs?: number|null })[] | null,
 *   getMood?: () => import("./mood.js").MoodVec | { groupBias?: Record<string, number> } | null,
 * }} [deps]
 */
export function createMotionController(deps = {}) {
  const getZoneSnapshot = deps.getZoneSnapshot || null;
  const getLastZoneId = deps.getLastZoneId || null;
  /**
   * 即兴闲置链：优先用外部注入（可带亲密度 / 时段语境），
   * 默认退化为无语境合成。返回 null → 走旧 idleFidget 固定行为。
   */
  const improvFidget =
    typeof deps.improvFidget === "function"
      ? deps.improvFidget
      : (ctx) => defaultImprovFidget({ ...ctx, catalog: ACTIONS });
  /** 情绪快照（app 注入；缺席时合成器按中性情绪处理） */
  const getMood = typeof deps.getMood === "function" ? deps.getMood : () => null;

  /**
   * 情绪驱动合成：所有已知场景不再查固定行为表，
   * 动作链由「情绪 × 场景偏置」现场生成。
   * @param {string} sceneId
   * @param {{ force?: boolean, fromIdle?: boolean, holdMs?: number }} [opts]
   * @returns {number | null} 链估计时长（ms）；null = 未合成（走兜底）
   */
  function trySynthBehavior(sceneId, opts = {}) {
    try {
      const chain = improvChain({
        scene: sceneId,
        timeBucket: timeBucket(),
        zoneId: typeof getLastZoneId === "function" ? getLastZoneId() || undefined : undefined,
        mood: getMood() || undefined,
        catalog: ACTIONS,
      });
      if (!Array.isArray(chain) || !chain.length) return null;

      // 睡眠语境场景进入 sleep context（动作回退到睡眠而非 idle）
      if (sceneId === "night" || sceneId === "lateNight") setContext("sleep");
      else if (!opts.fromIdle) setContext("");

      let steps = chain;
      // 外部 holdMs 覆盖（菜单停留更久等）：应用到末步
      if (opts.holdMs && opts.holdMs > 0 && steps.length) {
        steps = steps.map((s) => (typeof s === "string" ? { action: s } : { ...s }));
        const last = steps[steps.length - 1];
        if (last.holdMs !== null || steps.length === 1) {
          steps[steps.length - 1] = { action: last.action, holdMs: opts.holdMs };
        }
      }

      playChain(steps, {
        force: opts.fromIdle ? Boolean(opts.force) : opts.force !== false,
        fromIdle: Boolean(opts.fromIdle),
        behaviorId: sceneId,
      });
      return estimateChainMs(steps, ACTIONS);
    } catch {
      return null; // 合成异常 → 兜底旧行为表
    }
  }

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
  /** @type {(actionId: string, meta: { fromIdle?: boolean, holdMs?: number|null }) => void} */
  let onActionChange = () => {};

  /** frame playback state */
  let frameIndex = 0;
  /** @type {string[]} */
  let frameList = [];
  let frameLoop = true;
  let holdLast = false;
  let frameIntervalMs = 250;
  /** 循环播放方向（1 正放 / -1 倒放——轮间随机翻转，动作不再匀速往返） */
  let frameDir = 1;
  /** 每轮循环的速度抖动（0.8–1.2，呼吸/摆动的节奏每轮不同） */
  let frameFpsJitter = 1;
  let playingToken = 0;

  // —— Flow 层：连续微动画（rAF 噪声驱动，非帧模板） ——
  // 三层不可通约频率的正弦叠加 → 永不精确重复的平滑摆动，
  // 叠加视线跟随（她微微朝你的光标方向偏移）与拖拽惯性倾斜。
  let flowRaf = 0;
  let flowT = Math.random() * 100;
  let flowAmp = 1;
  let flowSpeed = 1;
  /** 鼠标相对她的归一化方向（-1..1；null = 不在窗口） */
  let flowPointerX = null;
  let flowPointerCur = 0;
  /** 拖拽惯性倾斜目标（-1..1，来自拖拽瞬时速度） */
  let flowLeanTarget = 0;
  let flowLeanCur = 0;

  /** 各动作的摆动强度（睡/躺几乎静止，活跃动作摆幅大） */
  const FLOW_ACTION_AMP = {
    idle: 1, breathe: 0.9, sway: 1.25, look: 1, smile: 1, nod: 1,
    calm: 0.85, soft: 0.85, think: 0.8, peek: 1, giggle: 1.15, talk: 1,
    wave: 1.1, stretch: 1.2, hop: 1.3, bounce: 1.3, celebrate: 1.3,
    alert: 1.1, shy: 0.75, coat: 0.9, yawn: 0.9, greet: 1.1, walk: 1,
    sit: 0.55, crouch: 0.55, rest: 0.5, lie: 0.3, prone: 0.3,
    sleep: 0.22, drag: 0.5,
  };

  function applyFlowTransform() {
    if (!layerA || !layerB) return;
    // 两个 sprite 层同步（同一时刻只有一层可见，但切换时保持连续）
    const t =
      "translate3d(" +
      flowState.x.toFixed(2) +
      "px, " +
      flowState.y.toFixed(2) +
      "px, 0) rotate(" +
      flowState.rot.toFixed(3) +
      "deg)";
    if (layerA.style.transform !== t) layerA.style.transform = t;
    if (layerB.style.transform !== t) layerB.style.transform = t;
  }

  const flowState = { rot: 0, x: 0, y: 0 };

  function flowTick() {
    if (!enabled) {
      flowRaf = 0;
      return;
    }
    flowT += (1 / 60) * flowSpeed;
    const n1 =
      Math.sin(flowT * 0.9) * 0.55 +
      Math.sin(flowT * 1.73 + 1.3) * 0.3 +
      Math.sin(flowT * 0.23 + 4.1) * 0.35;
    const n2 =
      Math.sin(flowT * 0.71 + 2.2) * 0.5 +
      Math.sin(flowT * 1.13 + 0.7) * 0.35;
    const n3 =
      Math.sin(flowT * 1.07 + 5.0) * 0.6 +
      Math.sin(flowT * 0.29 + 1.9) * 0.4;

    // 视线跟随：平滑趋近鼠标方向（她"看向你"的微位移）
    const target = flowPointerX == null ? 0 : flowPointerX;
    flowPointerCur += (target - flowPointerCur) * 0.045;
    // 拖拽惯性：身体朝移动方向倾斜，松手回弹
    flowLeanCur += (flowLeanTarget - flowLeanCur) * 0.12;

    flowState.rot = n1 * 0.85 * flowAmp + flowLeanCur * 3.2;
    flowState.x = n2 * 1.5 * flowAmp + flowPointerCur * 1.8;
    flowState.y = n3 * 1.0 * flowAmp;
    applyFlowTransform();
    flowRaf = requestAnimationFrame(flowTick);
  }

  function startFlow() {
    if (!flowRaf && enabled) flowRaf = requestAnimationFrame(flowTick);
  }

  function stopFlow() {
    if (flowRaf) {
      cancelAnimationFrame(flowRaf);
      flowRaf = 0;
    }
  }

  /** 动作切换 → 摆动强度与节奏随情绪/动作变化 */
  function updateFlowForAction(actionId) {
    flowAmp = FLOW_ACTION_AMP[actionId] ?? 1;
    try {
      const m = typeof getMood === "function" ? getMood() : null;
      const e = m && Number.isFinite(m.energy) ? m.energy : 55;
      flowSpeed = 0.8 + (e / 100) * 0.6; // 精力充沛摆动更快，困了近乎凝滞
    } catch {
      flowSpeed = 1;
    }
  }

  /** @param {number | null} nx 鼠标相对她的归一化方向（-1..1，null 离开窗口） */
  function setFlowPointer(nx) {
    flowPointerX =
      typeof nx === "number" && Number.isFinite(nx)
        ? Math.max(-1, Math.min(1, nx))
        : null;
  }

  /** @param {number} lean 拖拽倾斜（-1..1，由瞬时拖拽速度映射） */
  function setDragLean(lean) {
    flowLeanTarget = Math.max(-1, Math.min(1, Number(lean) || 0));
  }
  /** Invalidates in-flight image load handlers so stale swaps cannot double-show layers. */
  let swapToken = 0;
  /** Last applied act-* class (skip full classList scan when unchanged). */
  let lastActClass = "";

  /** actionId → readyAt ms */
  /** @type {Map<string, number>} */
  const actionCooldowns = new Map();
  /** After playScene hold ends, suppress sit-heavy zone picks */
  let postSceneUntil = 0;

  /**
   * Active multi-step chain (behavior / playChain).
   * @type {null | {
   *   token: number,
   *   steps: ReturnType<typeof normalizeStep>[],
   *   index: number,
   *   behaviorId: string|null,
   *   fromIdle: boolean,
   * }}
   */
  let activeChain = null;
  let chainToken = 0;
  /** Currently playing behavior id (for UI / debug) */
  let currentBehavior = null;

  function clearActionTimer() {
    if (actionTimer) {
      clearTimeout(actionTimer);
      actionTimer = null;
    }
  }

  function clearChain() {
    activeChain = null;
    chainToken += 1;
    currentBehavior = null;
    if (actor?.dataset) delete actor.dataset.behavior;
  }

  /**
   * Advance to next chain step, or return false if chain is done / cancelled.
   * @returns {boolean}
   */
  function advanceChain() {
    if (!activeChain) return false;
    const chain = activeChain;
    if (chain.token !== chainToken) return false;
    const nextIndex = chain.index + 1;
    if (nextIndex >= chain.steps.length) {
      clearChain();
      return false;
    }
    chain.index = nextIndex;
    const step = chain.steps[nextIndex];
    const endless = step.holdMs === null;
    play(step.action, {
      force: true,
      fromIdle: chain.fromIdle,
      chainStep: true,
      holdMs: endless ? null : step.holdMs,
      endless,
    });
    return true;
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

  function stampZoneDom(zoneId) {
    if (!actor) return;
    const z = zoneId || (typeof getLastZoneId === "function" ? getLastZoneId() : null);
    if (z) actor.dataset.zone = z;
  }

  /**
   * 即兴闲置链：合成成功即播放（非 force，尊重漫游 / 场景锁）。
   * @param {string | null} zoneId
   * @returns {boolean} 是否已用即兴链接手
   */
  function tryImprovFidget(zoneId) {
    try {
      const chain = improvFidget({
        timeBucket: timeBucket(),
        zoneId,
        mood: getMood() || undefined,
      });
      if (Array.isArray(chain) && chain.length) {
        playChain(chain, { fromIdle: true, force: false, behaviorId: "improvFidget" });
        return true;
      }
    } catch {
      /* 即兴失败就走固定行为池 */
    }
    return false;
  }

  async function tickIdle() {
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

    let pick = null;
    let zoneIdForDom = null;

    try {
      let snap = null;
      if (typeof getZoneSnapshot === "function") {
        snap = await Promise.resolve(getZoneSnapshot({ ensureFresh: true }));
      }

      // POST-AWAIT GUARDS
      if (!enabled || paused || Date.now() < lockedUntil) {
        scheduleIdle();
        return;
      }
      if (currentAction === "sleep" || currentAction === "drag") {
        scheduleIdle();
        return;
      }

      if (Date.now() < postSceneUntil) {
        pick = Math.random() < 0.5 ? "breathe" : "calm";
      } else if (snap?.idleWeights) {
        zoneIdForDom = snap.zoneId || null;
        pick = pickWeightedAction(snap.idleWeights, actionCooldowns, Date.now(), ACTIONS);
        if (snap.facingHint && isLookishAction(pick)) {
          setFacing(snap.facingHint);
        }
      }
    } catch {
      pick = null;
    }

    if (!pick || pick === "idle") {
      pick = pickIdleAction();
    }

    stampZoneDom(zoneIdForDom);

    // Occasional multi-action fidget sequence (smoother "living" idle).
    // 优先即兴合成链（每次组合都不一样）；合成器放弃时走固定行为池。
    if (
      !zoneIdForDom &&
      Date.now() >= postSceneUntil &&
      Math.random() < IDLE_FIDGET_CHANCE
    ) {
      const improvised = tryImprovFidget(null);
      if (improvised) return;
      if (getBehavior("idleFidget")) {
        playBehavior("idleFidget", { fromIdle: true, force: false });
        return;
      }
    }
    // Zone path: still sometimes use coordinated micro-chains
    if (
      zoneIdForDom &&
      Date.now() >= postSceneUntil &&
      Math.random() < IDLE_FIDGET_CHANCE * 0.65
    ) {
      const improvised = tryImprovFidget(zoneIdForDom);
      if (improvised) return;
      playBehavior("idleFidget", { fromIdle: true, force: false });
      return;
    }

    markActionCooldown(pick, actionCooldowns);
    play(pick, { fromIdle: true });

    // Rare quiet line when zone-picked low posture (caller may also settle with speech).
    if (
      (pick === "sit" || pick === "crouch" || pick === "lie" || pick === "prone") &&
      typeof deps.onZoneSit === "function"
    ) {
      try {
        deps.onZoneSit(zoneIdForDom || (typeof getLastZoneId === "function" ? getLastZoneId() : null));
      } catch {
        /* ignore */
      }
    }
  }

  function scheduleIdle() {
    clearIdleTimer();
    if (!enabled) return;
    // VPet 式节奏：小动作频繁发生（1.1–3.7s 一次），不再一张图停半分钟。
    // 困倦 / 深夜时动作自然放缓——「累了动作变慢」而不是匀速播放。
    let wait = 1100 + Math.random() * 2600;
    try {
      const mood = typeof getMood === "function" ? getMood() : null;
      if (mood && Number.isFinite(mood.energy) && mood.energy < 30) wait *= 1.7;
    } catch {
      /* 情绪缺席就按常速 */
    }
    const bucket = timeBucket();
    if (bucket === "lateNight") wait *= 1.45;
    else if (bucket === "night" || bucket === "dawn") wait *= 1.2;
    idleTimer = setTimeout(() => {
      void tickIdle();
    }, wait);
  }

  function applyCss(actionId) {
    if (!actor) return;
    const def = ACTIONS[actionId] || ACTIONS.idle;
    const nextCls = def.css || `act-${actionId}`;
    if (nextCls !== lastActClass) {
      if (lastActClass) actor.classList.remove(lastActClass);
      else {
        for (const cls of [...actor.classList]) {
          if (cls.startsWith("act-")) actor.classList.remove(cls);
        }
      }
      actor.classList.add(nextCls);
      lastActClass = nextCls;
    }
    actor.dataset.action = actionId;
    applyFacingClass();
    // Flow 层随动作调整摆幅（睡几乎静止、活跃动作摆幅大）与节奏（情绪 energy）
    updateFlowForAction(actionId);
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
      // 注意：这里必须保持瞬时硬切——任何渐入/交叉淡化都会让半透明
      // 粉边透出桌面背景，动作高频切换时表现为晃眼的闪烁（实测教训）。
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

    const atEnd = frameIndex >= frameList.length - 1;
    const atStart = frameIndex <= 0;

    if (frameLoop) {
      // 循环动作到达边界 → 抽下一轮变体（35% 反向走、速度 ±20% 抖动），
      // 呼吸 / 摆动不再匀速重复，每一轮的节奏都略有不同。
      if ((frameDir > 0 && atEnd) || (frameDir < 0 && atStart)) {
        if (Math.random() < 0.35) frameDir = -frameDir;
        frameFpsJitter = 0.8 + Math.random() * 0.4;
      }
      frameIndex += frameDir;
      if (frameIndex < 0) frameIndex = 0;
      if (frameIndex > frameList.length - 1) frameIndex = frameList.length - 1;
      frameTimer = setTimeout(() => tickFrames(token), frameIntervalMs / frameFpsJitter);
      return;
    }

    // one-shot：播完即停（等 duration 定时器回 idle / 链推进）
    if (atEnd) {
      if (!holdLast) return;
      return;
    }
    frameIndex += 1;
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
    frameDir = 1;
    frameFpsJitter = 1;
    const fps = Math.max(0.5, Number(def.fps) || 4);
    // 每次开播 fps 微抖 ±12%——同一段动作每次播的密度都略有不同
    const jitteredFps = fps * (0.88 + Math.random() * 0.24);
    frameIntervalMs = Math.round(1000 / jitteredFps);

    // paint first frame immediately
    showFrame(frameList[0]);

    if (frameList.length <= 1) {
      return;
    }

    frameTimer = setTimeout(() => {
      frameIndex = Math.min(1, frameList.length - 1);
      tickFrames(token);
    }, frameIntervalMs);
  }

  /**
   * @param {boolean} value
   * @param {{ skipResume?: boolean, resumeAction?: string }} [opts]
   */
  function setPaused(value, opts = {}) {
    const next = Boolean(value);
    if (next === paused) return;
    paused = next;
    if (paused) {
      savedBeforePause = currentAction === "drag" ? savedBeforePause : currentAction;
      clearIdleTimer();
      clearChain();
      play("drag", { force: true });
    } else if (opts.skipResume) {
      // Caller owns the next play (drag-end settle). Do not scheduleIdle here —
      // play() will re-arm the idle pool.
      clearIdleTimer();
    } else {
      const resume =
        opts.resumeAction ||
        (savedBeforePause === "drag" ? "idle" : savedBeforePause || "idle");
      play(resume, { force: true, fromIdle: true });
      scheduleIdle();
    }
  }

  /**
   * @param {ActionId} actionId
   * @param {{
   *   force?: boolean,
   *   fromIdle?: boolean,
   *   holdMs?: number|null,
   *   chainStep?: boolean,
   *   endless?: boolean,
   * }} [opts]
   */
  function play(actionId, opts = {}) {
    if (!actor) return;
    if (paused && opts.fromIdle && actionId !== "drag") {
      scheduleIdle();
      return;
    }
    const resolvedId = ACTIONS[actionId] ? actionId : "idle";
    const def = ACTIONS[resolvedId] || ACTIONS.idle;
    const now = Date.now();

    if (!opts.force && opts.fromIdle && now < lockedUntil) {
      scheduleIdle();
      return;
    }

    // External play cancels an in-flight multi-action chain (unless continuing it).
    if (!opts.chainStep) {
      clearChain();
    }

    currentAction = resolvedId;
    applyCss(resolvedId);
    startFramePlayback(def);

    clearActionTimer();
    // Always drop a pending idle-pool tick; re-schedule below when appropriate.
    // Otherwise a stale timer can cancel walk/hop mid-locomotion.
    clearIdleTimer();

    let hold = null;
    if (opts.endless || opts.holdMs === null) {
      hold = null;
    } else if (opts.holdMs != null && opts.holdMs > 0) {
      hold = Number(opts.holdMs);
    } else if (def.duration != null && def.duration > 0) {
      hold = Number(def.duration);
    } else if (!def.loop) {
      const frames = def.frames?.length || 1;
      const fps = Math.max(0.5, Number(def.fps) || 4);
      hold = Math.max(800, Math.round((frames / fps) * 1000) + 200);
    }

    // Timed actions (including looping clips like walk): hold then chain / fallback.
    if (hold && hold > 0) {
      lockedUntil = now + hold;
      const played = resolvedId;
      const chainTok = chainToken;
      actionTimer = setTimeout(() => {
        if (currentAction !== played) {
          scheduleIdle();
          return;
        }
        // Seamless multi-action: continue chain without flashing idle
        if (activeChain && activeChain.token === chainTok) {
          if (advanceChain()) return;
        }
        const ctx = actor?.dataset.context;
        const fallback = ctx === "sleep" ? "sleep" : "idle";
        play(fallback, { force: true, fromIdle: true });
      }, hold);
    } else if (def.loop) {
      // Endless loop (idle / sleep) — end of chain if we landed here as last step
      if (activeChain && activeChain.token === chainToken) {
        // Last step is endless (e.g. sleep) — clear chain bookkeeping
        clearChain();
      }
      lockedUntil = 0;
      scheduleIdle();
    } else {
      lockedUntil = now + 800;
      const played = resolvedId;
      const chainTok = chainToken;
      actionTimer = setTimeout(() => {
        if (currentAction !== played) {
          scheduleIdle();
          return;
        }
        if (activeChain && activeChain.token === chainTok) {
          if (advanceChain()) return;
        }
        const ctx = actor?.dataset.context;
        play(ctx === "sleep" ? "sleep" : "idle", { force: true, fromIdle: true });
      }, 800);
    }

    try {
      onActionChange(resolvedId, {
        fromIdle: Boolean(opts.fromIdle),
        holdMs: hold ?? null,
        behavior: currentBehavior,
      });
    } catch {
      // ignore listener errors
    }
  }

  /**
   * Play a sequence of actions without idle between steps.
   * @param {import("./behaviors.js").ChainStep[]} chain
   * @param {{ force?: boolean, fromIdle?: boolean, behaviorId?: string }} [opts]
   */
  function playChain(chain, opts = {}) {
    if (!actor) return;
    const steps = (chain || []).map(normalizeStep).filter((s) => s.action);
    if (!steps.length) {
      play("idle", { force: Boolean(opts.force), fromIdle: Boolean(opts.fromIdle) });
      return;
    }
    if (paused && opts.fromIdle) {
      scheduleIdle();
      return;
    }
    if (!opts.force && opts.fromIdle && Date.now() < lockedUntil) {
      scheduleIdle();
      return;
    }

    clearChain();
    const token = ++chainToken;
    currentBehavior = opts.behaviorId || null;
    activeChain = {
      token,
      steps,
      index: 0,
      behaviorId: opts.behaviorId || null,
      fromIdle: Boolean(opts.fromIdle),
    };

    if (actor && currentBehavior) {
      actor.dataset.behavior = currentBehavior;
    }

    const first = steps[0];
    const endless = first.holdMs === null;
    play(first.action, {
      force: true,
      fromIdle: Boolean(opts.fromIdle),
      chainStep: true,
      holdMs: endless ? null : first.holdMs,
      endless,
    });
  }

  /**
   * Resolve a named behavior (weighted multi-variant chains) and play it.
   * 主路径：情绪驱动现场合成；仅合成不可用时兜底固定行为表。
   * @param {string} behaviorId
   * @param {{ force?: boolean, fromIdle?: boolean, holdMs?: number }} [opts]
   */
  function playBehavior(behaviorId, opts = {}) {
    // 只有明确收录的场景走情绪合成；未知 id（可能是动作名如 wave）直接播
    if (Object.prototype.hasOwnProperty.call(SCENE_BIAS, behaviorId)) {
      const synthMs = trySynthBehavior(behaviorId, opts);
      if (synthMs != null) return synthMs;
    }

    const def = getBehavior(behaviorId);
    if (!def) {
      play(behaviorId, { force: Boolean(opts.force), fromIdle: Boolean(opts.fromIdle) });
      return;
    }

    if (def.context === "sleep") setContext("sleep");
    else if (def.context != null) setContext(def.context);
    else if (
      behaviorId === "night" ||
      behaviorId === "lateNight" ||
      behaviorId === "sleep"
    ) {
      setContext("sleep");
    } else if (!opts.fromIdle) {
      // Intentional scene/menu behaviors clear sleep unless they set it
      setContext("");
    }

    const variant = pickVariant(def.variants);
    let chain = variant.chain;
    // Optional hold override (e.g. menu sit longer) — apply to last step
    if (opts.holdMs && opts.holdMs > 0) {
      const steps = chain.map(normalizeStep);
      const last = steps[steps.length - 1];
      // Don't force a finite hold onto endless sleep unless single-step
      if (last.holdMs === null && steps.length > 1) {
        // leave sleep endless; stretch previous pose if present
        const prev = steps[steps.length - 2];
        steps[steps.length - 2] = {
          action: prev.action,
          holdMs: opts.holdMs,
        };
      } else {
        steps[steps.length - 1] = {
          action: last.action,
          holdMs: opts.holdMs,
        };
      }
      chain = steps;
    }

    // Idle fidget: never force through locks; scenes/menus: force by default
    const force = opts.fromIdle ? Boolean(opts.force) : opts.force !== false;

    playChain(chain, {
      force,
      fromIdle: Boolean(opts.fromIdle),
      behaviorId,
    });

    return estimateChainMs(chain, ACTIONS);
  }

  function setContext(ctx) {
    if (actor) actor.dataset.context = ctx || "";
  }

  /** Preload once per process — paint() re-attach must not re-decode every frame. */
  let framesPreloaded = false;
  function preloadAll() {
    if (framesPreloaded) return;
    framesPreloaded = true;
    const seen = new Set();
    for (const def of Object.values(ACTIONS)) {
      for (const url of def.frames || []) {
        if (seen.has(url)) continue;
        seen.add(url);
        const img = new Image();
        img.src = url;
      }
    }
  }

  function attach(petHitEl, { actionChange } = {}) {
    root = petHitEl;
    actor = petHitEl?.querySelector("#pet-actor");
    layerA = petHitEl?.querySelector("#pet-layer-a");
    layerB = petHitEl?.querySelector("#pet-layer-b");
    if (typeof actionChange === "function") onActionChange = actionChange;

    if (!actor || !layerA || !layerB) return;

    preloadAll();

    const def = ACTIONS[currentAction] || ACTIONS.idle;
    const first = (def.frames && def.frames[0]) || bodyUrl("default");
    layerA.src = first;
    layerA.classList.add("is-visible");
    layerB.classList.remove("is-visible");
    frontIsA = true;
    lastActClass = "";
    applyCss(currentAction);
    enabled = true;
    paused = false;
    startFramePlayback(def);
    scheduleIdle();
    startFlow();
  }

  function detach() {
    enabled = false;
    stopFlow();
    clearActionTimer();
    clearIdleTimer();
    clearFrameTimer();
    clearChain();
    playingToken += 1;
    lastActClass = "";
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
    // 主路径：情绪驱动现场合成（含时段 / 互动 / 反应全部已知场景）
    if (Object.prototype.hasOwnProperty.call(SCENE_BIAS, scene)) {
      const synthMs = trySynthBehavior(scene, {
        force: true,
        fromIdle: false,
        ...extra,
      });
      if (synthMs != null) {
        const holdMs =
          extra.holdMs && extra.holdMs > 0
            ? Number(extra.holdMs)
            : Math.max(1200, Number(synthMs) || 1200);
        postSceneUntil = Date.now() + holdMs + ZONE_CONFIG.POST_SCENE_IDLE_COOLDOWN_MS;
        return;
      }
    }

    // 兜底：旧行为表 / 直接动作
    const behavior = getBehavior(scene);
    if (behavior) {
      const chainMs = playBehavior(scene, {
        force: true,
        fromIdle: false,
        ...extra,
      });
      const holdMs =
        extra.holdMs && extra.holdMs > 0
          ? Number(extra.holdMs)
          : Math.max(1200, Number(chainMs) || 1200);
      postSceneUntil = Date.now() + holdMs + ZONE_CONFIG.POST_SCENE_IDLE_COOLDOWN_MS;
      return;
    }

    // Fallback: treat scene name as action id
    const action = actionForScene(scene);
    if (action === "sleep") setContext("sleep");
    else setContext("");
    play(action, { force: true, ...extra });
    const def = ACTIONS[action] || ACTIONS.idle;
    const hold = extra.holdMs ?? def.duration;
    const holdMs = hold && hold > 0 ? Number(hold) : 1200;
    postSceneUntil = Date.now() + holdMs + ZONE_CONFIG.POST_SCENE_IDLE_COOLDOWN_MS;
  }

  function getAction() {
    return currentAction;
  }

  function getBehaviorId() {
    return currentBehavior;
  }

  return {
    attach,
    detach,
    play,
    playChain,
    playBehavior,
    playScene,
    setContext,
    setPaused,
    setFacing,
    setFlowPointer,
    setDragLean,
    getFacing,
    getAction,
    getBehaviorId,
    scheduleIdle,
    lockFor,
    isPaused,
    isEnabled,
  };
}
