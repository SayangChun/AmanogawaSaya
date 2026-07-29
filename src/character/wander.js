/**
 * 自主漫游：播放 walk 时同步移动 Electron 窗口位置。
 * hop / bounce 为原地小跳，不平移窗口。
 */

/** px per second while walking (screen space) */
const WALK_SPEED = 72;
/** roam planner cadence */
const ROAM_MIN_MS = 9000;
const ROAM_MAX_MS = 20000;
/** chance to actually start a roam when timer fires */
const ROAM_CHANCE = 0.62;
/** among roams: walk vs hop */
const WALK_VS_HOP = 0.82;
/** min / max walk duration (ms) when planner starts a walk */
const WALK_MS_MIN = 2800;
const WALK_MS_MAX = 5200;
/** keep a small safety margin so the pet does not press into the edge */
const EDGE_MARGIN_PX = 18;

/**
 * Actions that may auto-roam (zone may favor look/alert — must not hard-block roam).
 * sit / sleep / talk / etc. still block.
 */
const CALM_FOR_ROAM = new Set([
  "idle",
  "breathe",
  "sway",
  "look",
  "calm",
  "soft",
  "smile",
  "alert",
  "nod",
]);

/**
 * @typedef {{
 *   motion: {
 *     play: (id: string, opts?: object) => void,
 *     getAction: () => string,
 *     setFacing: (dir: "left"|"right"|number) => void,
 *     setContext?: (ctx: string) => void,
 *     isPaused?: () => boolean,
 *     isEnabled?: () => boolean,
 *     lockFor?: (ms: number) => void,
 *     getFacing?: () => string,
 *   },
 *   moveBy: (delta: { dx: number, dy: number }) => void,
 *   getBounds?: () => Promise<{ x: number, y: number, width: number, height: number } | null>,
 *   getWorkArea?: () => Promise<{ x: number, y: number, width: number, height: number } | null>,
 *   getRoamBias?: (opts?: { ensureFresh?: boolean }) => Promise<{
 *     roamChanceMul?: number,
 *     walkVsHop?: number,
 *     preferDir?: number|null,
 *     zoneId?: string|null,
 *   } | null>,
 *   isBlocked?: () => boolean,
 *   onRoamStart?: (kind: "walk" | "hop") => void,
 * }} WanderDeps
 */

/**
 * @param {WanderDeps} deps
 */
export function createWanderController(deps) {
  const {
    motion,
    moveBy,
    getBounds,
    getWorkArea,
    getRoamBias,
    isBlocked = () => false,
    onRoamStart,
  } = deps;

  function isCalmAction(act) {
    return CALM_FOR_ROAM.has(act);
  }

  let enabled = true;
  let roamTimer = null;
  /** @type {number | null} */
  let rafId = null;
  let lastTick = 0;
  /** @type {null | { vx: number, until: number, kind: string }} */
  let locomotion = null;
  /**
   * Sub-pixel remainder for screen movement.
   * Window bounds are integers; without accumulation, high-refresh displays
   * (dx ≈ 0.3–0.5 px/frame) round every step back to zero and never move.
   */
  let moveCarryX = 0;
  let moveCarryY = 0;

  function clearRoamTimer() {
    if (roamTimer) {
      clearTimeout(roamTimer);
      roamTimer = null;
    }
  }

  function stopRaf() {
    if (rafId != null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
    lastTick = 0;
  }

  function stopLocomotion() {
    locomotion = null;
    moveCarryX = 0;
    moveCarryY = 0;
    stopRaf();
  }

  /**
   * Apply velocity over dt, flushing only whole pixels so the OS window moves.
   * @param {number} dt seconds
   */
  function applyMove(dt) {
    if (!locomotion || dt <= 0) return;
    moveCarryX += locomotion.vx * dt;
    moveCarryY += 0;

    const dx = moveCarryX >= 0 ? Math.floor(moveCarryX) : Math.ceil(moveCarryX);
    const dy = moveCarryY >= 0 ? Math.floor(moveCarryY) : Math.ceil(moveCarryY);
    if (dx === 0 && dy === 0) return;

    moveCarryX -= dx;
    moveCarryY -= dy;
    moveBy({ dx, dy });
  }

  /**
   * Hard blocks: user is dragging / motion paused — window must not auto-move.
   * Does NOT include auto-wander off or sleep (user menu can interrupt those).
   */
  function isHardBlocked() {
    if (typeof isBlocked === "function" && isBlocked()) return true;
    if (motion.isPaused?.()) return true;
    if (motion.isEnabled && !motion.isEnabled()) return true;
    const act = motion.getAction?.();
    if (act === "drag") return true;
    return false;
  }

  /** Soft gate for the auto-roam planner only. */
  function canAutoRoam() {
    if (!enabled) return false;
    if (isHardBlocked()) return false;
    const act = motion.getAction?.();
    if (act === "sleep") return false;
    return true;
  }

  /**
   * Drive window position while a locomotion clip is active.
   * @param {number} now
   */
  function tick(now) {
    rafId = null;
    if (!locomotion) return;

    // Only hard-block stops an in-progress walk (not "auto wander off").
    if (isHardBlocked() || Date.now() >= locomotion.until) {
      stopLocomotion();
      return;
    }

    // If motion left walk (user interaction / scene), stop moving.
    // hop / bounce are in-place clips — they must not drive window translation.
    const act = motion.getAction?.();
    if (act !== "walk") {
      stopLocomotion();
      return;
    }

    if (!lastTick) lastTick = now;
    const dt = Math.min(0.05, Math.max(0, (now - lastTick) / 1000));
    lastTick = now;

    applyMove(dt);

    rafId = requestAnimationFrame(tick);
  }

  function startRaf() {
    if (rafId != null) return;
    lastTick = 0;
    rafId = requestAnimationFrame(tick);
  }

  /**
   * Called from motion actionChange when walk starts.
   * Drives locomotion for walk only; hop/bounce stay in place.
   * @param {string} actionId
   * @param {{ holdMs?: number|null }} [meta]
   */
  function onAction(actionId, meta = {}) {
    if (actionId === "walk") {
      // Re-use existing velocity if planner already set it; else invent a path.
      if (!locomotion || locomotion.kind !== "walk") {
        const facing = motion.getFacing?.();
        const dir = facing === "left" ? -1 : 1;
        motion.setFacing(dir);
        const hold = Number(meta.holdMs) > 0 ? Number(meta.holdMs) : 3200;
        locomotion = {
          kind: "walk",
          vx: dir * WALK_SPEED,
          until: Date.now() + hold + 80,
        };
      } else {
        // Planner set velocity; refresh deadline from hold.
        const hold = Number(meta.holdMs) > 0 ? Number(meta.holdMs) : 3200;
        locomotion.until = Date.now() + hold + 80;
      }
      startRaf();
      return;
    }

    // hop / bounce: happy in-place jump — keep horizontal window position fixed.
    if (actionId === "bounce" || actionId === "hop") {
      stopLocomotion();
      return;
    }

    // Any other action ends locomotion (sit, talk, idle, …).
    stopLocomotion();
  }

  /**
   * Pick walk direction / duration from desktop free space.
   * @param {number} preferredDir
   * @param {number} duration
   */
  async function resolveWalkPlan(preferredDir, duration) {
    let dir = preferredDir;
    let ms = duration;

    try {
      if (getBounds && getWorkArea) {
        const [bounds, area] = await Promise.all([getBounds(), getWorkArea()]);
        if (bounds && area) {
          // Horizontal ground movement: decide from the window edges, not center,
          // so she turns before the desktop clamp makes her jitter in place.
          const leftRoom = Math.max(0, bounds.x - area.x - EDGE_MARGIN_PX);
          const rightRoom = Math.max(
            0,
            area.x + area.width - (bounds.x + bounds.width) - EDGE_MARGIN_PX,
          );

          // Prefer the side with more room when cramped; otherwise keep facing.
          if (leftRoom < 40 && rightRoom > leftRoom) dir = 1;
          else if (rightRoom < 40 && leftRoom > rightRoom) dir = -1;
          else if (leftRoom < 8 && rightRoom < 8) {
            // Fully pinched — still walk in place briefly so the clip is visible.
            dir = preferredDir || 1;
          }

          const room = dir < 0 ? leftRoom : rightRoom;
          if (room > 8) {
            const maxMs = Math.max(900, Math.min(WALK_MS_MAX, (room / WALK_SPEED) * 1000));
            ms = Math.min(ms, maxMs);
          } else {
            // Almost no room that way: flip and use the other side if possible.
            const altDir = -dir;
            const altRoom = altDir < 0 ? leftRoom : rightRoom;
            if (altRoom > room) {
              dir = altDir;
              const maxMs = Math.max(900, Math.min(WALK_MS_MAX, (altRoom / WALK_SPEED) * 1000));
              ms = Math.min(ms, maxMs);
            } else {
              ms = Math.min(ms, 1200);
            }
          }
        }
      }
    } catch {
      // offline / no petApi — keep random dir
    }

    return { dir, duration: ms };
  }

  /**
   * Plan a destination-ish walk toward a random point in the work area.
   * @param {{ force?: boolean, preferDir?: number|null, zoneId?: string|null }} [opts]
   *   force=true: user menu — ignore auto-roam/sleep gates
   */
  async function planWalk(opts = {}) {
    const force = Boolean(opts.force);
    if (force) {
      if (isHardBlocked()) return false;
    } else if (!canAutoRoam()) {
      return false;
    }

    const facing = motion.getFacing?.();
    let preferredDir =
      opts.preferDir === 1 || opts.preferDir === -1
        ? opts.preferDir
        : facing === "left"
          ? -1
          : 1;
    let duration = WALK_MS_MIN + Math.random() * (WALK_MS_MAX - WALK_MS_MIN);

    // Corner walks are slightly shorter (before room clamp).
    const zoneId = opts.zoneId || null;
    if (zoneId && String(zoneId).startsWith("corner")) {
      duration *= 0.8;
    }

    const plan = await resolveWalkPlan(preferredDir, duration);
    // Re-check after await: user may have started a drag.
    if (force ? isHardBlocked() : !canAutoRoam()) return false;

    const dir = plan.dir;
    duration = plan.duration;

    // dir < 0 → move left + face left; dir > 0 → move right + face right
    motion.setFacing(dir);
    // Clear sleep / sit context so fallback after walk is idle, not sleep.
    motion.setContext?.("");
    const walkVx = dir * WALK_SPEED * (0.85 + Math.random() * 0.3);
    const holdMs = Math.max(900, Math.round(duration));

    locomotion = {
      kind: "walk",
      vx: walkVx,
      until: Date.now() + holdMs + 80,
    };
    moveCarryX = 0;
    moveCarryY = 0;

    motion.lockFor?.(holdMs);
    motion.play("walk", { force: true, holdMs });
    startRaf();
    try {
      onRoamStart?.("walk");
    } catch {
      /* ignore */
    }
    return true;
  }

  /**
   * Happy hop in place — plays the hop clip without moving the window.
   * @param {{ force?: boolean }} [opts]
   */
  function planHop(opts = {}) {
    const force = Boolean(opts.force);
    if (force) {
      if (isHardBlocked()) return false;
    } else if (!canAutoRoam()) {
      return false;
    }

    stopLocomotion();
    motion.setContext?.("");
    motion.lockFor?.(1200);
    motion.play("hop", { force: true, holdMs: 1400 });
    try {
      onRoamStart?.("hop");
    } catch {
      /* ignore */
    }
    return true;
  }

  function scheduleRoam() {
    clearRoamTimer();
    if (!enabled) return;
    const wait = ROAM_MIN_MS + Math.random() * (ROAM_MAX_MS - ROAM_MIN_MS);
    roamTimer = setTimeout(() => {
      void tryRoam();
    }, wait);
  }

  async function tryRoam() {
    roamTimer = null;
    if (!enabled) return;

    if (!canAutoRoam()) {
      scheduleRoam();
      return;
    }

    let bias = {
      roamChanceMul: 1,
      walkVsHop: WALK_VS_HOP,
      preferDir: null,
      zoneId: null,
    };
    if (typeof getRoamBias === "function") {
      try {
        const b = await getRoamBias({ ensureFresh: true });
        if (b) {
          bias = {
            roamChanceMul: Number(b.roamChanceMul) > 0 ? Number(b.roamChanceMul) : 1,
            walkVsHop:
              Number(b.walkVsHop) > 0 && Number(b.walkVsHop) <= 1
                ? Number(b.walkVsHop)
                : WALK_VS_HOP,
            preferDir: b.preferDir === 1 || b.preferDir === -1 ? b.preferDir : null,
            zoneId: b.zoneId || null,
          };
        }
      } catch {
        /* keep defaults */
      }
    }

    // Post-await guards
    if (!canAutoRoam() || isHardBlocked()) {
      scheduleRoam();
      return;
    }

    const chance = ROAM_CHANCE * bias.roamChanceMul;
    if (Math.random() < chance) {
      const act = motion.getAction?.();
      // Don't interrupt talk / celebrate / sit mid-clip — only roam from calm states.
      if (isCalmAction(act)) {
        if (Math.random() < bias.walkVsHop) {
          await planWalk({
            force: false,
            preferDir: bias.preferDir,
            zoneId: bias.zoneId,
          });
        } else {
          planHop({ force: false });
        }
      }
    }

    scheduleRoam();
  }

  function start() {
    enabled = true;
    scheduleRoam();
  }

  function stop() {
    enabled = false;
    clearRoamTimer();
    stopLocomotion();
  }

  /** Pause planner + locomotion (user dragging). */
  function pause() {
    stopLocomotion();
    clearRoamTimer();
  }

  /** Resume after drag / interaction. */
  function resume() {
    if (!enabled) return;
    scheduleRoam();
  }

  return {
    start,
    stop,
    pause,
    resume,
    onAction,
    planWalk,
    planHop,
  };
}
