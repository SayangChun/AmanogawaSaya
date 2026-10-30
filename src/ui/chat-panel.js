/**
 * 伴侣聊天面板：输入行 + 历史回显 + 打字机。
 * 纯渲染/输入层；对话管线（引擎/记忆/亲密度）由 app.js 编排后经 deps 回调进来。
 */

/** 基础出字速度 + 随机抖动；停顿按标点分级（她的「……」是最慢的语气） */
const CHAR_MS = 42;
const CHAR_JITTER_MS = 18;

/**
 * 人声节奏：不同标点的停顿分级，像一边想一边说。
 * 「……」（她的标志性语气）拖得最久，「。！？」其次，逗号顿一下。
 * @param {string} ch
 * @param {number} charMs
 * @returns {number}
 */
function delayForChar(ch, charMs) {
  if (ch === "…") return 260;
  if ("。！？".includes(ch)) return 240;
  if ("，,；;".includes(ch)) return 150;
  if ("—~～".includes(ch)) return 180;
  if ("、".includes(ch)) return 110;
  // 出字速度随机抖动，避免机械匀速
  return charMs + (Math.random() * 2 - 1) * CHAR_JITTER_MS;
}

/**
 * 逐字输出到目标元素。返回 { start, skip, isActive }。
 * @param {HTMLElement | (() => HTMLElement|null) | null} el 元素或惰性取值函数
 * @param {{ charMs?: number, onDone?: () => void }} [opts]
 */
export function createTypewriter(el, opts = {}) {
  const charMs = opts.charMs ?? CHAR_MS;
  const resolveEl = () => (typeof el === "function" ? el() : el);
  let full = "";
  let shown = 0;
  let timer = /** @type {ReturnType<typeof setTimeout> | null} */ (null);
  let finished = true;

  function clear() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function paint() {
    const target = resolveEl();
    if (!target) return;
    target.textContent = full.slice(0, shown);
    target.classList.toggle("is-typing", !finished);
  }

  function finish() {
    clear();
    if (finished) return;
    finished = true;
    shown = full.length;
    paint();
    opts.onDone?.();
  }

  function step() {
    timer = null;
    if (shown >= full.length) {
      finish();
      return;
    }
    const ch = full[shown];
    shown += 1;
    paint();
    timer = setTimeout(step, delayForChar(ch, charMs));
  }

  function start(text) {
    clear();
    full = String(text || "");
    shown = 0;
    finished = false;
    paint();
    if (!full) {
      finish();
      return;
    }
    timer = setTimeout(step, charMs);
  }

  function stop() {
    clear();
    finished = true;
  }

  return { start, skip: finish, stop, isActive: () => !finished };
}

/**
 * @param {{
 *   onSend: (text: string) => void | Promise<void>,
 *   onRemember: (text: string) => void | Promise<void>,
 *   onClose: () => void,
 * }} deps
 */
export function createChatPanel(deps) {
  let root = null;
  let input = null;
  let scroll = null;

  function cacheEls() {
    root = document.querySelector("#chat-panel");
    input = document.querySelector("#chat-input");
    scroll = document.querySelector("#chat-scroll");
  }

  function send() {
    if (!input) return;
    const text = input.value.trim();
    if (!text) return;
    input.value = "";
    void deps.onSend(text);
  }

  function bind() {
    cacheEls();
    const sendBtn = document.querySelector("#chat-send");
    const rememberBtn = document.querySelector("#chat-remember");
    const closeBtn = document.querySelector("#chat-close");
    if (sendBtn) {
      sendBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        send();
      });
    }
    if (rememberBtn) {
      rememberBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        const text = input?.value.trim();
        if (text) void deps.onRemember(text);
      });
    }
    if (closeBtn) {
      closeBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        deps.onClose();
      });
    }
    if (input) {
      input.addEventListener("keydown", (e) => {
        e.stopPropagation();
        if (e.key === "Enter") {
          e.preventDefault();
          send();
        }
      });
      // 输入框内点击/拖动不应触发桌宠拖动
      input.addEventListener("pointerdown", (e) => e.stopPropagation());
    }
  }

  /** 打开时渲染历史回显（app.js 从记忆事件里取最近若干条） */
  function renderScrollback(rows) {
    cacheEls();
    if (!scroll) return;
    scroll.textContent = "";
    if (!rows?.length) {
      const empty = document.createElement("div");
      empty.className = "chat-empty";
      empty.textContent = "……想说什么都可以。";
      scroll.appendChild(empty);
      return;
    }
    for (const row of rows) appendRow(row.role, row.text, { scroll: false });
    scrollToBottom();
  }

  function appendRow(role, text, { scroll = true } = {}) {
    cacheEls();
    if (!scroll) return;
    const empty = scroll.querySelector(".chat-empty");
    if (empty) empty.remove();
    const div = document.createElement("div");
    div.className = `chat-msg ${role === "user" ? "user" : "saya"}`;
    div.textContent = String(text || "");
    scroll.appendChild(div);
    if (scroll) scrollToBottom();
  }

  function scrollToBottom() {
    if (scroll) scroll.scrollTop = scroll.scrollHeight;
  }

  function focus() {
    cacheEls();
    input?.focus();
  }

  function blur() {
    cacheEls();
    input?.blur();
  }

  return { bind, renderScrollback, appendRow, focus, blur };
}
