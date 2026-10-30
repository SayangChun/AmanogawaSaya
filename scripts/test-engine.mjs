/**
 * 本地引擎 + 记忆层纯逻辑冒烟测试（node scripts/test-engine.mjs）。
 * 无框架依赖；后续应扩展到 screen-zone / behaviors / memory-store。
 */
import { createMemoryStore } from "../src/memory/memory-store.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createLocalEngine,
  classifyIntent,
  extractUserName,
  parseDueAt,
  extractFactCandidate,
} from "../src/engine/local-engine.js";

let fail = 0;
const t = (name, cond) => {
  console.log(cond ? "PASS" : "FAIL", name);
  if (!cond) fail++;
};

// —— 意图分类 ——
t("greet", classifyIntent("你好呀") === "greet");
t("farewell wins over greet", classifyIntent("晚安") === "farewell");
t("comfort", classifyIntent("今天好累，压力好大") === "comfort");
t("whoAreYou", classifyIntent("你是谁？") === "whoAreYou");
t("userName", classifyIntent("我叫小满") === "userName");
t("fact", classifyIntent("我喜欢看星星") === "fact");
t("plan", classifyIntent("周末要去看流星雨") === "plan");
t("howAreYou", classifyIntent("你在干嘛") === "howAreYou");
t("question", classifyIntent("为什么星星会闪") === "question");
t("statement", classifyIntent("今天上了半天课") === "statement");

// —— 抽取 ——
t("name extract", extractUserName("我叫小满") === "小满");
t("name extract2", extractUserName("我的名字是小满呀") === "小满");
t("name extract none", extractUserName("今天天气不错") === null);
t("fact trim", extractFactCandidate("我喜欢看星星。") === "我喜欢看星星");

// —— 到期时间 ——
const base = new Date(2026, 9, 20, 20, 30).getTime(); // 2026-10-20 周二晚
t("due tomorrow 9am", (() => {
  const d = new Date(parseDueAt("明天要考试", base));
  return d.getDate() === 21 && d.getHours() === 9;
})());
t("due saturday", new Date(parseDueAt("周末出去玩", base)).getDay() === 6);
t("due friday", new Date(parseDueAt("星期五要汇报", base)).getDay() === 5);
t("due fallback", parseDueAt("随便一句", base) > base);

// —— 生成 ——
const engine = createLocalEngine();
const ctx = {
  userName: "小满",
  affinity: 30,
  timeBucket: "night",
  now: base,
  facts: [{ id: "f1", text: "我喜欢看星星", confirmed: true }],
};
const r1 = engine.generateReply("你好", ctx);
t("greet reply", typeof r1.text === "string" && r1.text.length > 0 && !r1.text.includes("{name}"));
const r2 = engine.generateReply("我叫小满", ctx);
t(
  "userName reply",
  r2.updateUserName === "小满" && r2.saveFact === "我的名字是小满" && r2.text.includes("小满"),
);
const r3 = engine.generateReply("周末要去看流星雨", ctx);
t("plan reply", Boolean(r3.startFollowUp) && r3.startFollowUp.dueAt > base && !r3.text.includes("{plan}"));
const r4 = engine.generateReply("好累啊", ctx);
t("comfort", r4.affinityDelta === 2 && r4.expression === "comfort");
let recalled = false;
for (let i = 0; i < 40; i++) {
  // 中性陈述（不含「累」等安慰触发词）
  const r = engine.generateReply("今天上了半天的课，看了很久的星星", ctx);
  if (r.scene === "recall" && r.text.includes("我喜欢看星星")) recalled = true;
}
t("recall injects fact", recalled);
const r5 = engine.generateReply("随便说点什么", { ...ctx, facts: [] });
t("default reply", r5.scene === "chatTalk" && r5.text.length > 0);
const r6 = engine.generateReply("你是谁", ctx);
t("aboutHer", r6.expression === "aboutHer");

// —— 记忆存储（真实落盘临时目录） ——
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "saya-mem-"));
const store = createMemoryStore({ dir: tmpDir });
const ev = store.appendEvent({ role: "user", text: "你好" });
t("append event", Boolean(ev) && ev.role === "user");
t("mood updated on user event", store.snapshot().mood.lastInteractionAt === ev.ts);
const fact = store.addFact("我喜欢看星星", { source: "auto" });
t("add fact", Boolean(fact));
t("remove fact", store.removeFact(fact.id) && store.snapshot().facts.length === 0);
const fu = store.addFollowUp({ text: "周末去看流星雨", dueAt: base });
t("add followup", Boolean(fu) && store.dueFollowUps(base + 1000).length === 1);
t("complete followup", store.completeFollowUp(fu.id) && store.dueFollowUps(base + 1000).length === 0);
t("update mood clamps", store.updateMood({ affinity: 200 }).affinity === 100);
t("journal append", Boolean(store.appendJournal("今天他来了。")));
t("migrate legacy once", store.migrateLegacy({ affinity: 42, userName: "小满" }).ok);
t("migrate legacy twice blocked", !store.migrateLegacy({ affinity: 42 }).ok);
t("migrate name fact", store.snapshot().facts.some((f) => f.text === "我的名字是小满"));
// 压缩
for (let i = 0; i < 260; i++) store.appendEvent({ role: i % 2 ? "user" : "saya", text: `第${i}条` });
const snap = store.snapshot();
t("compaction trims", snap.events.length <= 200 && snap.meta.eventsCompacted > 0);
// 重载持久化
const store2 = createMemoryStore({ dir: tmpDir });
t("persistence reload", store2.snapshot().totalEvents > 0);
fs.rmSync(tmpDir, { recursive: true, force: true });

console.log(fail === 0 ? "ALL PASS" : `${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
