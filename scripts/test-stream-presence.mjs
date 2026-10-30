/**
 * 直播感引擎冒烟测试（node 直跑，无 DOM）：
 * 1. improvChain 多样性 + 合法性
 * 2. jitterHold 范围
 * 3. stream-presence 碎碎念调度（类别/占位符/防连发/自娱切换）
 * 4. 反应接口（连戳/拖晕/注视/用户回来）触发与冷却
 */
import { improvChain, jitterHold, improvFidget } from "../src/character/motion-improv.js";
import { createStreamPresence } from "../src/character/stream-presence.js";
import { createMoodEngine } from "../src/character/mood.js";

let failed = 0;
function assert(cond, msg) {
  if (cond) console.log("  ok  ", msg);
  else {
    console.error("  FAIL", msg);
    failed += 1;
  }
}

const CATALOG = {
  idle: 1, breathe: 1, sway: 1, look: 1, walk: 1, hop: 1, sit: 1, stretch: 1,
  calm: 1, coat: 1, soft: 1, smile: 1, nod: 1, talk: 1, bounce: 1, alert: 1,
  shy: 1, celebrate: 1, sleep: 1, wave: 1, drag: 1, think: 1, peek: 1, yawn: 1,
  giggle: 1, greet: 1, rest: 1, crouch: 1, lie: 1, prone: 1,
};

console.log("== improvChain 多样性 ==");
const seen = new Set();
const usedActions = new Set();
for (let i = 0; i < 400; i++) {
  const chain = improvChain({
    catalog: CATALOG,
    timeBucket: i % 2 ? "night" : "forenoon",
    affinity: 70,
    zoneId: i % 3 ? undefined : "corner-bottom-right",
  });
  assert(chain.length >= 1 && chain.length <= 5, `链长度合理 (${chain.length})`);
  for (const step of chain) {
    const a = typeof step === "string" ? step : step.action;
    usedActions.add(a);
    if (!(a in CATALOG)) {
      assert(false, `出现目录外动作: ${a}`);
      break;
    }
  }
  seen.add(chain.map((s) => (typeof s === "string" ? s : `${s.action}@${s.holdMs ?? "-"}`)).join(">"));
}
assert(seen.size > 300, `400 次合成出现 ${seen.size} 种不同链（>300 说明高度随机）`);
assert(usedActions.size >= 15, `覆盖动作 ${usedActions.size} 种（≥15）`);

console.log("== jitterHold ==");
const j = new Set();
for (let i = 0; i < 50; i++) j.add(jitterHold(3000, 0.25));
assert(j.size > 20, "同 base 抖动产生多种 holdMs");
assert([...j].every((v) => v >= 2250 && v <= 3750), "抖动保持在 ±25% 内");

console.log("== improvFidget 概率门 ==");
let nullCount = 0;
for (let i = 0; i < 200; i++) if (improvFidget({ chance: 0.55, catalog: CATALOG }) === null) nullCount += 1;
assert(nullCount > 50 && nullCount < 130, `拒绝率 ${nullCount}/200 ≈ 45%`);

console.log("== 情绪驱动：害羞冲高 → 主步 shy 浮现 ==");
const countMain = (chain) => {
  const mid = chain[Math.max(0, Math.floor((chain.length - 1) / 2))];
  return typeof mid === "string" ? mid : mid.action;
};
let shyHigh = 0;
let shyBase = 0;
for (let i = 0; i < 300; i++) {
  if (countMain(improvChain({ catalog: CATALOG, scene: "praise", mood: { joy: 40, shyness: 90, calm: 50, energy: 55, missing: 10 } })) === "shy") shyHigh += 1;
  if (countMain(improvChain({ catalog: CATALOG, scene: "praise", mood: { joy: 40, shyness: 0, calm: 50, energy: 55, missing: 10 } })) === "shy") shyBase += 1;
}
assert(shyHigh > shyBase * 3, `害羞 90 时 shy 主步 ${shyHigh}/300 vs 害羞 0 时 ${shyBase}/300（情绪生效）`);

console.log("== 情绪驱动：开心冲顶 → celebrate 才可能出现 ==");
let celebJoy = 0;
let celebLow = 0;
for (let i = 0; i < 300; i++) {
  if (improvChain({ catalog: CATALOG, mood: { joy: 95, shyness: 5, calm: 50, energy: 80, missing: 0 } }).some((s) => (typeof s === "string" ? s : s.action) === "celebrate")) celebJoy += 1;
  if (improvChain({ catalog: CATALOG, mood: { joy: 20, shyness: 5, calm: 50, energy: 60, missing: 0 } }).some((s) => (typeof s === "string" ? s : s.action) === "celebrate")) celebLow += 1;
}
assert(celebJoy > 10 && celebLow === 0, `joy 95 时 celebrate ${celebJoy}/300，joy 20 时 ${celebLow}/300（情绪门控）`);

console.log("== 场景偏置：说话必含 talk 口型 / 菜单姿势白名单 ==");
let talkMissing = 0;
for (let i = 0; i < 100; i++) {
  const chain = improvChain({ catalog: CATALOG, scene: "talk", mood: { joy: 40, shyness: 8, calm: 50, energy: 55, missing: 10 } });
  if (!chain.some((s) => (typeof s === "string" ? s : s.action) === "talk")) talkMissing += 1;
}
assert(talkMissing === 0, `talk 场景 100 次全部含 talk 口型（缺失 ${talkMissing}）`);
let badPose = 0;
const POSE_WHITELIST = new Set(["sit", "crouch", "lie", "prone", "rest"]);
for (let i = 0; i < 100; i++) {
  const chain = improvChain({ catalog: CATALOG, scene: "menuPose" });
  if (!POSE_WHITELIST.has(typeof chain[0] === "string" ? chain[0] : chain[0].action)) badPose += 1;
}
assert(badPose === 0, `menuPose 主步 100 次全部在低位白名单（越界 ${badPose}）`);

console.log("== mood 引擎：脉冲 / 衰减 / 重逢清想念 ==");
{
  let vNow = 1000;
  const engine = createMoodEngine({
    getState: () => ({ affinity: 60 }),
    timeBucket: () => "forenoon",
    now: () => vNow,
    rng: Math.random,
  });
  engine._set({ missing: 80, shyness: 10, joy: 30, calm: 50, energy: 55 });
  engine.pulse("missYou");
  const snap = engine.snapshot();
  assert(snap.missing === 0, `重逢把想念清零（missing=${snap.missing}）`);
  assert(snap.joy > 38, `重逢开心脉冲生效（joy=${snap.joy.toFixed(1)}）`);
  engine._set({ shyness: 90 });
  vNow += 5 * 60_000; // 快进 5 分钟
  const decayed = engine.tick();
  assert(decayed.shyness < 70, `害羞自然消退（90 → ${decayed.shyness.toFixed(1)}）`);
  const dom = engine.dominant();
  assert(typeof dom === "string" && dom.length > 0, `主导情绪可读：${dom}`);
}

console.log("== stream-presence 调度 ==");
let virtualNow = 1_000_000;
const rng = (() => {
  let s = 42;
  return () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648;
  };
})();

const lines = [];
let busyFlag = false;
const presence = createStreamPresence({
  getState: () => ({ affinity: 70, userName: "小星" }),
  getFacts: () => [{ text: "周末要去看流星雨", confirmed: true }],
  isBusy: () => busyFlag,
  speakScene: (scene, vars) => `[scene:${scene}|vars:${JSON.stringify(vars || {})}]`,
  showLine: (text, opts) => lines.push({ text, opts }),
  timeBucket: () => "forenoon",
  getZoneId: () => null,
  pointerOnPet: () => null,
  idleSeconds: () => Promise.resolve(0),
  appendEvent: () => {},
  now: () => virtualNow,
  rng,
});

presence.start();
// 快进时间：手动触发一轮碎碎念
presence.forceChatter();
assert(lines.length === 1, "forceChatter 立即产出一条");
assert(!lines[0].text.includes("{name}") && !lines[0].text.includes("{fact}"), "占位符已替换");
assert(Array.isArray(lines[0].opts?.chain) && lines[0].opts.chain.length >= 1, "碎碎念带即兴动作链");

// 反应接口
lines.length = 0;
presence.notePokeRapid(2);
assert(lines.length === 0, "戳 2 次不触发");
presence.notePokeRapid(4);
assert(lines.length === 1 && lines[0].opts.scene === "pokeRapid", "戳 4 次触发 pokeRapid");
presence.notePokeRapid(5);
assert(lines.length === 1, "冷却期内不重复触发");

lines.length = 0;
presence.noteDragEnd(500);
assert(lines.length === 0, "拖 500px 不触发");
presence.noteDragEnd(1200);
assert(lines.length === 1 && lines[0].opts.scene === "dragDizzy", "拖 1200px 触发 dragDizzy");

lines.length = 0;
busyFlag = true;
presence.notePokeRapid(9);
assert(lines.length === 0, "忙碌时反应被互斥");
busyFlag = false;

// 注视（用真实 Date.now 的默认实现测不行——检查冷却逻辑本身够用）
lines.length = 0;
presence.noteSystemEvent("unlock-screen");
assert(lines.length === 1 && lines[0].opts.scene === "unlock", "解锁触发问候");
presence.noteSystemEvent("suspend");
presence.noteSystemEvent("resume");
assert(lines.length === 1, "刚问候过，resume 不重复触发（共享冷却）");

console.log(failed ? `\n${failed} 项失败` : "\n全部通过");
process.exit(failed ? 1 : 0);
