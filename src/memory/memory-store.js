/**
 * 沙夜的记忆层（主进程，CJS——被 main.js require）：
 *   - events.jsonl   事件流：每次对话/互动（全量记录，超出阈值后压缩）
 *   - facts.json     事实卡：关于用户的事（手动/自动提取，confirmed 才注入上下文）
 *   - followups.json 约定跟进：说过以后要处理的事，到期由她主动提起
 *   - mood.json      她的状态：亲密度镜像、精力、想念、最后互动时间
 *   - journal.jsonl  她视角的日记（P3 起由总结生成，P1 预留）
 *   - meta.json      版本/压缩计数/迁移标记
 *
 * 设计约束：零原生依赖（纯 JSON/JSONL）、写入原子化（tmp+rename）、
 * 渲染进程经 IPC 单向访问，主进程是唯一写入口。
 */

const fs = require("node:fs");
const path = require("node:path");

const MEMORY_VERSION = 1;

/** 事件流上限：超过后保留最近 KEEP 条，其余计数进 meta（P3 换摘要） */
const MAX_EVENTS = 240;
const KEEP_EVENTS = 160;
/** 单文件返回给渲染进程的最大条数 */
const TAIL_EVENTS = 60;
const TAIL_JOURNAL = 20;
const MAX_FACTS = 200;
const MAX_FOLLOWUPS = 60;

const EMPTY = {
  events: [],
  facts: [],
  followUps: [],
  mood: { affinity: 12, energy: 0.7, missing: 0, shyness: 0, lastInteractionAt: 0 },
  journal: [],
  meta: { version: MEMORY_VERSION, eventsCompacted: 0, legacyImported: false, createdAt: 0 },
};

/** @typedef {{ ts:number, role:"user"|"saya", text:string, scene?:string, action?:string, affinityDelta?:number }} MemoryEvent */
/** @typedef {{ id:string, text:string, createdAt:number, source:"manual"|"auto", confirmed:boolean }} MemoryFact */
/** @typedef {{ id:string, text:string, dueAt:number, createdAt:number, done:boolean }} MemoryFollowUp */

function genId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function readJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    const raw = fs.readFileSync(file, "utf8");
    if (!raw.trim()) return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(file, data) {
  const tmp = `${file}.tmp`;
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, "utf8");
    fs.renameSync(tmp, file);
  } catch {
    try {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    } catch {
      /* best effort */
    }
  }
}

function appendLine(file, line) {
  try {
    fs.appendFileSync(file, `${JSON.stringify(line)}\n`, "utf8");
  } catch {
    /* ignore quota/permission errors — memory must never kill the app */
  }
}

function readJsonl(file, tailCount) {
  try {
    if (!fs.existsSync(file)) return [];
    const raw = fs.readFileSync(file, "utf8");
    const lines = raw.split("\n").filter((l) => l.trim());
    const out = [];
    for (const l of tailCount > 0 && lines.length > tailCount ? lines.slice(-tailCount) : lines) {
      try {
        out.push(JSON.parse(l));
      } catch {
        /* skip corrupt line */
      }
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * @param {{ dir: string }} opts
 */
function createMemoryStore(opts = {}) {
  const dir = opts.dir;
  const files = {
    events: path.join(dir, "events.jsonl"),
    facts: path.join(dir, "facts.json"),
    followUps: path.join(dir, "followups.json"),
    mood: path.join(dir, "mood.json"),
    journal: path.join(dir, "journal.jsonl"),
    meta: path.join(dir, "meta.json"),
  };

  /** @type {{ events: MemoryEvent[], facts: MemoryFact[], followUps: MemoryFollowUp[], mood: object, journal: any[], meta: object }} */
  let cache = structuredClone(EMPTY);
  cache.meta = { ...EMPTY.meta, createdAt: Date.now() };

  function load() {
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch {
      /* dir may already exist */
    }
    cache.events = readJsonl(files.events, 0);
    cache.facts = readJson(files.facts, []);
    cache.followUps = readJson(files.followUps, []);
    cache.mood = { ...EMPTY.mood, ...readJson(files.mood, {}) };
    cache.journal = readJsonl(files.journal, 0);
    cache.meta = { ...EMPTY.meta, ...readJson(files.meta, {}) };
    if (!Array.isArray(cache.facts)) cache.facts = [];
    if (!Array.isArray(cache.followUps)) cache.followUps = [];
    // 启动时做一次压缩，防止历史无限膨胀
    compactEvents();
  }

  function persistFacts() {
    writeJsonAtomic(files.facts, cache.facts.slice(-MAX_FACTS));
  }
  function persistFollowUps() {
    writeJsonAtomic(files.followUps, cache.followUps.slice(-MAX_FOLLOWUPS));
  }
  function persistMood() {
    writeJsonAtomic(files.mood, cache.mood);
  }

  /** 事件流超限时丢掉最旧的，计数进 meta（不做摘要；P3 接入总结生成） */
  function compactEvents() {
    if (cache.events.length <= MAX_EVENTS) return;
    const dropped = cache.events.length - KEEP_EVENTS;
    cache.events = cache.events.slice(-KEEP_EVENTS);
    cache.meta.eventsCompacted = Number(cache.meta.eventsCompacted || 0) + dropped;
    cache.meta.lastCompactedAt = Date.now();
    writeJsonAtomic(
      files.meta,
      cache.meta,
    );
    // 重写 jsonl 尾部
    try {
      const tmp = `${files.events}.tmp`;
      fs.writeFileSync(
        tmp,
        cache.events.map((e) => `${JSON.stringify(e)}\n`).join(""),
        "utf8",
      );
      fs.renameSync(tmp, files.events);
    } catch {
      /* keep in-memory truth either way */
    }
  }

  function snapshot() {
    const now = Date.now();
    return {
      events: cache.events.slice(-TAIL_EVENTS),
      totalEvents: cache.events.length,
      facts: cache.facts
        .filter((f) => f && typeof f.text === "string")
        .slice(-30)
        .reverse(),
      followUps: cache.followUps.filter((f) => f && !f.done).slice(-30).reverse(),
      mood: { ...cache.mood },
      journal: cache.journal.slice(-TAIL_JOURNAL),
      meta: { ...cache.meta },
      now,
    };
  }

  /**
   * 追加一条事件。返回 null 表示写入失败。
   * @param {Omit<MemoryEvent, "ts"> & { ts?: number }} ev
   * @returns {MemoryEvent | null}
   */
  function appendEvent(ev) {
    if (!ev || typeof ev.text !== "string" || !ev.text.trim()) return null;
    const record = {
      ts: Number.isFinite(ev.ts) ? ev.ts : Date.now(),
      role: ev.role === "user" ? "user" : "saya",
      text: String(ev.text).slice(0, 2000),
      ...(ev.scene ? { scene: String(ev.scene) } : {}),
      ...(ev.action ? { action: String(ev.action) } : {}),
      ...(Number.isFinite(ev.affinityDelta) && ev.affinityDelta
        ? { affinityDelta: Number(ev.affinityDelta) }
        : {}),
    };
    cache.events.push(record);
    appendLine(files.events, record);
    if (record.role === "user") cache.mood.lastInteractionAt = record.ts;
    compactEvents();
    return record;
  }

  /**
   * @param {string} text
   * @param {{ source?: "manual"|"auto", confirmed?: boolean }} [opts]
   * @returns {MemoryFact | null}
   */
  function addFact(text, opts = {}) {
    const clean = String(text || "").trim().slice(0, 200);
    if (!clean) return null;
    const fact = {
      id: genId("fact"),
      text: clean,
      createdAt: Date.now(),
      source: opts.source === "manual" ? "manual" : "auto",
      confirmed: opts.confirmed !== false,
    };
    cache.facts.push(fact);
    persistFacts();
    return fact;
  }

  /** @returns {boolean} */
  function removeFact(id) {
    const before = cache.facts.length;
    cache.facts = cache.facts.filter((f) => f.id !== id);
    if (cache.facts.length === before) return false;
    persistFacts();
    return true;
  }

  /**
   * @param {{ text: string, dueAt: number }} input
   * @returns {MemoryFollowUp | null}
   */
  function addFollowUp(input) {
    const text = String(input?.text || "").trim().slice(0, 200);
    const dueAt = Number(input?.dueAt);
    if (!text || !Number.isFinite(dueAt) || dueAt <= 0) return null;
    const item = { id: genId("fu"), text, dueAt, createdAt: Date.now(), done: false };
    cache.followUps.push(item);
    persistFollowUps();
    return item;
  }

  /** @returns {boolean} */
  function completeFollowUp(id) {
    const item = cache.followUps.find((f) => f.id === id);
    if (!item || item.done) return false;
    item.done = true;
    persistFollowUps();
    return true;
  }

  /** @returns {MemoryFollowUp[]} */
  function dueFollowUps(now = Date.now()) {
    return cache.followUps.filter((f) => !f.done && Number(f.dueAt) <= now);
  }

  /**
   * @param {Partial<typeof EMPTY.mood>} patch
   */
  function updateMood(patch) {
    const next = { ...cache.mood };
    for (const [k, v] of Object.entries(patch || {})) {
      if (v == null) continue;
      if (k === "affinity") next.affinity = Math.max(0, Math.min(100, Number(v) || 0));
      else if (k === "energy" || k === "missing" || k === "shyness") {
        next[k] = Math.max(0, Math.min(1, Number(v) || 0));
      } else if (k === "lastInteractionAt") next[k] = Number(v) || 0;
    }
    cache.mood = next;
    persistMood();
    return { ...cache.mood };
  }

  /** @param {string} text */
  function appendJournal(text) {
    const clean = String(text || "").trim().slice(0, 1000);
    if (!clean) return null;
    const entry = { ts: Date.now(), text: clean };
    cache.journal.push(entry);
    appendLine(files.journal, entry);
    return entry;
  }

  /**
   * 从旧版 localStorage 状态迁移（只跑一次）。
   * @param {{ affinity?: number, userName?: string, totalInteractions?: number }} legacy
   */
  function migrateLegacy(legacy) {
    if (cache.meta.legacyImported) return { ok: false, reason: "already" };
    const affinity = Math.max(0, Math.min(100, Number(legacy?.affinity) || 0));
    updateMood({ affinity, lastInteractionAt: Date.now() });
    const userName = String(legacy?.userName || "").trim();
    if (userName) {
      addFact(`我的名字是${userName}`, { source: "manual", confirmed: true });
    }
    cache.meta.legacyImported = true;
    cache.meta.legacyAt = Date.now();
    if (Number(legacy?.totalInteractions) > 0) {
      cache.meta.legacyInteractions = Number(legacy.totalInteractions);
    }
    writeJsonAtomic(files.meta, cache.meta);
    return { ok: true };
  }

  load();

  return {
    load,
    snapshot,
    appendEvent,
    addFact,
    removeFact,
    addFollowUp,
    completeFollowUp,
    dueFollowUps,
    updateMood,
    appendJournal,
    migrateLegacy,
  };
}

module.exports = { createMemoryStore, MEMORY_VERSION };
