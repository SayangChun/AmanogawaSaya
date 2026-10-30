/**
 * 即兴动作合成器 v2：动作完全由「情绪 + 场景语境」现场生成。
 *
 * 不存在固定模板链——每次合成的组合、顺序、节奏都不同：
 *   组权重 = 基础 × 时段/区域/亲密度 × 情绪(mood.groupBias) × 场景偏置(sceneBias)
 * 骨架概率：45% 单步 / 30% 双步 / 25% 三步；holdMs ±25% 抖动；15% 微插入。
 *
 * 情绪由 src/character/mood.js 持续演化（事件脉冲 + 基线回归 + 随机游走），
 * 所以同一个「被夸」：心情好时可能蹦一下再害羞，困的时候可能只是慢慢红了脸。
 *
 * 纯函数模块（不依赖 DOM / motion 实例），rng 可注入便于测试。
 */

import { moodGroupBias } from "./mood.js";

/** @typedef {string | { action: string, holdMs?: number | null }} ChainStep */

/**
 * 语义分组（动作名均来自 anim-manifest，运行时仍按 catalog 过滤）。
 * shy / celebrate 是「情绪浮现组」：只有情绪到位才会被选中。
 */
export const IMPROV_GROUPS = {
  /** 观察系：安静地看 / 想 / 警觉 */
  observe: ["look", "peek", "think", "calm", "alert"],
  /** 温度系：带情绪的小表情 */
  warm: ["smile", "soft", "nod", "giggle", "coat"],
  /** 活跃系：动起来 */
  active: ["hop", "bounce", "sway", "stretch", "wave"],
  /** 低位系：坐下 / 蹲 / 躺 */
  low: ["sit", "crouch", "lie", "prone", "rest"],
  /** 困倦系：夜间高权重 */
  sleepy: ["yawn", "breathe"],
  /** 害羞系：情绪驱动 */
  shy: ["shy"],
  /** 庆祝系：情绪驱动 */
  celebrate: ["celebrate"],
};

/** 开场步（多步链的第一格） */
const OPENERS = ["look", "peek", "think", "alert", "nod"];
/** 收尾步（最后收住的一格） */
const TAILS = ["smile", "soft", "nod", "calm", "breathe"];
/** 微插入池（链中随机位置插一帧小动作） */
const MICROS = ["nod", "look", "smile"];

/**
 * @typedef {object} SceneBias
 * @property {Record<string, number>} [groups]
 * @property {string[]} [mustInclude]
 * @property {string[]} [restrictTo]
 * @property {number} [pace]
 * @property {boolean} [tailSleep]
 * @property {boolean} [allowLowPose]
 */

/**
 * 场景 → 动作语义偏置。替代旧行为表：这里只描述「这类时刻动作的倾向」，
 * 具体动作链仍每次现场合成。
 *
 * 字段：
 *   groups      组权重乘子（叠在情绪权重之上）
 *   mustInclude 链中必须出现的动作（如说话场景的 talk 口型）
 *   restrictTo  主步只从这个白名单挑（菜单姿势类）
 *   pace        全链时长乘子（<1 轻快，>1 舒缓）
 *   tailSleep   收尾进入睡眠（无限停留）
 *   allowLowPose false 时禁用低位姿态
 *
 * @type {Record<string, SceneBias>}
 */
export const SCENE_BIAS = {
  // —— 启动 / 时段场景 ——
  boot: { groups: { warm: 1.5, active: 1.2 } },
  dawn: { groups: { sleepy: 1.6, low: 1.3 }, pace: 1.2 },
  morning: { groups: { active: 1.3, warm: 1.2 }, pace: 0.95 },
  forenoon: { groups: { observe: 1.2 } },
  noon: { groups: { low: 1.4, sleepy: 1.2 }, pace: 1.15 },
  afternoon: { groups: { sleepy: 1.2, low: 1.1 } },
  evening: { groups: { warm: 1.2, low: 1.1 } },
  earlyNight: { groups: { warm: 1.2, observe: 1.1 } },
  night: { groups: { sleepy: 1.6, low: 1.5, active: 0.3 }, tailSleep: true },
  lateNight: {
    groups: { sleepy: 2.0, low: 1.8, active: 0.15, warm: 0.7 },
    tailSleep: true,
  },

  // —— 互动 ——
  tap: { groups: { active: 1.7, warm: 1.2 }, pace: 0.9 },
  talk: { mustInclude: ["talk"], groups: { observe: 1.2 } },
  praise: { groups: { shy: 2.5, warm: 0.6 }, pace: 1.25 },
  hide: { groups: { calm: 1.3 }, mustInclude: ["nod"] },
  affinityUp: { groups: { celebrate: 2.0, active: 1.3 }, pace: 0.9 },

  // —— 菜单 ——
  menuSit: { restrictTo: ["sit", "crouch", "lie", "prone", "rest"], groups: { low: 2.0 } },
  menuHop: { restrictTo: ["hop", "bounce"], mustInclude: ["hop"], groups: { active: 2.0 }, pace: 0.85 },
  menuPose: { restrictTo: ["crouch", "prone", "lie", "sit", "rest"] },
  settle: { groups: { observe: 1.2, low: 1.2 }, pace: 1.2 },
  settleEdge: { groups: { observe: 1.35, low: 1.1 }, pace: 1.25 },
  settleCorner: { groups: { low: 1.6, observe: 1.1 }, pace: 1.3 },

  // —— 伴侣对话 / 直播感反应 ——
  recall: { groups: { observe: 1.5 }, pace: 1.15 },
  comfort: { groups: { warm: 0.7, low: 1.2, sleepy: 1.1 }, pace: 1.3 },
  ponder: { mustInclude: ["talk"], groups: { observe: 1.3 } },
  chatTalk: { mustInclude: ["talk"], groups: { warm: 1.1 } },
  chatOpen: { groups: { observe: 1.2 } },
  nameSet: { groups: { shy: 1.8, warm: 1.4 } },
  chatPraise: { groups: { shy: 2.0, warm: 0.7 }, pace: 1.2 },
  missYou: { groups: { active: 1.4, warm: 1.3 }, pace: 0.9 },
  followUp: { mustInclude: ["talk"], groups: { observe: 1.2 } },
  aboutHer: { mustInclude: ["talk"], groups: { warm: 1.2 } },
  farewell: { mustInclude: ["wave"], groups: { calm: 1.2 }, pace: 1.1 },
  chatter: {},
  gaze: { groups: { shy: 2.0 } },
  hoverPeek: { groups: { observe: 1.3 } },
  pokeRapid: { groups: { active: 1.3, shy: 1.3 }, pace: 0.85 },
  dragDizzy: { groups: { sleepy: 1.2, low: 1.3 }, pace: 1.2 },
  userBack: { groups: { warm: 1.4, active: 1.2 }, pace: 0.95 },
  userAwayQuiet: { groups: { low: 1.3, sleepy: 1.1 }, pace: 1.3 },
  unlock: { groups: { warm: 1.2 } },
  nightOwl: { groups: { sleepy: 1.3, calm: 1.2 }, pace: 1.2 },
  zoneSit: { groups: { low: 1.5 }, pace: 1.2 },
};

/**
 * @typedef {object} ImprovCtx
 * @property {Record<string, unknown> | Set<string> | string[]} [catalog]
 *   可用动作集合（缺省视为全部可用）
 * @property {string} [timeBucket] lateNight/night/dawn/morning/...
 * @property {string} [zoneId] 屏幕区域（corner-* / edge-* / open）
 * @property {number} [affinity] 亲密度 0–100
 * @property {import("./mood.js").MoodVec | { groupBias?: Record<string, number> }} [mood]
 *   当前情绪（快照或原始向量）
 * @property {string} [scene] 场景 id（查 SCENE_BIAS）
 * @property {SceneBias} [sceneBias] 直接给偏置（优先于 scene）
 * @property {boolean} [allowLowPose] 是否允许低位姿态
 * @property {() => number} [rng] 随机源（默认 Math.random）
 */

/**
 * @param {ImprovCtx} ctx
 * @returns {() => number}
 */
function rngOf(ctx) {
  return typeof ctx.rng === "function" ? ctx.rng : Math.random;
}

/**
 * @param {string} action
 * @param {ImprovCtx} ctx
 * @returns {boolean}
 */
function actionExists(action, ctx) {
  const catalog = ctx.catalog;
  if (!catalog) return true;
  if (Array.isArray(catalog)) return catalog.includes(action);
  if (catalog instanceof Set) return catalog.has(action);
  return Boolean(catalog[action]);
}

/**
 * @param {string[]} pool
 * @param {ImprovCtx} ctx
 * @returns {string | null}
 */
function pickFrom(pool, ctx) {
  const rng = rngOf(ctx);
  const usable = pool.filter((a) => actionExists(a, ctx));
  if (!usable.length) return null;
  return usable[Math.floor(rng() * usable.length)];
}

/**
 * 汇总某组的最终权重：基础 × 时段/区域/亲密度 × 情绪 × 场景。
 * @param {ImprovCtx} ctx
 * @param {SceneBias} bias
 * @returns {Array<[string, number]>}
 */
function groupWeights(ctx, bias) {
  /** @type {Record<string, number>} */
  const w = {
    observe: 1,
    warm: 1,
    active: 1,
    low: 0.8,
    sleepy: 0.7,
    // 情绪浮现组：基础 1，由情绪乘子抬升 / 归零（乘 0 恒为 0 的坑）
    shy: 1,
    celebrate: 1,
  };

  const bucket = ctx.timeBucket || "";
  if (bucket === "lateNight" || bucket === "night") {
    w.sleepy *= 2.6;
    w.low *= 1.9;
    w.active *= 0.35;
    w.observe *= 1.25;
  } else if (bucket === "dawn") {
    w.sleepy *= 1.8;
    w.active *= 0.7;
  } else if (bucket === "morning" || bucket === "forenoon") {
    w.active *= 1.35;
    w.observe *= 1.15;
  } else if (bucket === "afternoon") {
    w.sleepy *= 1.4;
    w.low *= 1.2;
  } else if (bucket === "evening" || bucket === "earlyNight") {
    w.low *= 1.3;
    w.warm *= 1.2;
  }

  const zone = ctx.zoneId || "";
  if (zone.startsWith("corner") || zone === "edge-bottom") {
    w.low *= 1.7;
    w.active *= 0.5;
  } else if (zone.startsWith("edge")) {
    w.observe *= 1.35;
    w.active *= 0.7;
  }

  const affinity = Number(ctx.affinity) || 0;
  if (affinity >= 60) w.warm *= 1.35;
  else if (affinity > 0 && affinity < 30) {
    w.observe *= 1.3;
    w.warm *= 0.75;
  }

  // —— 情绪乘子（核心：同一场景不同心情 → 不同动作分布）——
  let moodBias = null;
  if (ctx.mood) {
    moodBias =
      ctx.mood.groupBias && typeof ctx.mood.groupBias === "object"
        ? ctx.mood.groupBias
        : moodGroupBias(ctx.mood);
  }
  if (moodBias) {
    for (const [group, mult] of Object.entries(moodBias)) {
      if (w[group] != null && Number.isFinite(mult)) w[group] *= mult;
    }
  }

  // —— 场景偏置乘子 ——
  if (bias.groups) {
    for (const [group, mult] of Object.entries(bias.groups)) {
      if (w[group] != null && Number.isFinite(mult)) w[group] *= mult;
    }
  }

  if (ctx.allowLowPose === false || bias.allowLowPose === false) w.low = 0;

  return Object.entries(w);
}

/**
 * 从分组里按权重挑一个主步动作。
 * @param {ImprovCtx} ctx
 * @param {SceneBias} bias
 * @returns {string | null}
 */
function pickMainAction(ctx, bias) {
  const rng = rngOf(ctx);

  // 白名单直选（菜单姿势类）
  if (bias.restrictTo?.length) {
    return pickFrom(bias.restrictTo, ctx);
  }

  const weights = groupWeights(ctx, bias).filter(
    ([group]) => (IMPROV_GROUPS[group] || []).some((a) => actionExists(a, ctx)),
  );
  let sum = 0;
  for (const [, weight] of weights) sum += Math.max(0, weight);
  if (sum <= 0) return pickFrom(IMPROV_GROUPS.observe, ctx);

  let r = rng() * sum;
  for (const [group, weight] of weights) {
    r -= Math.max(0, weight);
    if (r <= 0) return pickFrom(IMPROV_GROUPS[group], ctx);
  }
  return pickFrom(IMPROV_GROUPS.observe, ctx);
}

/**
 * holdMs 抖动：让同一动作每次停顿时长都略有不同。
 * @param {number} baseMs
 * @param {number} [ratio] 抖动比例（0–1，默认 0.25）
 * @param {() => number} [rng]
 * @returns {number}
 */
export function jitterHold(baseMs, ratio = 0.25, rng = Math.random) {
  const safeRatio = Math.min(0.9, Math.max(0, Number(ratio) || 0));
  const delta = baseMs * safeRatio;
  return Math.max(400, Math.round(baseMs + (rng() * 2 - 1) * delta));
}

/**
 * 主步的默认停留时长基准（VPet 式短促：动作一个接一个，不钉在原地）。
 * 低位姿态略久，但远短于旧值（9s → 3.4s），长停由「困倦调制」按需放大。
 * @param {string} action
 * @returns {number}
 */
function mainHoldBase(action) {
  if (IMPROV_GROUPS.low.includes(action)) return 3400;
  if (IMPROV_GROUPS.sleepy.includes(action)) return 2800;
  if (IMPROV_GROUPS.active.includes(action)) return 1600;
  if (action === "shy" || action === "celebrate") return 1800;
  return 1900;
}

/**
 * 停留时长的语境调制：困倦时段 / 活力低时动作放缓、停得更久——
 * 「累了动作变慢」而不是全天匀速。
 * @param {ImprovCtx} ctx
 * @returns {number}
 */
function holdModulation(ctx) {
  let m = 1;
  const bucket = ctx.timeBucket || "";
  if (bucket === "lateNight") m *= 1.9;
  else if (bucket === "night" || bucket === "dawn") m *= 1.35;
  else if (bucket === "afternoon") m *= 1.2;
  const energy = Number(ctx.mood?.energy);
  if (Number.isFinite(energy)) {
    if (energy < 30) m *= 1.5;
    else if (energy > 70) m *= 0.85; // 精力充沛时更利落
  }
  return m;
}

/**
 * 现场合成一条即兴动作链。
 * @param {ImprovCtx} [ctx]
 * @returns {ChainStep[]}
 */
export function improvChain(ctx = {}) {
  const rng = rngOf(ctx);
  const bias =
    ctx.sceneBias || (ctx.scene ? SCENE_BIAS[ctx.scene] || {} : {});
  const pace = Math.max(0.5, Math.min(2, Number(bias.pace) || 1));
  const holdMod = holdModulation(ctx);

  const main = pickMainAction(ctx, bias);
  if (!main) return ["idle"];

  // 白名单场景（菜单姿势类）：直接进主步，不加开场拖沓；收尾可留
  const restricted = Boolean(bias.restrictTo?.length);
  const roll = rng();
  /** @type {string | null} */
  let opener = null;
  /** @type {string | null} */
  let tail = null;
  if (restricted) {
    if (rng() < 0.5) tail = pickFrom(TAILS, ctx);
  } else if (roll < 0.38) {
    // 单步
  } else if (roll < 0.66) {
    // 双步：起+主 或 主+尾
    if (rng() < 0.5) opener = pickFrom(OPENERS, ctx);
    else tail = pickFrom(TAILS, ctx);
  } else {
    // 三步（VPet 式连招：小动作更爱连着来）
    opener = pickFrom(OPENERS, ctx);
    tail = pickFrom(TAILS, ctx);
  }

  /** @type {ChainStep[]} */
  const chain = [];
  if (opener) {
    chain.push({ action: opener, holdMs: jitterHold(1100 * pace * holdMod, 0.3, rng) });
  }
  chain.push({
    action: main,
    holdMs: jitterHold(mainHoldBase(main) * pace * holdMod, 0.3, rng),
  });
  if (tail) {
    chain.push({ action: tail, holdMs: jitterHold(1400 * pace * holdMod, 0.3, rng) });
  }

  // 微插入：22% 概率在链中随机位置插一帧小动作（仅多步链）
  if (chain.length >= 2 && rng() < 0.22) {
    const micro = pickFrom(MICROS, ctx);
    if (micro) {
      const at = 1 + Math.floor(rng() * chain.length);
      chain.splice(at, 0, { action: micro, holdMs: jitterHold(800 * pace, 0.3, rng) });
    }
  }

  // 必含动作（说话场景必须有 talk 口型等）：没有就补在链尾
  if (bias.mustInclude?.length) {
    for (const need of bias.mustInclude) {
      const has = chain.some((s) => (typeof s === "string" ? s : s.action) === need);
      if (!has && actionExists(need, ctx)) {
        chain.push({ action: need, holdMs: jitterHold(2800 * pace, 0.25, rng) });
      }
    }
  }

  // 睡眠收尾（夜场景）：最后一步进入无限停留的 sleep
  if (bias.tailSleep && actionExists("sleep", ctx)) {
    chain.push({ action: "sleep", holdMs: null });
  }

  return chain.length ? chain : ["idle"];
}

/**
 * idle 微动作专用入口（motion.tickIdle 的 improvFidget 钩子）。
 * 返回 null 表示这次不即兴、走默认单动作轮换。
 * @param {{ timeBucket?: string, zoneId?: string | null, affinity?: number, mood?: ImprovCtx["mood"], chance?: number, rng?: () => number, catalog?: ImprovCtx["catalog"] }} [opts]
 * @returns {ChainStep[] | null}
 */
export function improvFidget(opts = {}) {
  const rng = typeof opts.rng === "function" ? opts.rng : Math.random;
  const chance = Number.isFinite(opts.chance) ? Number(opts.chance) : 0.55;
  if (rng() >= chance) return null;
  return improvChain({
    timeBucket: opts.timeBucket,
    zoneId: opts.zoneId || undefined,
    affinity: opts.affinity,
    mood: opts.mood,
    rng,
    catalog: opts.catalog,
  });
}
