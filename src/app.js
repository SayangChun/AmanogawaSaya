import { CHARACTER, getAffinityRank } from "./character/profile.js";
import { speak, timeBucket } from "./character/dialogue.js";
import { createMotionController } from "./character/motion.js";
import { loadState, saveState, gainAffinity } from "./state.js";

const app = document.querySelector("#app");
const motion = createMotionController();

const DRAG_THRESHOLD_PX = 4;
const CLICK_SUPPRESS_MS = 500;

/** @type {ReturnType<typeof loadState>} */
let state = loadState();
let currentLine = state.lastLine || "";
let currentScene = state.lastScene || "boot";
/** Stage focus: no bubble / dock / panel UI. */
const UI_MINIMAL = true;
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

function setDraggingLock(on) {
  window.petApi?.setDragging?.(Boolean(on));
}

// ---------- persistence helpers ----------
function persist() {
  state.lastLine = currentLine;
  state.lastScene = currentScene;
  saveState(state);
}

function isPointerBlocked() {
  return isDragging || pointerArmed || Date.now() < suppressClickUntil;
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
  // Minimal stage: always stay compact — no dock / panel chrome.
  if (UI_MINIMAL) {
    mode = "compact";
  }

  // Never resize / re-layout while the user is interacting with the pet body.
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

/** Expand compact → dock only on intentional interaction, never mid-drag. */
function ensureInteractiveMode() {
  if (UI_MINIMAL) return;
  if (state.mode === "compact") {
    setMode("dock");
  }
}

function openBubble(ms = 8000) {
  if (UI_MINIMAL) {
    bubbleOpen = false;
    return;
  }
  bubbleOpen = true;
  if (bubbleHideTimer) clearTimeout(bubbleHideTimer);
  bubbleHideTimer = setTimeout(() => {
    if (state.mode === "compact") {
      bubbleOpen = false;
      updateBubbleDom();
    }
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

// ---------- render ----------
function starsHtml(count) {
  return "★".repeat(count) + "☆".repeat(Math.max(0, 6 - count));
}

function shellHtml() {
  // Minimal stage: only Saya — no bubble, dock, panel, or status data.
  return `
    <div class="shell art-body shell-minimal">
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
  const actions = document.querySelectorAll("[data-action]");

  actions.forEach((el) => {
    el.addEventListener("click", async (e) => {
      e.stopPropagation();
      await handleAction(el.getAttribute("data-action"));
    });
  });

  if (pet) {
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

      if (!hadPointer) return false;

      if (dragged) {
        suppressClickUntil = Date.now() + CLICK_SUPPRESS_MS;
        const deferred = pendingAfterDrag;
        pendingAfterDrag = null;
        // Only run deferred mode changes after drag fully ends — never mid-gesture.
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
      isDragging = false;
      pointerArmed = true;
      pendingAfterDrag = null;
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
        // ignore capture failures on some hosts
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
        // Drop any pending enlarge; lock main-process window size.
        pendingAfterDrag = null;
        setDraggingLock(true);
        motion.setPaused?.(true);
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

      // Minimal stage: click does nothing (no menu / panel / bubble).
      if (UI_MINIMAL) return;

      // Pure click only — never expand window as a side-effect of a drag gesture.
      if (state.mode === "compact") {
        ensureInteractiveMode();
        say("tap", { affinityGain: 1 });
      } else {
        say("tap", { affinityGain: 0 });
      }
    });

    pet.addEventListener("pointercancel", (event) => {
      if (drag && event.pointerId != null && drag.pointerId !== event.pointerId) return;
      finishPointer(true);
    });

    pet.addEventListener("lostpointercapture", () => {
      if (!drag && !isDragging && !pointerArmed) return;
      finishPointer(true);
    });
  }

  motion.attach(pet, {
    artChange: (art) => {
      if (isDragging) return;
      setArtStyle(art);
    },
  });

  paintStars();
}

async function handleAction(action) {
  if (UI_MINIMAL && action !== "hide" && action !== "compact") {
    return;
  }
  switch (action) {
    case "talk":
      say(Math.random() < 0.45 ? timeBucket() : "talk", { affinityGain: 1 });
      break;
    case "praise":
      say("praise", { affinityGain: 2 });
      break;
    case "greet":
      say(timeBucket(), { affinityGain: 1 });
      break;
    case "panel":
      if (UI_MINIMAL) return;
      setMode("panel");
      break;
    case "compact":
      setMode("compact");
      bubbleOpen = false;
      updateBubbleDom();
      break;
    case "hide":
      if (!UI_MINIMAL) say("hide", { affinityGain: 0 });
      setTimeout(() => window.petApi?.hide?.(), 400);
      break;
    default:
      break;
  }
}

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
  // Minimal stage: keep state but do not surface dialogue / panels.
  if (!UI_MINIMAL) openBubble(10000);
  persist();
  paint();
  motion.playScene(currentScene);
  window.petApi?.setMode?.("compact");

  window.petApi?.onSetMode?.((mode) => {
    if (!mode) return;
    // Ignore dock/panel requests while UI is minimal.
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
