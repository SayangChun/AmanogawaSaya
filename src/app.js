import { CHARACTER, getAffinityRank } from "./character/profile.js";
import { speak, timeBucket } from "./character/dialogue.js";
import { createMotionController } from "./character/motion.js";
import { createWanderController } from "./character/wander.js";
import { loadState, saveState, gainAffinity } from "./state.js";

const app = document.querySelector("#app");
const motion = createMotionController();

const DRAG_THRESHOLD_PX = 4;
const CLICK_SUPPRESS_MS = 500;

/** @type {ReturnType<typeof loadState>} */
let state = loadState();
let currentLine = state.lastLine || "";
let currentScene = state.lastScene || "boot";

let autoWanderEnabled = true;
let menuOpen = false;

/**
 * Stage focus: keep dock / panel chrome off.
 * Speech bubble is shown — companion lines appear in the floating window.
 */
const UI_MINIMAL = true;
/** When true, dialogue bubble is rendered even in minimal stage mode. */
const SHOW_BUBBLE = true;
let bubbleOpen = false;
let bubbleHideTimer = null;
/**
 * Active pointer session on the pet.
 * @type {null | {
 *   pointerId: number,
 *   lastX: number,
 *   lastY: number,
 *   startX: number,
 *   startY: number,
 *   moved: boolean,
 * }}
 */
let drag = null;
/** True only after movement exceeds threshold (real window drag). */
let isDragging = false;
/** True from pointerdown until fully released — blocks mode enlarge. */
let pointerArmed = false;
let suppressClickUntil = 0;
/** @type {null | (() => void)} */
let pendingAfterDrag = null;

function isPointerBlocked() {
  return isDragging || pointerArmed || Date.now() < suppressClickUntil;
}

const wander = createWanderController({
  motion,
  moveBy: (delta) => window.petApi?.moveBy?.(delta),
  getBounds: () => window.petApi?.bounds?.() ?? Promise.resolve(null),
  getWorkArea: () => window.petApi?.workArea?.() ?? Promise.resolve(null),
  // Only real drag sessions block locomotion — not post-drag click suppress.
  isBlocked: () => isDragging || pointerArmed,
  onRoamStart: (_kind) => {
    if (Math.random() < 0.15 && !bubbleOpen) {
      const line = speak(timeBucket(), { affinity: state.affinity });
      currentLine = line.text;
      openBubble(4500);
    }
  },
});

function setDraggingLock(on) {
  window.petApi?.setDragging?.(Boolean(on));
}

// ---------- persistence helpers ----------
function persist() {
  state.lastLine = currentLine;
  state.lastScene = currentScene;
  saveState(state);
}

/**
 * Queue UI that would resize the window until drag ends.
 */
function runOrDeferWhileDragging(fn) {
  if (isDragging || pointerArmed) {
    pendingAfterDrag = fn;
    return;
  }
  fn();
}

function setMode(mode, { repaint = true } = {}) {
  if (UI_MINIMAL) {
    mode = "compact";
  }

  if ((isDragging || pointerArmed) && mode !== state.mode) {
    pendingAfterDrag = () => setMode(mode, { repaint });
    return false;
  }

  const changed = state.mode !== mode;
  if (!changed) {
    app.classList.remove("mode-compact", "mode-dock", "mode-panel");
    app.classList.add(`mode-${mode}`);
    return false;
  }

  state.mode = mode;
  app.classList.remove("mode-compact", "mode-dock", "mode-panel");
  app.classList.add(`mode-${mode}`);
  persist();
  window.petApi?.setMode?.(mode);
  if (repaint) paint();
  return true;
}

function ensureInteractiveMode() {
  if (UI_MINIMAL) return;
  if (state.mode === "compact") {
    setMode("dock");
  }
}

function openBubble(ms = 8000) {
  if (!SHOW_BUBBLE) {
    bubbleOpen = false;
    return;
  }
  bubbleOpen = true;
  if (bubbleHideTimer) clearTimeout(bubbleHideTimer);
  bubbleHideTimer = setTimeout(() => {
    bubbleOpen = false;
    updateBubbleDom();
  }, ms);
}

function updateBubbleDom() {
  const bubble = document.querySelector("#bubble");
  const line = document.querySelector("#line-text");
  const rankEl = document.querySelector(".bubble-rank");
  if (line) line.innerHTML = escapeHtml(currentLine);
  if (rankEl) rankEl.textContent = getAffinityRank(state.affinity).title;
  if (bubble) bubble.classList.toggle("closed", !bubbleOpen);
}

function setArtStyle(_art) {
  state.artStyle = "body";
  const shell = document.querySelector(".shell");
  if (shell) {
    shell.classList.remove("art-q", "art-normal", "art-orb");
    shell.classList.add("art-body");
  }
}

function say(scene, { affinityGain = 0 } = {}) {
  const line = speak(scene, { affinity: state.affinity });
  currentScene = scene;
  currentLine = line.text;

  if (affinityGain > 0) {
    const before = state.affinity;
    state = gainAffinity(state, affinityGain);
    if (state._affinityGained && state.affinity > before && state.affinity % 20 === 0) {
      const extra = speak("affinityUp", { affinity: state.affinity });
      currentLine = `${currentLine}\n${extra.text}`;
    }
    delete state._affinityGained;
  }

  setArtStyle("body");
  openBubble(9000);
  persist();

  if (document.querySelector("#pet-actor")) {
    updateBubbleDom();
    updateAffinityDom();
    motion.playScene(scene);
  } else {
    paint();
    motion.playScene(scene);
  }

  return line;
}

function updateAffinityDom() {
  const rank = getAffinityRank(state.affinity);
  const valueEl = document.querySelector(".affinity-value");
  const titleEl = document.querySelector(".affinity-card .title");
  const bar = document.querySelector(".affinity-bar > i");
  const stars = document.querySelector(".stars-row");
  const total = document.querySelector("#stat-interactions");
  if (valueEl) valueEl.textContent = String(rank.value);
  if (titleEl) titleEl.textContent = rank.title;
  if (bar) bar.style.width = `${rank.value}%`;
  if (stars) stars.textContent = starsHtml(rank.stars);
  if (total) total.textContent = String(state.totalInteractions || 0);
}

// ---------- particles helper ----------
function spawnParticles(x, y, symbol = "✨") {
  const stage = document.querySelector("#stage");
  if (!stage) return;
  for (let i = 0; i < 5; i++) {
    const p = document.createElement("span");
    p.className = "pet-particle";
    p.textContent = symbol;
    const offsetX = (Math.random() - 0.5) * 50;
    const offsetY = (Math.random() - 0.5) * 30;
    p.style.left = `${Math.max(10, Math.min(x + offsetX, 120))}px`;
    p.style.top = `${Math.max(10, Math.min(y + offsetY, 160))}px`;
    p.style.setProperty("--dx", `${(Math.random() - 0.5) * 50}px`);
    p.style.setProperty("--dy", `${-30 - Math.random() * 40}px`);
    stage.appendChild(p);
    setTimeout(() => p.remove(), 900);
  }
}

// ---------- menu helper ----------
/** Place the context menu fully inside the window; flip above cursor when near the bottom. */
function placeMenuInViewport(menu, clientX, clientY) {
  const pad = 6;
  const mw = menu.offsetWidth;
  const mh = menu.offsetHeight;
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  let left = clientX;
  let top = clientY;

  // Prefer opening to the right of the cursor; shift left if it would clip.
  if (left + mw > vw - pad) left = clientX - mw;
  left = Math.max(pad, Math.min(left, Math.max(pad, vw - mw - pad)));

  // Prefer opening below the cursor; flip above when not enough space under.
  if (top + mh > vh - pad) top = clientY - mh;
  top = Math.max(pad, Math.min(top, Math.max(pad, vh - mh - pad)));

  menu.style.left = `${Math.round(left)}px`;
  menu.style.top = `${Math.round(top)}px`;
}

function toggleMenu(show, clientX, clientY) {
  const menu = document.querySelector("#pet-menu");
  if (!menu) return;
  menuOpen = Boolean(show);
  if (menuOpen) {
    menu.classList.remove("closed");
    if (clientX != null && clientY != null) {
      // First paint at the click so layout can measure real size, then clamp.
      menu.style.left = `${Math.round(clientX)}px`;
      menu.style.top = `${Math.round(clientY)}px`;
      // Force layout after un-hiding (display:none → block).
      void menu.offsetWidth;
      placeMenuInViewport(menu, clientX, clientY);
    }
  } else {
    menu.classList.add("closed");
  }
}

function updateMenuWanderText() {
  const toggleBtn = document.querySelector("#menu-wander-toggle");
  if (toggleBtn) {
    toggleBtn.textContent = autoWanderEnabled ? "🌐 漫游：开启" : "🌐 漫游：关闭";
  }
}

async function handleMenuAction(action) {
  switch (action) {
    case "talk":
      say(Math.random() < 0.45 ? timeBucket() : "talk", { affinityGain: 1 });
      break;
    case "praise":
      say("praise", { affinityGain: 2 });
      spawnParticles(70, 90, "💖");
      break;
    case "walk": {
      // User-initiated: force walk even if auto-roam is off or she was sleeping.
      const before = state.affinity;
      state = gainAffinity(state, 1);
      delete state._affinityGained;
      currentScene = "talk";
      currentLine = "要在桌面上走走吗？好的~";
      openBubble(4000);
      updateBubbleDom();
      if (state.affinity > before && state.affinity % 20 === 0) {
        const extra = speak("affinityUp", { affinity: state.affinity });
        currentLine = `${currentLine}\n${extra.text}`;
        updateBubbleDom();
      }
      persist();
      const ok = await wander.planWalk({ force: true });
      if (!ok) {
        currentLine = "等我一下，现在好像走不开…再试一次好吗？";
        openBubble(3500);
        updateBubbleDom();
      }
      break;
    }
    case "hop": {
      const ok = wander.planHop({ force: true });
      if (ok) spawnParticles(70, 90, "✨");
      break;
    }
    case "sit":
      motion.lockFor(6000);
      say("talk", { affinityGain: 1 });
      currentLine = "稍微坐下来休息一会儿吧。";
      openBubble(5000);
      motion.play("sit", { force: true, holdMs: 6000 });
      break;
    case "toggle-wander":
      autoWanderEnabled = !autoWanderEnabled;
      if (autoWanderEnabled) {
        wander.start();
        say("talk", { affinityGain: 0 });
        currentLine = "嗯，漫游开启啦！我会偶尔在桌面上走走。";
        openBubble(4000);
      } else {
        wander.stop();
        say("talk", { affinityGain: 0 });
        currentLine = "漫游关闭了。我就站在这里陪着你。";
        openBubble(4000);
      }
      updateMenuWanderText();
      break;
    case "hide":
      say("hide", { affinityGain: 0 });
      setTimeout(() => window.petApi?.hide?.(), 400);
      break;
    default:
      break;
  }
}

// ---------- render ----------
function starsHtml(count) {
  return "★".repeat(count) + "☆".repeat(Math.max(0, 6 - count));
}

function shellHtml() {
  const rank = getAffinityRank(state.affinity);
  const bubbleClass = bubbleOpen ? "bubble" : "bubble closed";
  // Menu lives outside .shell so overflow:hidden on the shell cannot clip it.
  return `
    <div class="shell art-body shell-minimal shell-with-bubble">
      <div class="${bubbleClass}" id="bubble" role="status" aria-live="polite" title="点击与沙夜对话">
        <div class="bubble-meta">
          <span class="bubble-name">${CHARACTER.shortName}</span>
          <span class="bubble-rank">${rank.title}</span>
        </div>
        <p class="bubble-text" id="line-text">${escapeHtml(currentLine || "……")}</p>
      </div>

      <div class="stage" id="stage">
        <div class="stars" id="stars" aria-hidden="true"></div>
        <div class="stage-glow"></div>

        <button class="pet-hit" id="pet-hit" type="button" aria-label="拖动天之川沙夜">
          <div class="pet-actor act-idle" id="pet-actor" data-action="idle">
            <div class="pet-shadow" aria-hidden="true"></div>
            <div class="pet-body">
              <img class="pet-sprite is-visible" id="pet-layer-a" alt="${CHARACTER.name}" draggable="false" />
              <img class="pet-sprite" id="pet-layer-b" alt="" draggable="false" />
            </div>
          </div>
        </button>
      </div>
    </div>

    <div class="pet-menu closed" id="pet-menu" role="menu">
      <button class="pet-menu-item" data-menu-action="talk" type="button">💬 聊聊天</button>
      <button class="pet-menu-item" data-menu-action="praise" type="button">✨ 夸夸沙夜</button>
      <button class="pet-menu-item" data-menu-action="walk" type="button">🚶 散步走走</button>
      <button class="pet-menu-item" data-menu-action="hop" type="button">🦘 开心小跳</button>
      <button class="pet-menu-item" data-menu-action="sit" type="button">🪑 坐下休息</button>
      <button class="pet-menu-item" data-menu-action="toggle-wander" id="menu-wander-toggle" type="button">
        ${autoWanderEnabled ? "🌐 漫游：开启" : "🌐 漫游：关闭"}
      </button>
      <div class="pet-menu-divider"></div>
      <button class="pet-menu-item danger" data-menu-action="hide" type="button">📌 隐藏到托盘</button>
    </div>
  `;
}

function escapeHtml(str) {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("\n", "<br/>");
}

function paintStars() {
  const host = document.querySelector("#stars");
  if (!host || host.childElementCount) return;
  const count = 14;
  for (let i = 0; i < count; i++) {
    const s = document.createElement("span");
    s.className = "star";
    s.style.left = `${8 + Math.random() * 84}%`;
    s.style.top = `${6 + Math.random() * 70}%`;
    s.style.setProperty("--dur", `${2.4 + Math.random() * 3}s`);
    s.style.setProperty("--delay", `${Math.random() * 2}s`);
    host.appendChild(s);
  }
}

function bind() {
  const pet = document.querySelector("#pet-hit");
  const bubble = document.querySelector("#bubble");
  const menu = document.querySelector("#pet-menu");

  if (bubble) {
    bubble.addEventListener("click", (e) => {
      if (!bubbleOpen) return;
      e.stopPropagation();
      say(Math.random() < 0.5 ? timeBucket() : "talk", { affinityGain: 1 });
    });
  }

  if (menu) {
    menu.addEventListener("pointerdown", (e) => {
      e.stopPropagation();
    });

    menu.addEventListener("pointerup", (e) => {
      e.stopPropagation();
    });

    menu.addEventListener("click", async (e) => {
      const btn = e.target.closest("[data-menu-action]");
      if (!btn) return;
      e.stopPropagation();
      toggleMenu(false);
      const act = btn.getAttribute("data-menu-action");
      await handleMenuAction(act);
    });
  }

  if (pet) {
    const isMenuEvent = (event) => Boolean(event.target?.closest?.("#pet-menu"));

    const finishPointer = (treatAsDrag) => {
      const session = drag;
      const dragged = Boolean(treatAsDrag || isDragging || session?.moved);
      const hadPointer = Boolean(session || isDragging || pointerArmed);

      drag = null;
      isDragging = false;
      pointerArmed = false;
      pet.classList.remove("is-dragging");
      setDraggingLock(false);
      motion.setPaused?.(false);
      wander.resume();

      if (!hadPointer) return false;

      if (dragged) {
        suppressClickUntil = Date.now() + CLICK_SUPPRESS_MS;
        const deferred = pendingAfterDrag;
        pendingAfterDrag = null;
        if (deferred) {
          requestAnimationFrame(() => {
            if (!isDragging && !pointerArmed) deferred();
          });
        }
        return true;
      }

      pendingAfterDrag = null;
      return false;
    };

    pet.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      if (isMenuEvent(event)) return;
      toggleMenu(false);
      isDragging = false;
      pointerArmed = true;
      pendingAfterDrag = null;
      wander.pause();
      drag = {
        pointerId: event.pointerId,
        lastX: event.screenX,
        lastY: event.screenY,
        startX: event.screenX,
        startY: event.screenY,
        moved: false,
      };
      try {
        pet.setPointerCapture(event.pointerId);
      } catch {
        // ignore capture failures
      }
    });

    pet.addEventListener("pointermove", (event) => {
      if (!drag || drag.pointerId !== event.pointerId) return;

      const totalDx = event.screenX - drag.startX;
      const totalDy = event.screenY - drag.startY;
      const dist = Math.hypot(totalDx, totalDy);

      if (dist >= DRAG_THRESHOLD_PX) {
        drag.moved = true;
      }

      if (!isDragging && dist >= DRAG_THRESHOLD_PX) {
        isDragging = true;
        pet.classList.add("is-dragging");
        pendingAfterDrag = null;
        setDraggingLock(true);
        motion.setPaused?.(true);
        wander.pause();
      }
      if (!isDragging) return;

      const dx = event.screenX - drag.lastX;
      const dy = event.screenY - drag.lastY;
      drag.lastX = event.screenX;
      drag.lastY = event.screenY;
      if (dx === 0 && dy === 0) return;

      window.petApi?.moveBy?.({ dx, dy });
    });

    pet.addEventListener("pointerup", (event) => {
      if (drag && drag.pointerId !== event.pointerId) return;
      const moved = Boolean(drag?.moved || isDragging);
      const dragged = finishPointer(moved);
      if (dragged) return;
      if (Date.now() < suppressClickUntil) return;

      if (state.mode === "compact" && !UI_MINIMAL) {
        ensureInteractiveMode();
      }
      const scene = Math.random() < 0.55 ? timeBucket() : "tap";
      say(scene, { affinityGain: 1 });
      const rect = pet.getBoundingClientRect();
      spawnParticles(event.clientX - rect.left, event.clientY - rect.top, "✨");
    });

    pet.addEventListener("pointercancel", (event) => {
      if (drag && event.pointerId != null && drag.pointerId !== event.pointerId) return;
      finishPointer(true);
    });

    pet.addEventListener("lostpointercapture", () => {
      if (!drag && !isDragging && !pointerArmed) return;
      finishPointer(true);
    });

    pet.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (isDragging) return;
      // Use viewport coords so fixed menu can clamp to the floating window.
      toggleMenu(true, event.clientX, event.clientY);
    });

    pet.addEventListener("dblclick", (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (isDragging || Date.now() < suppressClickUntil) return;
      toggleMenu(false);
      const scene = Math.random() < 0.5 ? "affinityUp" : "praise";
      say(scene, { affinityGain: 2 });
      const rect = pet.getBoundingClientRect();
      spawnParticles(event.clientX - rect.left, event.clientY - rect.top, Math.random() < 0.5 ? "💖" : "✨");
    });
  }

  motion.attach(pet, {
    artChange: (art) => {
      if (isDragging) return;
      setArtStyle(art);
    },
    actionChange: (actionId, meta) => {
      wander.onAction(actionId, meta);
    },
  });

  paintStars();
}

document.addEventListener("click", (e) => {
  if (menuOpen && !e.target.closest("#pet-menu")) {
    toggleMenu(false);
  }
});

function paint() {
  motion.detach();
  if (UI_MINIMAL) state.mode = "compact";
  app.classList.remove("mode-compact", "mode-dock", "mode-panel");
  app.classList.add(`mode-${state.mode}`);
  app.innerHTML = shellHtml();
  bind();
}

// ---------- boot ----------
function boot() {
  state.mode = "compact";
  bubbleOpen = false;
  app.classList.add("mode-compact");

  const greetingScene = timeBucket();
  const line = speak(Math.random() < 0.5 ? "boot" : greetingScene, {
    affinity: state.affinity,
  });
  currentScene = line.scene;
  currentLine = line.text;
  state.artStyle = "body";
  openBubble(10000);
  persist();
  paint();
  motion.playScene(currentScene);
  wander.start();
  window.petApi?.setMode?.("compact");

  window.petApi?.onSetMode?.((mode) => {
    if (!mode) return;
    if (UI_MINIMAL) {
      setMode("compact", { repaint: false });
      return;
    }
    state.mode = mode;
    paint();
  });
}

window.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    if (UI_MINIMAL || state.mode === "compact") {
      window.petApi?.hide?.();
      return;
    }
    setMode("compact");
    bubbleOpen = false;
    updateBubbleDom();
  }
});

boot();
