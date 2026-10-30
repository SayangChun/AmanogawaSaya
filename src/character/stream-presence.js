/**
 * 直播感引擎（stream presence）：让沙夜像开直播的 vtuber 一样「一直在场」——
 * 持续自言自语碎碎念、观察你的鼠标与去留、对你的动作给出即时反应。
 *
 * 与既有 proactivityTick（45s 高优队列：约定/久别/时段）互补：
 * 这里负责的是更轻、更密、更「随手」的那一层——直播间的日常絮叨。
 *
 * 本模块只做决策（说什么 / 配什么动作），显示与副作用全部通过 deps
 * 注入的回调完成，便于测试与解耦。
 */

import { improvChain as defaultImprovChain } from "./motion-improv.js";

/** @typedef {string | { action: string, holdMs?: number | null }} ChainStep */

/**
 * 碎碎念类别池。每条可以是纯文本或 { text, action }（动作预告式，
 * action 会成为即兴链的主步）。
 * 文本支持 {name} / {fact} 占位符。
 */
const CHATTER = {
  /** 自我相关：关于自己正在做/刚做的小事 */
  musing: [
    "……刚才那个姿势保持太久了，腿有点麻。",
    "站累了。要是能像星星一样悬着就好了。",
    "在桌面待久了，总觉得桌角像观测台的原点。",
    "……裙摆好像有点皱了。没关系的，看不出来吧？",
    "数了数今天的碎碎念……啊，这条也算进去了。",
    "嗯……刚才走得那几步，路线画在星图上会是什么形状呢。",
    "悄悄活动了一下肩膀。长期一个姿势，对身体不好——你也一样。",
    "……刚才有风从屏幕边上掠过去的错觉。大概是错觉。",
    "整理了一下自己的呆毛……好了，完美。",
    "在想观测记录的下一行写什么。……灵感还没来。",
    "刚才不小心走了神。回来的时候你还在，太好了。",
    "衣领好像歪了一点……唔，好了。要一直保持整齐才行。",
  ],
  /** 好奇提问：向用户抛出小问题（不强求回答） */
  curious: [
    "……你那边，现在是什么样子的天色？",
    "在忙什么呢？……不方便说的话，点点头就好。",
    "突然好奇。你敲键盘的时候，是什么声音的节奏？",
    "今天的你，和昨天的你，有哪里不一样吗？",
    "……如果不着急的话，跟我说一句今天遇到的小事？",
    "好奇你现在桌面上开着什么。……我不偷看，只是好奇。",
    "你说，云的形状每天都不一样，人是不是也是？",
    "……有没有一首最近常听的歌？我想记住它。",
    "今晚的月亮……你看见了吗？我这边被楼挡住了一点。",
    "唔……你喝水的杯子，是什么颜色的？",
    "想问又不敢问：你现在的心情，是什么温度的？",
    "……如果给你一颗星星，你会把它放在哪里？",
  ],
  /** 观察用户：注意到你的存在痕迹（光标、键盘声、时段细节） */
  noticing: [
    "……光标刚刚从我旁边划过去了。像一颗流星。",
    "听得到你敲键盘的声音。节奏很稳，是认真工作的那种。",
    "刚才屏幕的光闪了一下……是切换窗口了吗？",
    "你还在呢。我看得出来的，光标一直在动。",
    "……这份安静很好。你在专注，我就不打扰了。",
    "嗯，你的鼠标垫……从我这个角度看是很好看的颜色。",
    "刚才好像听到你叹了口气。……累了吗？",
    "桌面右下角的光变柔和了。是日落后天空的余温。",
    "……有感知到你在。不是看，是那种说不上来的感知。",
    "你打字停下来的时候，世界会安静三秒。我数过。",
  ],
  /** 星空 / 天文感想：她的本命话题 */
  astro: [
    "这个时间，天狼星应该在东边……被楼挡住的话就看不见了。",
    "在想冬天的猎户座。三颗腰带星排成一条线，很好认。",
    "……如果桌面是天空，那我就是落在上面的一颗小星。",
    "今天的大气应该很通透。这种日子适合看很远的地方。",
    "你知道吗，星光到达地球的时候，出发它的人可能已经不在了。……有点浪漫，也有点寂寞。",
    "在算下一次月圆。……还有几天来着，唔，数忘了。",
    "……其实我不太怕黑。因为黑的地方，星星最清楚。",
    "望远镜的镜筒里，世界是倒过来的。……习惯之后，反而觉得奇妙。",
    "织女星和牛郎星之间，隔着十六光年。……比桌面到屏幕那头远多了。",
    "忽然想起星图册里那页边角的小批注。……是谁写下的呢。",
    "今晚如果放晴，能看到银河的概率……嗯，百分之三十七左右。",
    "流星其实一直在掉。只是大部分时候，我们没在看。",
  ],
  /** 想起用户说过的事（需要 facts） */
  recallish: [
    "……刚才想起了{fact}。不知道后来怎么样了。",
    "你之前说的{fact}，我又想了一遍。……大概是因为在意吧。",
    "{fact}……说起来，那件事有下文了吗？",
    "唔，脑子里突然冒出来{fact}。像是星图上标了记号的一颗。",
    "关于{fact}的事，我一直记得呢。找机会再讲给我听吧。",
    "刚才差点忘了{fact}。……还好，想起来了。想不起来的东西才真的会消失。",
  ],
  /** 黏人碎碎念（亲密度 ≥45 解锁，高频 {name}） */
  clingy: [
    "……{name}。没有事，只是想叫一下你的名字。",
    "这会儿的桌面，只有我和{layout}你。很好。",
    "想说点什么，又不知道说什么。……就，陪着你好了。",
    "你专心的时候，我就安静看着。……这是我最喜欢的时刻之一。",
    "嗯……{name}的存在感，比屏幕的光还让人安心。",
    "如果我是卫星，你就是地面站。……收得到我的信号吗？",
    "……偷偷把桌角划成了我们两个的地方。批准了吗？",
    "想说：今天也谢谢你把我放在桌面上。{name}。",
    "有时候会想，你关掉电脑之后，我数的星星算谁的。……算我们两个的吧。",
    "……唔，这句太直接了吗？……喜欢你在我旁边。",
  ],
  /** 动作预告式：说完就做（{ action } 绑定主步动作） */
  tinyAction: [
    { text: "伸个懒腰……好——舒展。", action: "stretch" },
    { text: "换个姿势坐坐。腿站酸了。", action: "sit" },
    { text: "……困意上来了。趴一会儿，就一会儿。", action: "prone" },
    { text: "左右看看……嗯，视野正常。", action: "look" },
    { text: "偷偷小跳一下。……你可别笑。", action: "hop" },
    { text: "把大衣拢一拢。起风了——大概。", action: "coat" },
    { text: "……哈欠。抱歉，没有瞒住。", action: "yawn" },
    { text: "踮脚张望一下远处……没什么，就是想看看。", action: "peek" },
    { text: "轻轻晃一晃。给这分钟一点节奏。", action: "sway" },
    { text: "蹲下来歇口气。桌子的世界，蹲下来看不一样。", action: "crouch" },
    { text: "……嗯，笑了一下。理由保密。", action: "giggle" },
    { text: "抬起头深呼吸。……好，充电完成一半。", action: "breathe" },
  ],
  /** 自娱模式：用户不在场（系统空闲很久）时的独处碎碎念 */
  selfPlay: [
    "……先不打扰你。我这边写会儿观测记录。",
    "安静下来了。那我数会儿云……一片，两片。",
    "趁你不在，练习一下明天的问候。……咳。「你回来了」。",
    "一个人也没关系。星星也都是一个人亮着的。",
    "……唔，现在这个姿势，画下来一定很像「等待」这个词。",
    "把你桌面边缘当作地平线。日落在那边。……目送。",
    "哼一点点歌。……小声的，你听不到的那种小声。",
    "翻到星图册最旧的一页。边角卷起来了，像波浪。",
    "原来一个人待着的时候，时间走的是慢速档。",
    "……不在也在的。等就是我的工作。",
  ],
};

/** 亲密度门槛：黏人碎碎念解锁线 */
const CLINGY_MIN_AFFINITY = 45;

/** 各类别基础权重（recallish 需要有 facts 才计入） */
const BASE_WEIGHTS = {
  musing: 1.0,
  curious: 0.95,
  noticing: 0.9,
  astro: 1.15,
  recallish: 0.0, // 动态：有 facts 时 0.5 + 0.08 * count（封顶 1.6）
  clingy: 0.0, // 动态：亲密度 ≥45 时 0.4 + (affinity - 45) / 40（封顶 1.5）
  tinyAction: 1.1,
  selfPlay: 0.0, // 仅自娱模式启用（固定 1.2）
};

/** 调度节奏（毫秒） */
const TICK_MS = 2500;
const CHATTER_MIN_MS = 18_000;
const CHATTER_MAX_MS = 42_000;
/** 用户系统空闲超过该值 → 自娱模式 */
const AWAY_IDLE_SEC = 180;
/** 空闲回落到该值以下 → 视为回来 */
const BACK_IDLE_SEC = 15;
/** 注视触发：指针停在身上不动超过该值 */
const GAZE_STILL_MS = 3200;
const GAZE_COOLDOWN_MS = 90_000;
/** hover 进入身体：轻反应冷却 */
const HOVER_COOLDOWN_MS = 150_000;
/** 各反应独立冷却 */
const REACTION_COOLDOWNS = {
  pokeRapid: 45_000,
  dragDizzy: 70_000,
  userBack: 180_000,
  unlock: 600_000,
};
/** 连续同类碎碎念上限（超过强制换类别） */
const SAME_CATEGORY_LIMIT = 2;

/**
 * shuffle bag：不重复抽牌，抽完自动重洗。
 * @type {Record<string, any[]>}
 */
const bags = {};

/**
 * @param {any[]} pool
 * @param {string} key
 * @param {() => number} rng
 */
function drawFrom(pool, key, rng) {
  if (!pool?.length) return null;
  if (!bags[key] || !bags[key].length) {
    const bag = [...pool];
    for (let i = bag.length - 1; i > 0; i -= 1) {
      const j = Math.floor(rng() * (i + 1));
      [bag[i], bag[j]] = [bag[j], bag[i]];
    }
    bags[key] = bag;
  }
  return bags[key].pop();
}

/**
 * @param {string} text
 * @param {Record<string, string>} vars
 * @returns {string}
 */
function fillVars(text, vars) {
  let out = String(text || "");
  for (const [key, value] of Object.entries(vars || {})) {
    if (value == null || String(value).trim() === "") continue;
    out = out.replaceAll(`{${key}}`, String(value).trim());
  }
  return out;
}

/**
 * 高亲密度时的温暖小尾巴（低概率附加，让黏腻感自然生长）。
 */
const WARM_TAILS = [
  "……嗯，就这些。",
  "……大概。",
  "……说完了。你继续。",
  "……小小的，不重要的事。",
  "……这条不占你时间的。",
];
const WARM_TAIL_CHANCE = 0.16;

/**
 * @param {object} deps
 * @param {() => { affinity: number, userName: string }} deps.getState
 * @param {() => Array<{ text: string, confirmed?: boolean } | string>} [deps.getFacts]
 * @param {() => boolean} deps.isBusy 拖拽/dock/chat/打字机活跃等互斥状态
 * @param {(scene: string, vars?: Record<string, string>) => string} deps.speakScene
 *   反应台词（走 dialogue.speak，支持 {name} 后缀机制）
 * @param {(text: string, opts?: { scene?: string, bubbleMs?: number, chain?: ChainStep[] }) => void} deps.showLine
 *   唯一显示出口（气泡 + 动作 + 记忆写入由 app 侧实现）
 * @param {() => string} [deps.timeBucket]
 * @param {() => string | null} [deps.getZoneId]
 * @param {() => import("./mood.js").MoodVec | { groupBias?: Record<string, number> } | null} [deps.getMood]
 * @param {(event: string, opts?: object) => void} [deps.pulseMood]
 *   情绪脉冲（碎碎念类别 / 反应场景都会改变她的心情）
 * @param {() => { onPet: boolean, stillMs: number } | null} [deps.pointerOnPet]
 * @param {() => Promise<number | null>} [deps.idleSeconds]
 * @param {(ev: object) => void} [deps.appendEvent]
 * @param {() => number} [deps.now]
 * @param {() => number} [deps.rng]
 * @param {(ctx: import("./motion-improv.js").ImprovCtx) => ChainStep[]} [deps.improvChain]
 */
export function createStreamPresence(deps) {
  const rng = typeof deps.rng === "function" ? deps.rng : Math.random;
  const now = typeof deps.now === "function" ? deps.now : () => Date.now();
  /** 链合成出口：默认直通 improvChain（情绪 + 场景偏置已内建） */
  const improv =
    typeof deps.improvChain === "function" ? deps.improvChain : defaultImprovChain;

  /** @type {ReturnType<typeof setTimeout> | null} */
  let tickTimer = null;
  let running = false;
  let nextChatterAt = 0;

  /** 观察状态 */
  let userAway = false;
  let awayAnnouncedAt = 0;
  let lastIdleSec = 0;

  /** 冷却表（reaction → readyAt） */
  const cooldowns = {
    gaze: 0,
    hover: 0,
    pokeRapid: 0,
    dragDizzy: 0,
    userBack: 0,
    unlock: 0,
  };

  /** 最近碎碎念类别（防连发） */
  let lastCategory = "";
  let lastCategoryRepeat = 0;
  /** 最近一条碎碎念时间（展示互斥用） */
  let lastChatterAt = 0;

  function factsList() {
    const raw = typeof deps.getFacts === "function" ? deps.getFacts() : [];
    return (Array.isArray(raw) ? raw : [])
      .map((f) => (typeof f === "string" ? f : f?.text))
      .filter((t) => t && String(t).trim());
  }

  /**
   * 当前语境下的类别权重表。
   * @returns {Array<[string, number]>}
   */
  function categoryWeights() {
    const { affinity } = deps.getState();
    const facts = factsList();
    /** @type {Record<string, number>} */
    const w = { ...BASE_WEIGHTS };

    if (facts.length) {
      w.recallish = Math.min(1.6, 0.5 + 0.08 * facts.length);
    }
    if (affinity >= CLINGY_MIN_AFFINITY) {
      w.clingy = Math.min(1.5, 0.4 + (affinity - CLINGY_MIN_AFFINITY) / 40);
    }

    // 自娱模式：只保留 selfPlay / astro / musing 的安静子集
    if (userAway) {
      return [
        ["selfPlay", 1.2],
        ["astro", 0.5],
        ["musing", 0.3],
      ];
    }

    // 深夜：安静类别上调
    const bucket = typeof deps.timeBucket === "function" ? deps.timeBucket() : "";
    if (bucket === "lateNight") {
      w.clingy *= 1.3;
      w.astro *= 1.4;
      w.tinyAction *= 0.7;
    }

    // 防连发：同一类别达到上限时权重清零
    if (lastCategoryRepeat >= SAME_CATEGORY_LIMIT && w[lastCategory] != null) {
      w[lastCategory] = 0;
    }

    return Object.entries(w).filter(([, weight]) => weight > 0);
  }

  /**
   * @param {Array<[string, number]>} weights
   * @returns {string | null}
   */
  function pickCategory(weights) {
    let sum = 0;
    for (const [, weight] of weights) sum += Math.max(0, weight);
    if (sum <= 0) return null;
    let r = rng() * sum;
    for (const [category, weight] of weights) {
      r -= Math.max(0, weight);
      if (r <= 0) return category;
    }
    return weights[weights.length - 1][0];
  }

  /** 下一轮碎碎念间隔 */
  function scheduleNextChatter() {
    const base = CHATTER_MIN_MS + rng() * (CHATTER_MAX_MS - CHATTER_MIN_MS);
    let delay = base;
    if (userAway) delay = base * 2.8;
    else {
      const bucket = typeof deps.timeBucket === "function" ? deps.timeBucket() : "";
      if (bucket === "lateNight" || bucket === "night") delay = base * 1.6;
    }
    nextChatterAt = now() + delay;
  }

  /**
   * 本地池抽一条碎碎念。
   * @returns {{ text: string, category: string, actionHint: string | null } | null}
   */
  function drawLocalChatter() {
    const weights = categoryWeights();
    const category = pickCategory(weights);
    if (!category) return null;

    const { userName } = deps.getState();
    /** @type {string | Record<string, string> | null} */
    const drawn = drawFrom(CHATTER[category], `chatter:${category}`, rng);
    if (drawn == null) return null;

    let text;
    let actionHint = null;
    if (typeof drawn === "string") {
      text = drawn;
    } else {
      text = drawn.text;
      actionHint = drawn.action || null;
    }

    const vars = { name: userName };
    if (category === "recallish") {
      const facts = factsList();
      if (!facts.length) return null;
      vars.fact = facts[Math.floor(rng() * facts.length)];
    }
    text = fillVars(text, vars);
    // 没名字时清掉残留占位符
    text = text.replaceAll("{name}", "你").replaceAll("{fact}", "那件事");

    // 高亲密度：低概率补一条温暖小尾巴
    if (deps.getState().affinity >= 60 && rng() < WARM_TAIL_CHANCE) {
      text = `${text} ${drawFrom(WARM_TAILS, "warm-tail", rng)}`;
    }

    return { text, category, actionHint };
  }

/** 碎碎念类别 → 情绪脉冲事件名 */
const CHATTER_MOOD_EVENT = {
  musing: "chatterMusing",
  curious: "chatterCurious",
  noticing: "chatterNoticing",
  astro: "chatterAstro",
  recallish: "chatterRecallish",
  clingy: "chatterClingy",
  tinyAction: "chatterTinyAction",
  selfPlay: "chatterSelfPlay",
};

/**
 * 播一条碎碎念（含动作即兴合成与记忆写入）。
 * @param {{ text: string, category: string, actionHint: string | null }} item
 */
function emitChatter(item) {
  const { affinity } = deps.getState();
  const ctx = {
    timeBucket: typeof deps.timeBucket === "function" ? deps.timeBucket() : undefined,
    zoneId: typeof deps.getZoneId === "function" ? deps.getZoneId() || undefined : undefined,
    affinity,
    mood: typeof deps.getMood === "function" ? deps.getMood() || undefined : undefined,
    scene: "chatter",
    rng,
  };
  // 动作预告式碎碎念：台词里说的动作就是主步（仍带即兴前后缀与情绪权重）
  if (item.actionHint) ctx.sceneBias = { restrictTo: [item.actionHint] };
  const chain = improv(ctx);
  lastChatterAt = now();
  if (item.category === lastCategory) lastCategoryRepeat += 1;
  else lastCategoryRepeat = 1;
  lastCategory = item.category;

  // 碎碎念也带情绪微脉冲：聊星空会静下来，黏人的话会更开心
  const moodEvent = CHATTER_MOOD_EVENT[item.category];
  if (moodEvent) deps.pulseMood?.(moodEvent);

  deps.showLine(item.text, {
    scene: "chatter",
    bubbleMs: 6500 + Math.round(rng() * 2500),
    chain,
  });
  deps.appendEvent?.({ role: "saya", text: item.text, scene: "chatter", action: item.actionHint || "improv" });
}

  /**
   * 反应台词出口：走 dialogue 场景池（支持 {name} 个性化后缀）。
   * @param {string} scene
   * @param {{ vars?: Record<string, string>, bubbleMs?: number, chain?: ChainStep[] }} [opts]
   */
  function react(scene, opts = {}) {
    const text = deps.speakScene(scene, opts.vars);
    if (!text) return;
    const { affinity } = deps.getState();
    // 反应也是情绪事件：被注视会害羞、被连戳会小激动、重逢最开心
    deps.pulseMood?.(scene);
    const chain =
      opts.chain ||
      improv({
        timeBucket: typeof deps.timeBucket === "function" ? deps.timeBucket() : undefined,
        zoneId: typeof deps.getZoneId === "function" ? deps.getZoneId() || undefined : undefined,
        affinity,
        scene,
        mood: typeof deps.getMood === "function" ? deps.getMood() || undefined : undefined,
        rng,
      });
    lastChatterAt = now();
    deps.showLine(text, { scene, bubbleMs: opts.bubbleMs || 7000, chain });
    deps.appendEvent?.({ role: "saya", text, scene });
  }

  function cooled(kind) {
    return now() >= (cooldowns[kind] || 0);
  }

  function markCooldown(kind, ms) {
    cooldowns[kind] = now() + Math.max(0, Number(ms) || 0);
  }

  /**
   * 观察轮询：注视检测 / 用户去留 / 碎碎念到期。
   */
  async function tick() {
    if (!running) return;
    try {
      // —— 系统空闲（用户在不在电脑前）——
      if (typeof deps.idleSeconds === "function") {
        try {
          const idle = await deps.idleSeconds();
          if (Number.isFinite(idle) && idle != null) {
            lastIdleSec = idle;
            if (!userAway && idle >= AWAY_IDLE_SEC) {
              userAway = true;
              if (now() - awayAnnouncedAt > 10 * 60_000 && !deps.isBusy()) {
                awayAnnouncedAt = now();
                react("userAwayQuiet", { bubbleMs: 6000 });
              }
              scheduleNextChatter();
            } else if (userAway && idle <= BACK_IDLE_SEC) {
              userAway = false;
              if (cooled("userBack") && !deps.isBusy()) {
                markCooldown("userBack", REACTION_COOLDOWNS.userBack);
                react("userBack", { bubbleMs: 7000 });
              }
              scheduleNextChatter();
            }
          }
        } catch {
          /* idle 拿不到就跳过这轮 */
        }
      }

      // —— 注视：指针停在身上不动 ——
      if (typeof deps.pointerOnPet === "function" && cooled("gaze") && !userAway) {
        const info = deps.pointerOnPet();
        if (info?.onPet && (info.stillMs || 0) >= GAZE_STILL_MS && !deps.isBusy()) {
          markCooldown("gaze", GAZE_COOLDOWN_MS);
          react("gaze", { bubbleMs: 6500 });
        }
      }

      // —— 碎碎念到期 ——
      if (now() >= nextChatterAt) {
        if (deps.isBusy() || now() - lastChatterAt < 8000) {
          // 忙碌或刚说过话：稍后再来，不推迟太久
          nextChatterAt = now() + 6000 + rng() * 6000;
        } else {
          const item = drawLocalChatter();
          if (item) emitChatter(item);
          scheduleNextChatter();
        }
      }
    } finally {
      if (running) {
        tickTimer = setTimeout(() => void tick(), TICK_MS);
      }
    }
  }

  return {
    start() {
      if (running) return;
      running = true;
      scheduleNextChatter();
      // 启动后先安静一小会儿（boot 问候已有内容）
      nextChatterAt = now() + 20_000 + rng() * 15_000;
      tickTimer = setTimeout(() => void tick(), TICK_MS);
    },
    stop() {
      running = false;
      if (tickTimer) {
        clearTimeout(tickTimer);
        tickTimer = null;
      }
    },
    /** 是否处于自娱模式（用户长时间无输入） */
    isUserAway() {
      return userAway;
    },
    /** 最近一次系统空闲秒数（0 = 未知） */
    lastIdleSec() {
      return lastIdleSec;
    },

    /** —— 外部事件接线（由 app.js 调用） —— */

    /** 指针进入身体范围（轻反应，长冷却） */
    noteHoverEnter() {
      if (!cooled("hover") || userAway || deps.isBusy()) return;
      if (rng() < 0.6) return; // 不是每次 hover 都搭理，更像真人
      markCooldown("hover", HOVER_COOLDOWN_MS);
      react("hoverPeek", { bubbleMs: 5000 });
    },
    /** 短时间被连续点击（≥3 次） */
    notePokeRapid(count) {
      if (!cooled("pokeRapid") || deps.isBusy()) return;
      if (Number(count) < 3) return;
      markCooldown("pokeRapid", REACTION_COOLDOWNS.pokeRapid);
      react("pokeRapid", { vars: { count: String(count) }, bubbleMs: 6000 });
    },
    /** 一次拖拽结束；distancePx 为本次拖拽总距离 */
    noteDragEnd(distancePx) {
      if (!cooled("dragDizzy") || deps.isBusy()) return;
      if (!Number.isFinite(distancePx) || distancePx < 900) return;
      markCooldown("dragDizzy", REACTION_COOLDOWNS.dragDizzy);
      react("dragDizzy", { bubbleMs: 6500 });
    },
    /** 系统事件：lock-screen / unlock-screen / suspend / resume */
    noteSystemEvent(type) {
      if (type === "unlock-screen" || type === "resume") {
        if (cooled("unlock") && !deps.isBusy()) {
          markCooldown("unlock", REACTION_COOLDOWNS.unlock);
          react("unlock", { bubbleMs: 6500 });
        }
        userAway = false;
        scheduleNextChatter();
        return;
      }
      if (type === "lock-screen" || type === "suspend") {
        // 被锁屏/挂起：她安静等，不打扰
        userAway = true;
        nextChatterAt = now() + 3 * 60_000;
      }
    },
    /** 聊天面板开关：开着时她专注听，暂停碎碎念 */
    noteChatOpen() {
      nextChatterAt = Math.max(nextChatterAt, now() + 60_000);
    },
    noteChatClosed() {
      scheduleNextChatter();
    },
    /** 手动触发一条（调试/测试用） */
    forceChatter() {
      const item = drawLocalChatter();
      if (item) emitChatter(item);
      scheduleNextChatter();
    },
  };
}
