/**
 * 本地对话引擎（离线，纯函数 + 少量实例状态）。
 *
 * 职责：把用户输入 → 意图 → 记忆注入 → 台词 + 表情 + 亲密度变化 +
 * 事实/约定提取建议。不碰 DOM / Electron，可在 node 里直接测。
 * 项目唯一的对话引擎：纯规则匹配，不发任何网络请求，不需要 API Key。
 */

import { speak } from "../character/dialogue.js";
import { getAffinityRank } from "../character/profile.js";

/**
 * @typedef {"greet"|"farewell"|"praise"|"comfort"|"howAreYou"|"whoAreYou"
 *   |"userName"|"fact"|"plan"|"question"|"statement"} Intent
 */

/** 道别优先于问候（「晚安」「早点睡」算道别）。 */
const RULES = [
  { intent: "farewell", re: /(再见|拜拜|晚安|早点睡|去睡|先睡|先走|走了|下线|离开|睡了|bye\b|good\s*night)/i },
  { intent: "comfort", re: /(累|难受|不开心|不高兴|烦|低落|失眠|压力|emo|崩溃|绝望|孤独|想哭|委屈|焦虑|丧|心累|崩溃了|心态崩)/ },
  { intent: "userName", re: /(我叫|我的名字是|叫我|我的名字叫)/ },
  { intent: "whoAreYou", re: /(你是谁|你叫什么|你叫啥|介绍一下你|你的名字|你是什么)/ },
  { intent: "howAreYou", re: /(你在干嘛|在做什么|在干啥|你怎么样|你还好吗|你呢|你过得怎么样|忙吗|想你)/ },
  { intent: "praise", re: /(可爱|厉害|漂亮|好看|喜欢你|棒|温柔|聪明|谢谢|感谢|辛苦你了)/ },
  { intent: "fact", re: /(我喜欢|我爱|我的爱好|兴趣是|生日|我在做|我在学|我在准备|最近在|我的专业|我养了|我最怕|我讨厌|想要)/ },
  {
    intent: "plan",
    re: /((明天|后天|下周|下个月|周末|星期[一二三四五六日天]|月底|月底前|放假|开学|考试|答辩|汇报|面试|体检|旅行|出去玩)[^。！？!?]{0,24}(要|得|去|看|准备|考|交|面试|约|汇报|答辩|买|开始|报名))/,
  },
  { intent: "greet", re: /(^|\s)(hi|hello|嗨|你好|您好|在吗|在么|早上好|午安|晚上好|早啊|早安)/i },
  { intent: "question", re: /[?？]$|^(什么|怎么|为什么|几|谁|哪|吗|呢|是不是|能不能|可不可以|请问)/ },
];

/** 状态问答：按时段回一句「她此刻在做什么」 */
const STATUS_ANSWERS = {
  lateNight: ["……有点困呢。但你还醒着，我就再撑一会儿。", "夜深了。……在陪你，不困。"],
  dawn: ["刚醒。……星星刚下班，我接班。", "清晨的空气很凉。……但看到你，就清醒了。"],
  morning: ["在整理星图。……上午的光很干净，适合记录。", "刚把昨晚的观测写完。……你要看看吗？"],
  forenoon: ["在等你有空的时候。……上午过得很快，对吧。", "在窗边看云。……云走得比想象中慢。"],
  noon: ["在休息。……太阳最高的时候，适合安静待着。", "刚吃完午饭。……唔，只是在发呆。"],
  afternoon: ["在打哈欠。……下午三点，果然还是会困。", "在数桌面上的光斑。……一个一个的，很安静。"],
  evening: ["在看晚霞。……天空从粉红褪成宝蓝，很好看。", "傍晚的风变凉了。……记得加件衣服。"],
  earlyNight: ["在调望远镜。……今晚的云不多，应该能看到东西。", "在等你忙完。……晚上好。"],
  night: ["在观测。……不过你比较好看。", "准备看星星了。……要一起吗？"],
};

/**
 * 意图分类。纯函数。
 * @param {string} input
 * @returns {Intent}
 */
export function classifyIntent(input) {
  const text = String(input || "").trim();
  if (!text) return "statement";
  for (const rule of RULES) {
    if (rule.re.test(text)) return rule.intent;
  }
  return "statement";
}

/**
 * 从自我介绍里抽名字：「我叫XX」「叫我XX」。
 * @param {string} input
 * @returns {string|null}
 */
export function extractUserName(input) {
  const m = String(input || "").match(/(?:我叫|我的名字是|我的名字叫|叫我)\s*[「『"']?([\u4e00-\u9fa5A-Za-z0-9·]{1,12})/);
  if (!m) return null;
  const name = m[1].replace(/[「』』"']/g, "").replace(/[呀啊哦呢吧哈哟]+$/, "").trim();
  return name || null;
}

/**
 * 从闲聊里抽一条事实候选（整句、去尾语气词）。
 * @param {string} input
 * @returns {string|null}
 */
export function extractFactCandidate(input) {
  let text = String(input || "").trim().replace(/[。！？!?~\s]+$/g, "");
  if (!text || text.length < 3) return null;
  if (text.length > 120) text = `${text.slice(0, 120)}…`;
  return text;
}

const WEEKDAY_MAP = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 7, 天: 7 };

/**
 * 解析「约定」的到期时间。取 next 9:00。
 * @param {string} text
 * @param {number} now
 * @returns {number} epoch ms（解析失败返回 now+3d）
 */
export function parseDueAt(text, now = Date.now()) {
  const d = new Date(now);
  const at9 = (date) => {
    date.setHours(9, 0, 0, 0);
    if (date.getTime() <= now) date.setDate(date.getDate() + 1);
    return date.getTime();
  };
  const t = String(text || "");

  if (/周末/.test(t)) {
    const d2 = new Date(now);
    const delta = (6 - d2.getDay() + 7) % 7 || 7; // 最近一个周六（含下周六）
    d2.setDate(d2.getDate() + delta);
    return at9(d2);
  }
  const wd = t.match(/星期([一二三四五六日天])/);
  if (wd) {
    const target = WEEKDAY_MAP[wd[1]];
    const d2 = new Date(now);
    const delta = (target - d2.getDay() + 7) % 7 || 7;
    d2.setDate(d2.getDate() + delta);
    return at9(d2);
  }
  if (/明天/.test(t)) {
    d.setDate(d.getDate() + 1);
    return at9(d);
  }
  if (/后天/.test(t)) {
    d.setDate(d.getDate() + 2);
    return at9(d);
  }
  if (/下个月|下月/.test(t)) {
    d.setMonth(d.getMonth() + 1, 1);
    return at9(d);
  }
  if (/月底/.test(t)) {
    d.setMonth(d.getMonth() + 1, 0);
    return at9(d);
  }
  if (/下周|下星期/.test(t)) {
    d.setDate(d.getDate() + 7);
    return at9(d);
  }
  return at9(new Date(now + 3 * 86400000));
}

/**
 * 抽取约定原文：整句去尾。
 */
function extractPlanText(input) {
  let text = String(input || "").trim().replace(/[。！？!?~\s]+$/g, "");
  if (text.length > 60) text = `${text.slice(0, 60)}…`;
  return text;
}

/**
 * @param {{ speak: typeof speak, getAffinityRank: typeof getAffinityRank }} [io]
 */
export function createLocalEngine(io = {}) {
  const speakFn = io.speak || speak;
  const rankFn = io.getAffinityRank || getAffinityRank;
  let userTurnCount = 0;

  /**
   * @param {string} input 用户原文
   * @param {{
   *   userName?: string,
   *   affinity?: number,
   *   facts?: Array<{ id: string, text: string, confirmed: boolean }>,
   *   mood?: object,
   *   now?: number,
   * }} [ctx]
   * @returns {{
   *   text: string, scene: string, expression: string, affinityDelta: number,
   *   updateUserName?: string, saveFact?: string,
   *   startFollowUp?: { text: string, dueAt: number }
   * }}
   */
  function generateReply(input, ctx = {}) {
    const now = ctx.now ?? Date.now();
    const userName = String(ctx.userName || "").trim();
    const affinity = Number(ctx.affinity) || 0;
    const rank = rankFn(affinity);
    const facts = (ctx.facts || []).filter((f) => f?.confirmed);
    const intent = classifyIntent(input);
    userTurnCount += 1;

    const say = (scene, vars) =>
      speakFn(scene, {
        affinity,
        userName,
        ...(vars ? { vars } : {}),
      });

    /** @type {{ text: string, scene: string, expression: string, affinityDelta: number, updateUserName?: string, saveFact?: string, startFollowUp?: { text: string, dueAt: number } }} */
    const out = { text: "……", scene: "chatTalk", expression: "ponder", affinityDelta: 1 };

    // 用户自我介绍：记住名字
    if (intent === "userName") {
      const name = extractUserName(input);
      if (name) {
        Object.assign(out, {
          text: say("nameSet").text,
          scene: "nameSet",
          expression: "wave",
          affinityDelta: 2,
          updateUserName: name,
          saveFact: `我的名字是${name}`,
        });
        return out;
      }
    }

    // 提取事实候选（除自我介绍外的「我喜欢/我在做」类）
    const factCandidate = intent === "fact" ? extractFactCandidate(input) : null;

    // 提取约定候选（带时间词的未来计划）——优先级高于事实/闪回
    const planCandidate = intent === "plan" ? extractPlanText(input) : null;
    if (planCandidate) {
      const dueAt = parseDueAt(input, now);
      Object.assign(out, {
        text: say("planSaved", { plan: planCandidate }).text,
        scene: "planSaved",
        expression: "nod",
        affinityDelta: 1,
        saveFact: factCandidate || undefined,
        startFollowUp: { text: planCandidate, dueAt },
      });
      return out;
    }

    if (factCandidate) {
      Object.assign(out, {
        text: say("factSaved").text,
        scene: "factSaved",
        expression: "nod",
        affinityDelta: 1,
        saveFact: factCandidate,
      });
      return out;
    }

    // 记忆闪回：只对陈述/提问生效（不抢安慰/夸奖/道别等更强的信号），
    // 第 3 次对话起有概率主动提起用户说过的事。
    if ((intent === "statement" || intent === "question") && facts.length && userTurnCount >= 3 && Math.random() < 0.25) {
      const fact = facts[Math.floor(Math.random() * facts.length)];
      if (fact) {
        Object.assign(out, {
          text: say("recall", { fact: fact.text }).text,
          scene: "recall",
          expression: "recall",
          affinityDelta: 1,
        });
        return out;
      }
    }

    switch (intent) {
      case "comfort":
        Object.assign(out, { text: say("comfort").text, scene: "comfort", expression: "comfort", affinityDelta: 2 });
        break;
      case "praise":
        Object.assign(out, { text: say("chatPraise").text, scene: "chatPraise", expression: "praise", affinityDelta: 2 });
        break;
      case "farewell":
        Object.assign(out, { text: say("farewell").text, scene: "farewell", expression: "farewell", affinityDelta: 1 });
        break;
      case "whoAreYou":
        Object.assign(out, { text: say("aboutHer").text, scene: "aboutHer", expression: "aboutHer", affinityDelta: 1 });
        break;
      case "howAreYou": {
        const bucket = ctx.timeBucket;
        const pool = (bucket && STATUS_ANSWERS[bucket]) || STATUS_ANSWERS.afternoon;
        const line = pool[Math.floor(Math.random() * pool.length)];
        const text = userName && Math.random() < 0.3 ? `${line} ……${userName}呢？` : line;
        Object.assign(out, { text, scene: "chatTalk", expression: "ponder" });
        break;
      }
      case "greet":
        Object.assign(out, { text: say("chatOpen").text, scene: "chatOpen", expression: "wave" });
        break;
      case "question":
        Object.assign(out, {
          text: rank.value >= 40
            ? "唔……我说不好。但你在想这个，我想听下去。"
            : "这个问题有点难。……不过和你一起想，也不坏。",
          scene: "chatTalk",
          expression: "ponder",
        });
        break;
      default:
        Object.assign(out, { text: say("chatTalk").text, scene: "chatTalk", expression: "ponder" });
        break;
    }
    return out;
  }

  return { generateReply, classifyIntent };
}
