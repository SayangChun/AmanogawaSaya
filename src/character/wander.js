/**
 * 自主漫游：播放 walk / hop 时同步移动 Electron 窗口位置。
 * 让沙夜在桌面上自己走动，而不是只在原地踏步。
 */

/** px per second while walking (screen space) */
const WALK_SPEED = 48;
/** px per second while hopping forward (screen space) */
const HOP_FORWARD_SPEED = 58;
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
 * @typedef {{
 *   motion: {
 *     play: (id: string, opts?: object) => void,
 *     getAction: () => string,
 *     setFacing: (dir: "left"|"right"|number) => void,
 *     isPaused?: () => boolean,
 *     isEnabled?: () => boolean,
 *     lockFor?: (ms: number) => void,
 *   },
 *   moveBy: (delta: { dx: number, dy: number }) => void,
 *   getBounds?: () => Promise<{ x: number, y: number, width: number, height: number } | null>,
 *   getWorkArea?: () => Promise<{ x: number, y: number, width: number, height: number } | null>,
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
    isBlocked = () => false,
    onRoamStart,
  } = deps;

  let enabled = true;
  let roamTimer = null;
  /** @type {number | null} */
  let rafId = null;
  let lastTick = 0;
  /** @type {null | { vx: number, until: number, kind: string }} */
  let locomotion = null;

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
    stopRaf();
  }

  function blocked() {
    if (!enabled) return true;
    if (typeof isBlocked === "function" && isBlocked()) return true;
    if (motion.isPaused?.()) return true;
    if (motion.isEnabled && !motion.isEnabled()) return true;
    const act = motion.getAction?.();
    if (act === "drag" || act === "sleep") return true;
    return false;
  }

  /**
   * Drive window position while a locomotion clip is active.
   * @param {number} now
   */
  function tick(now) {
    rafId = null;
    if (!locomotion) return;

    if (blocked() || Date.now() >= locomotion.until) {
      stopLocomotion();
      return;
    }

    // If motion left walk/hop (user interaction / scene), stop moving.
    const act = motion.getAction?.();
    if (act !== "walk" && act !== "hop" && act !== "bounce") {
      stopLocomotion();
      return;
    }

    if (!lastTick) lastTick = now;
    const dt = Math.min(0.05, Math.max(0, (now - lastTick) / 1000));
    lastTick = now;

    const dx = locomotion.vx * dt;
    const dy = 0;

    if (dx !== 0 || dy !== 0) {
      moveBy({ dx, dy });
    }

    rafId = requestAnimationFrame(tick);
  }

  function startRaf() {
    if (rafId != null) return;
    lastTick = 0;
    rafId = requestAnimationFrame(tick);
  }

  /**
   * Called from motion actionChange when walk / hop starts.
   * @param {string} actionId
   * @param {{ holdMs?: number|null }} [meta]
   */
  function onAction(actionId, meta = {}) {
    if (!enabled) return;

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

    if (actionId === "bounce") {
      stopLocomotion();
      return;
    }

    if (actionId === "hop") {
      let dir;
      if (locomotion?.vx) {
        dir = Math.sign(locomotion.vx) || (Math.random() < 0.5 ? -1 : 1);
      } else {
        const facing = motion.getFacing?.();
        dir = facing === "left" ? -1 : 1;
      }
      motion.setFacing(dir);
      const hold = Number(meta.holdMs) > 0 ? Number(meta.holdMs) : 1100;
      const now = Date.now();
      const vx = dir * HOP_FORWARD_SPEED;
      locomotion = {
        kind: "hop",
        vx,
        until: now + hold + 40,
      };
      startRaf();
      return;
    }

    // Any other action ends locomotion (sit, talk, idle, …).
    stopLocomotion();
  }

  /**
   * Plan a destination-ish walk toward a random point in the work area.
   */
  async function planWalk() {
    if (blocked()) return false;

    const facing = motion.getFacing?.();
    let dir = facing === "left" ? -1 : 1;
    let duration = WALK_MS_MIN + Math.random() * (WALK_MS_MAX - WALK_MS_MIN);

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
          if (leftRoom < EDGE_MARGIN_PX && rightRoom > leftRoom) dir = 1;
          else if (rightRoom < EDGE_MARGIN_PX && leftRoom > rightRoom) dir = -1;

          // Cap duration so the planned step ends before the window hits clamp.
          const room = dir < 0 ? leftRoom : rightRoom;
          const maxMs = Math.max(700, Math.min(WALK_MS_MAX, (room / WALK_SPEED) * 1000));
          duration = Math.min(duration, maxMs);
        }
      }
    } catch {
      // offline / no petApi — keep random dir
    }

    motion.setFacing(dir);
    const walkVx = dir * WALK_SPEED * (0.85 + Math.random() * 0.3);

    locomotion = {
      kind: "walk",
      vx: walkVx,
      until: Date.now() + duration + 80,
    };

    motion.lockFor?.(duration);
    motion.play("walk", { force: true, holdMs: Math.round(duration) });
    startRaf();
    try {
      onRoamStart?.("walk");
    } catch {
      /* ignore */
    }
    return true;
  }

  function planHop() {
    if (blocked()) return false;
    const facing = motion.getFacing?.();
    const dir = facing === "left" ? -1 : 1;
    motion.setFacing(dir);
    const now = Date.now();
    const vx = dir * HOP_FORWARD_SPEED;
    locomotion = {
      kind: "hop",
      vx,
      until: now + 1200,
    };
    motion.lockFor?.(1200);
    motion.play("hop", { force: true, holdMs: 1100 });
    startRaf();
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

    if (!blocked() && Math.random() < ROAM_CHANCE) {
      const act = motion.getAction?.();
      // Don't interrupt talk / celebrate / sit mid-clip — only roam from calm states.
      if (
        act === "idle" ||
        act === "breathe" ||
        act === "sway" ||
        act === "look" ||
        act === "calm" ||
        act === "soft" ||
        act === "smile"
      ) {
        if (Math.random() < WALK_VS_HOP) {
          await planWalk();
        } else {
          planHop();
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
