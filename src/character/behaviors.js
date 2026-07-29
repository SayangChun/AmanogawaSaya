/**
 * 行为编排：一个「行为」可对应多条动作变体（加权随机），
 * 每条变体是动作链（顺序播放，中间不回 idle，保证衔接流畅）。
 *
 * 动作 id 来自 anim-manifest / ACTIONS；链步可为 string 或 { action, holdMs? }。
 */

/**
 * @typedef {string | { action: string, holdMs?: number }} ChainStep
 * @typedef {{ weight?: number, chain: ChainStep[] }} BehaviorVariant
 * @typedef {{
 *   context?: string,
 *   variants: BehaviorVariant[],
 * }} BehaviorDef
 */

/** @type {Record<string, BehaviorDef>} */
export const BEHAVIORS = {
  // —— 启动 / 时段场景 ——
  boot: {
    variants: [
      { weight: 2.2, chain: ["wave", "smile"] },
      { weight: 1.8, chain: ["greet"] },
      { weight: 1.6, chain: ["wave", "soft"] },
      { weight: 1.2, chain: ["nod", "wave"] },
      { weight: 1.0, chain: ["bounce", "wave", "smile"] },
      { weight: 0.8, chain: ["giggle", "wave"] },
    ],
  },
  morning: {
    variants: [
      { weight: 2.0, chain: ["stretch", "soft"] },
      { weight: 1.6, chain: ["yawn", "soft"] },
      { weight: 1.4, chain: ["soft", "smile"] },
      { weight: 1.0, chain: ["stretch", "wave"] },
      { weight: 0.9, chain: ["breathe", "soft", "nod"] },
    ],
  },
  noon: {
    variants: [
      { weight: 2.0, chain: ["calm"] },
      { weight: 1.4, chain: ["look", "calm"] },
      { weight: 1.2, chain: ["soft", "nod"] },
      { weight: 1.0, chain: ["think", "calm"] },
      { weight: 0.8, chain: ["sway", "smile"] },
    ],
  },
  afternoon: {
    variants: [
      { weight: 1.8, chain: ["sway", "look"] },
      { weight: 1.5, chain: ["breathe", "soft"] },
      { weight: 1.2, chain: ["smile", "nod"] },
      { weight: 1.0, chain: ["peek", "calm"] },
      { weight: 0.9, chain: ["coat", "soft"] },
    ],
  },
  evening: {
    variants: [
      { weight: 2.0, chain: ["coat", "soft"] },
      { weight: 1.5, chain: ["coat", "calm"] },
      { weight: 1.2, chain: ["soft", "look"] },
      { weight: 1.0, chain: ["sway", "coat"] },
      { weight: 0.8, chain: ["think", "soft"] },
    ],
  },
  night: {
    context: "sleep",
    variants: [
      { weight: 2.0, chain: ["yawn", "sleep"] },
      { weight: 1.6, chain: ["soft", "sleep"] },
      { weight: 1.2, chain: ["breathe", "sleep"] },
      { weight: 1.0, chain: ["sit", { action: "sleep", holdMs: null }] },
    ],
  },
  lateNight: {
    context: "sleep",
    variants: [
      { weight: 2.2, chain: ["sleep"] },
      { weight: 1.4, chain: ["breathe", "sleep"] },
      { weight: 1.0, chain: ["yawn", "sleep"] },
      { weight: 0.8, chain: ["soft", "breathe", "sleep"] },
    ],
  },

  // —— 互动 ——
  tap: {
    variants: [
      { weight: 2.2, chain: ["bounce"] },
      { weight: 1.6, chain: ["bounce", "smile"] },
      { weight: 1.2, chain: ["hop", "smile"] },
      { weight: 1.0, chain: ["giggle"] },
      { weight: 0.9, chain: ["alert", "soft"] },
      { weight: 0.7, chain: ["nod", "smile"] },
    ],
  },
  talk: {
    variants: [
      { weight: 2.4, chain: ["talk"] },
      { weight: 1.6, chain: ["nod", "talk"] },
      { weight: 1.4, chain: ["soft", "talk"] },
      { weight: 1.1, chain: ["look", "talk"] },
      { weight: 0.9, chain: ["think", "talk"] },
      { weight: 0.7, chain: ["smile", "talk"] },
    ],
  },
  praise: {
    variants: [
      { weight: 2.2, chain: ["shy", "smile"] },
      { weight: 1.8, chain: ["shy", "soft"] },
      { weight: 1.4, chain: ["shy"] },
      { weight: 1.2, chain: ["giggle", "shy"] },
      { weight: 1.0, chain: ["bounce", "shy", "smile"] },
      { weight: 0.8, chain: ["celebrate", "shy"] },
    ],
  },
  hide: {
    variants: [
      { weight: 2.0, chain: ["nod"] },
      { weight: 1.5, chain: ["soft", "nod"] },
      { weight: 1.2, chain: ["wave", "nod"] },
      { weight: 0.9, chain: ["smile", "nod"] },
    ],
  },
  affinityUp: {
    variants: [
      { weight: 2.0, chain: ["celebrate", "smile"] },
      { weight: 1.6, chain: ["celebrate", "bounce"] },
      { weight: 1.4, chain: ["giggle", "celebrate"] },
      { weight: 1.0, chain: ["hop", "celebrate", "smile"] },
      { weight: 0.9, chain: ["wave", "celebrate"] },
    ],
  },

  // —— 菜单 / 场所 ——
  menuSit: {
    variants: [
      { weight: 2.0, chain: ["sit"] },
      { weight: 1.5, chain: ["rest"] },
      { weight: 1.4, chain: ["stretch", "sit"] },
      { weight: 1.2, chain: ["yawn", "sit"] },
      { weight: 1.0, chain: ["soft", "sit"] },
      { weight: 0.8, chain: ["calm", "sit"] },
    ],
  },
  menuHop: {
    variants: [
      { weight: 2.0, chain: ["hop"] },
      { weight: 1.4, chain: ["hop", "smile"] },
      { weight: 1.1, chain: ["bounce", "hop"] },
      { weight: 0.9, chain: ["giggle", "hop"] },
    ],
  },
  settle: {
    variants: [
      { weight: 2.0, chain: ["soft"] },
      { weight: 1.5, chain: ["look"] },
      { weight: 1.2, chain: ["calm"] },
      { weight: 1.0, chain: ["peek"] },
      { weight: 0.8, chain: ["breathe", "soft"] },
    ],
  },
  settleEdge: {
    variants: [
      { weight: 2.0, chain: ["look"] },
      { weight: 1.6, chain: ["soft"] },
      { weight: 1.2, chain: ["peek"] },
      { weight: 1.0, chain: ["alert", "soft"] },
      { weight: 0.8, chain: ["think"] },
    ],
  },
  settleCorner: {
    variants: [
      { weight: 2.0, chain: ["sit"] },
      { weight: 1.4, chain: ["soft", "sit"] },
      { weight: 1.2, chain: ["calm", "sit"] },
      { weight: 1.0, chain: ["look", "soft"] },
    ],
  },

  // —— 闲置微序列（偶尔连续小动作，更有「活着」感）——
  idleFidget: {
    variants: [
      { weight: 1.8, chain: ["look", "soft"] },
      { weight: 1.5, chain: ["sway", "smile"] },
      { weight: 1.3, chain: ["nod", "calm"] },
      { weight: 1.2, chain: ["stretch", "breathe"] },
      { weight: 1.1, chain: ["peek", "calm"] },
      { weight: 1.0, chain: ["think", "soft"] },
      { weight: 0.9, chain: ["yawn", "breathe"] },
      { weight: 0.8, chain: ["wave", "smile"] },
      { weight: 0.7, chain: ["giggle", "soft"] },
    ],
  },
};

/**
 * @param {ChainStep} step
 * @returns {{ action: string, holdMs?: number|null }}
 */
export function normalizeStep(step) {
  if (typeof step === "string") {
    return { action: step };
  }
  if (step && typeof step === "object" && step.action) {
    return {
      action: String(step.action),
      holdMs: step.holdMs === undefined ? undefined : step.holdMs,
    };
  }
  return { action: "idle" };
}

/**
 * @param {BehaviorVariant[]} variants
 * @returns {BehaviorVariant}
 */
export function pickVariant(variants) {
  const list = Array.isArray(variants) ? variants.filter((v) => v?.chain?.length) : [];
  if (!list.length) {
    return { weight: 1, chain: ["idle"] };
  }
  let sum = 0;
  for (const v of list) sum += Math.max(0, Number(v.weight) || 1);
  if (sum <= 0) return list[0];
  let r = Math.random() * sum;
  for (const v of list) {
    r -= Math.max(0, Number(v.weight) || 1);
    if (r <= 0) return v;
  }
  return list[list.length - 1];
}

/**
 * 估计一整条链的总占用时长（用于 postScene 冷却等）。
 * @param {ChainStep[]} chain
 * @param {Record<string, { duration?: number|null }>} actionCatalog
 */
export function estimateChainMs(chain, actionCatalog = {}) {
  let total = 0;
  for (const raw of chain || []) {
    const step = normalizeStep(raw);
    if (step.holdMs === null) {
      // Endless (e.g. sleep) — use a nominal settle window
      total += 1200;
      continue;
    }
    if (typeof step.holdMs === "number" && step.holdMs > 0) {
      total += step.holdMs;
      continue;
    }
    const def = actionCatalog[step.action];
    const d = def?.duration;
    if (d && d > 0) total += Number(d);
    else total += 1200;
  }
  return total;
}

/**
 * @param {string} behaviorId
 * @returns {BehaviorDef|null}
 */
export function getBehavior(behaviorId) {
  return BEHAVIORS[behaviorId] || null;
}

/**
 * 兼容旧 API：取行为「代表」动作（首个变体的第一步）。
 * @param {string} scene
 * @returns {string}
 */
export function primaryActionForBehavior(scene) {
  const b = BEHAVIORS[scene];
  if (!b?.variants?.length) return "talk";
  const step = normalizeStep(b.variants[0].chain[0]);
  return step.action || "talk";
}
