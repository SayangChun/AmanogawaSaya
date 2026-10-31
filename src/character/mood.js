/**
 * 情绪引擎：沙夜此刻「心情怎么样」，决定她「动作怎么做」。
 *
 * 五个维度（0–100）：
 *   joy     开心   —— 被夸、重逢、聊天会升；久无互动会降
 *   shyness 害羞   —— 被夸、被注视、被连戳会冲高；自然消退快
 *   calm    平静   —— 安静陪伴的底色；高时动作更慢更沉
 *   energy  活力   —— 时段主导（深夜困）；低时懒洋洋、爱趴
 *   missing 想念   —— 长时间没互动会累积；重逢时释放
 *
 * 情绪是连续波动的量：事件脉冲 + 向基线回归 + 随机游走，
 * 所以即便什么都没发生，她的状态也永远在轻微漂移——
 * 动作合成器据此挑组，同一种互动在不同心情下动作完全不同。
 *
 * 纯逻辑模块（定时器由外部驱动 tick），rng 可注入。
 */

/** @typedef {{ joy: number, shyness: number, calm: number, energy: number, missing: number }} MoodVec */

/** 情绪默认基线（时段/亲密度会在此基础上修正） */
const BASE = { joy: 35, shyness: 8, calm: 50, energy: 55, missing: 10 };

/** 各维度变化速度（每 tick 向基线回归的比例；越高消退越快） */
const DECAY = {
  joy: 0.10,
  shyness: 0.28, // 害羞来得快去得也快
  calm: 0.06,
  energy: 0.05,
  missing: 0.03, // 想念消得很慢
};

/** 随机游走幅度（每 tick） */
const DRIFT = { joy: 3, shyness: 2, calm: 2, energy: 2, missing: 1 };

/** 时段对基线的修正（energy 主导日夜节律） */
const BUCKET_BASE = {
  lateNight: { energy: -28, calm: 12, joy: -6 },
  night: { energy: -14, calm: 6 },
  earlyNight: { calm: 4, joy: 4 },
  evening: { calm: 2 },
  afternoon: { energy: -6 }, // 午后犯困
  noon: { energy: 2 },
  forenoon: { energy: 8, joy: 2 },
  morning: { energy: 10, joy: 4 },
  dawn: { energy: -8, calm: 6 },
};

/**
 * 互动事件 → 情绪脉冲。intensity 0–1 控制力度。
 * 值为「该次事件最多加/减多少」，实际带随机浮动。
 */
export const MOOD_PULSES = {
  tap: { joy: 10, energy: 4, shyness: 3 },
  praise: { shyness: 24, joy: 12, calm: 4 },
  pokeRapid: { shyness: 12, energy: 12, joy: 5 },
  dragDizzy: { shyness: 8, calm: -6, energy: 5, joy: 3 },
  gaze: { shyness: 16, joy: 4 },
  hoverPeek: { shyness: 4 },
  chat: { calm: 8, joy: 5 },
  comfort: { calm: 6, joy: -3, missing: 2 }, // 安慰时收起笑，认真一点
  missYou: { joy: 16, missing: -999 }, // 重逢把想念清空
  followUp: { calm: 2, energy: 2 },
  userBack: { joy: 10, missing: -999, energy: 6 },
  userAwayQuiet: { energy: -8, missing: 6, calm: 6 },
  unlock: { joy: 6 },
  nightOwl: { calm: 4, shyness: 2 },
  affinityUp: { joy: 18, energy: 10 },
  farewell: { missing: 8, calm: 4, joy: -2 },
  nameSet: { joy: 12, shyness: 10 },
  // 碎碎念类别（微脉冲，让独白也有情绪反馈）
  chatterMusing: { calm: 2 },
  chatterCurious: { energy: 3, joy: 1 },
  chatterNoticing: { calm: 2 },
  chatterAstro: { calm: 3 },
  chatterRecallish: { missing: 3, calm: 1 },
  chatterClingy: { joy: 6, shyness: 4 },
  chatterTinyAction: { energy: 5 },
  chatterSelfPlay: { calm: 3, missing: 2 },
  chatterDomestic: { calm: 2, joy: 1 },
  chatterLlm: { joy: 2 },
};

/**
 * 情绪 → 动作组合成偏置（乘到 motion-improv 的组权重上）。
 * 数值含义：×1 为中性；>1 更常出现；<1 更少出现；0 暂时排除。
 * @param {MoodVec} m
 * @returns {Record<string, Record<string, number>>}
 */
export function moodGroupBias(m) {
  const joy = (m.joy ?? 35) / 100;
  const shy = (m.shyness ?? 8) / 100;
  const calm = (m.calm ?? 50) / 100;
  const energy = (m.energy ?? 55) / 100;
  const missing = (m.missing ?? 10) / 100;

  return {
    // 温度系：开心时笑容多；害羞冲头时反而笑不出来
    warm: clamp(0.55 + joy * 1.1 - shy * 0.55),
    // 活跃系：活力与开心共同驱动
    active: clamp(0.35 + energy * 0.95 + joy * 0.45),
    // 观察系：平静高时多看多想；害羞时不敢对视
    observe: clamp(0.55 + calm * 0.85 - shy * 0.2 + missing * 0.3),
    // 低位系：活力低（困/累）时爱坐下趴躺
    low: clamp(0.4 + (1 - energy) * 1.15 + calm * 0.35),
    // 困倦系：活力低才打哈欠呼吸慢
    sleepy: clamp(0.3 + (1 - energy) * 1.7),
    // 害羞系：独立组，只在害羞值高时浮现
    shy: clamp(shy * 2.2 - 0.25),
    // 庆祝系：开心冲顶才偶尔出现
    celebrate: clamp(joy * 1.8 - 1.05),
  };
}

function clamp(x) {
  return Math.max(0, Math.min(2.2, x));
}

/**
 * @param {object} deps
 * @param {() => { affinity: number }} deps.getState
 * @param {() => string} [deps.timeBucket]
 * @param {() => number} [deps.now]
 * @param {() => number} [deps.rng]
 */
export function createMoodEngine(deps) {
  const rng = typeof deps.rng === "function" ? deps.rng : Math.random;
  const now = typeof deps.now === "function" ? deps.now : () => Date.now();

  /** @type {MoodVec} */
  let mood = { ...BASE };
  let lastTickAt = now();

  function baseline() {
    const b = { ...BASE };
    const bucket = typeof deps.timeBucket === "function" ? deps.timeBucket() : "";
    const patch = BUCKET_BASE[bucket];
    if (patch) {
      for (const [k, v] of Object.entries(patch)) {
        b[k] = clamp100(b[k] + v);
      }
    }
    // 亲密度越高：开心底色越足、想念底色越重
    const affinity = Math.max(0, Math.min(100, Number(deps.getState?.()?.affinity) || 0));
    b.joy = clamp100(b.joy + (affinity - 40) * 0.12);
    b.missing = clamp100(b.missing + (affinity - 40) * 0.10);
    return b;
  }

  function clamp100(x) {
    return Math.max(0, Math.min(100, x));
  }

  /**
   * 时间推进：向基线回归 + 随机游走。距离上次越久，回归越多步。
   */
  function tick() {
    const t = now();
    const dtMs = Math.max(0, t - lastTickAt);
    lastTickAt = t;
    const steps = Math.min(20, Math.max(1, Math.round(dtMs / 30_000)));
    const base = baseline();

    for (let i = 0; i < steps; i += 1) {
      for (const key of Object.keys(mood)) {
        const decay = DECAY[key] ?? 0.1;
        const drift = DRIFT[key] ?? 2;
        // 向基线回归一步 + 随机游走一步
        mood[key] = mood[key] + (base[key] - mood[key]) * decay;
        mood[key] += (rng() * 2 - 1) * drift;
        mood[key] = clamp100(mood[key]);
      }
    }
    return { ...mood };
  }

  /**
   * 事件脉冲：即时改变情绪（害羞等快维度立即生效）。
   * @param {string} event MOOD_PULSES 的 key
   * @param {{ intensity?: number }} [opts]
   */
  function pulse(event, opts = {}) {
    const p = MOOD_PULSES[event];
    if (!p) return { ...mood };
    const intensity = Math.max(0, Math.min(1, Number(opts.intensity ?? 1)));
    for (const [key, amount] of Object.entries(p)) {
      const jitter = 0.7 + rng() * 0.6; // ±30% 随机
      let delta = amount * intensity * jitter;
      if (delta <= -900) {
        // -999 类哨兵：直接清零（重逢清想念）
        mood[key] = 0;
        continue;
      }
      mood[key] = clamp100(mood[key] + delta);
    }
    return { ...mood };
  }

  /** 当前情绪快照（含动作组偏置，供合成器直接消费） */
  function snapshot() {
    return {
      ...mood,
      groupBias: moodGroupBias(mood),
    };
  }

  /** 主导情绪（用于 UI / 调试 / 语气微调） */
  function dominant() {
    let best = "calm";
    let bestScore = -Infinity;
    const base = baseline();
    for (const key of Object.keys(mood)) {
      const score = mood[key] - (base[key] ?? 0);
      if (score > bestScore) {
        bestScore = score;
        best = key;
      }
    }
    return best;
  }

  return {
    tick,
    pulse,
    snapshot,
    dominant,
    /** 测试用：直接注入情绪 */
    _set(vec) {
      for (const [k, v] of Object.entries(vec || {})) {
        if (k in mood) mood[k] = clamp100(Number(v));
      }
      return { ...mood };
    },
  };
}
