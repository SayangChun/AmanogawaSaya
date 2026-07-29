/**
 * 屏幕分区姿势：外侧 free-space 几何 + 迟滞 zone + 加权 idle / roam 偏向。
 * 纯函数可手测；tracker 懒采样 bounds/workArea（禁止默认轮询）。
 */

/** @typedef {"open"|"edge-left"|"edge-right"|"edge-top"|"edge-bottom"|"corner-tl"|"corner-tr"|"corner-bl"|"corner-br"} ZoneId */

export const ZONE_CONFIG = {
  ENTER_EDGE_PX: 72,
  EXIT_EDGE_PX: 110,
  MIN_ZONE_DWELL_MS: 2500,
  SNAPSHOT_FRESH_MS: 1000,
  IPC_TIMEOUT_MS: 50,
  BOOT_ZONE_GRACE_MS: 8 * 60 * 1000,
  BOOT_OPEN_BLEND: 0.45,
  WALK_MS_CORNER_SCALE: 0.8,
  POST_SCENE_IDLE_COOLDOWN_MS: 3500,
};

/** Zone-weighted pool membership. sleep excluded. */
export const ZONE_IDLE_ACTIONS = [
  "breathe",
  "sway",
  "look",
  "smile",
  "nod",
  "calm",
  "soft",
  "wave",
  "stretch",
  "sit",
  "alert",
  "coat",
  "peek",
  "think",
  "yawn",
  "giggle",
];

/** Scalar cooldown defaults (ms) after a zone-picked action */
export const ACTION_COOLDOWN_MS = {
  sit: 30000,
  stretch: 18000,
  wave: 18000,
  coat: 20000,
  yawn: 22000,
  look: 8000,
  alert: 8000,
  peek: 9000,
  think: 10000,
  smile: 5000,
  nod: 5000,
  soft: 5000,
  calm: 5000,
  sway: 5000,
  breathe: 5000,
  giggle: 12000,
};

const LOOKISH = new Set(["look", "alert", "soft", "peek"]);

/** @type {Record<string, Record<string, number>>} */
const WEIGHTS = {
  open: {
    breathe: 1.2,
    sway: 1.2,
    look: 1.0,
    smile: 1.0,
    nod: 0.8,
    calm: 1.0,
    soft: 1.0,
    wave: 0.7,
    stretch: 1.4,
    sit: 0.6,
    alert: 0.3,
    coat: 0.4,
    peek: 0.7,
    think: 0.8,
    yawn: 0.5,
    giggle: 0.6,
  },
  "edge-left": {
    breathe: 1.0,
    sway: 0.7,
    look: 2.2,
    smile: 0.6,
    nod: 0.5,
    calm: 1.2,
    soft: 1.0,
    wave: 0.3,
    stretch: 0.5,
    sit: 0.9,
    alert: 1.4,
    coat: 0.5,
    peek: 1.6,
    think: 0.9,
    yawn: 0.4,
    giggle: 0.3,
  },
  "edge-right": {
    breathe: 1.0,
    sway: 0.7,
    look: 2.2,
    smile: 0.6,
    nod: 0.5,
    calm: 1.2,
    soft: 1.0,
    wave: 0.3,
    stretch: 0.5,
    sit: 0.9,
    alert: 1.4,
    coat: 0.5,
    peek: 1.6,
    think: 0.9,
    yawn: 0.4,
    giggle: 0.3,
  },
  "edge-bottom": {
    breathe: 1.4,
    sway: 0.6,
    look: 0.9,
    smile: 0.7,
    nod: 0.6,
    calm: 1.6,
    soft: 1.2,
    wave: 0.3,
    stretch: 0.4,
    sit: 1.6,
    alert: 0.5,
    coat: 0.6,
    peek: 0.6,
    think: 1.0,
    yawn: 0.8,
    giggle: 0.3,
  },
  "edge-top": {
    breathe: 1.0,
    sway: 0.8,
    look: 2.0,
    smile: 0.8,
    nod: 0.5,
    calm: 1.1,
    soft: 1.6,
    wave: 0.4,
    stretch: 0.6,
    sit: 0.3,
    alert: 1.0,
    coat: 0.5,
    peek: 1.5,
    think: 1.1,
    yawn: 0.4,
    giggle: 0.4,
  },
  "corner-bl": {
    breathe: 1.3,
    sway: 0.5,
    look: 1.2,
    smile: 0.5,
    nod: 0.4,
    calm: 1.6,
    soft: 1.3,
    wave: 0.2,
    stretch: 0.3,
    sit: 1.4,
    alert: 0.7,
    coat: 0.6,
    peek: 0.8,
    think: 1.1,
    yawn: 0.7,
    giggle: 0.2,
  },
  "corner-br": {
    breathe: 1.3,
    sway: 0.5,
    look: 1.2,
    smile: 0.5,
    nod: 0.4,
    calm: 1.6,
    soft: 1.3,
    wave: 0.2,
    stretch: 0.3,
    sit: 1.4,
    alert: 0.7,
    coat: 0.6,
    peek: 0.8,
    think: 1.1,
    yawn: 0.7,
    giggle: 0.2,
  },
  "corner-tl": {
    breathe: 1.0,
    sway: 0.5,
    look: 2.4,
    smile: 0.6,
    nod: 0.4,
    calm: 1.2,
    soft: 1.8,
    wave: 0.3,
    stretch: 0.3,
    sit: 0.4,
    alert: 1.6,
    coat: 0.5,
    peek: 1.8,
    think: 1.0,
    yawn: 0.3,
    giggle: 0.3,
  },
  "corner-tr": {
    breathe: 1.0,
    sway: 0.5,
    look: 2.4,
    smile: 0.6,
    nod: 0.4,
    calm: 1.2,
    soft: 1.8,
    wave: 0.3,
    stretch: 0.3,
    sit: 0.4,
    alert: 1.6,
    coat: 0.5,
    peek: 1.8,
    think: 1.0,
    yawn: 0.3,
    giggle: 0.3,
  },
};

/** @type {Record<ZoneId, { roamChanceMul: number, walkVsHop: number, preferDir: number|null }>} */
const ROAM_BIAS = {
  open: { roamChanceMul: 1.15, walkVsHop: 0.75, preferDir: null },
  "edge-left": { roamChanceMul: 0.9, walkVsHop: 0.9, preferDir: 1 },
  "edge-right": { roamChanceMul: 0.9, walkVsHop: 0.9, preferDir: -1 },
  "edge-bottom": { roamChanceMul: 0.75, walkVsHop: 0.95, preferDir: null },
  "edge-top": { roamChanceMul: 0.6, walkVsHop: 0.95, preferDir: null },
  "corner-bl": { roamChanceMul: 0.55, walkVsHop: 0.98, preferDir: 1 },
  "corner-br": { roamChanceMul: 0.55, walkVsHop: 0.98, preferDir: -1 },
  "corner-tl": { roamChanceMul: 0.5, walkVsHop: 0.95, preferDir: 1 },
  "corner-tr": { roamChanceMul: 0.5, walkVsHop: 0.95, preferDir: -1 },
};

export function isZonePosesEnabled() {
  try {
    return localStorage.getItem("saya.zonePoses") !== "0";
  } catch {
    return true;
  }
}

/**
 * @param {{ x:number,y:number,width:number,height:number }} bounds
 * @param {{ x:number,y:number,width:number,height:number }} workArea
 */
export function computeSpaces(bounds, workArea) {
  const left = Math.max(0, bounds.x - workArea.x);
  const right = Math.max(0, workArea.x + workArea.width - (bounds.x + bounds.width));
  const above = Math.max(0, bounds.y - workArea.y);
  const below = Math.max(0, workArea.y + workArea.height - (bounds.y + bounds.height));
  return { left, right, above, below };
}

function axisFlags(spaces, thr) {
  return {
    L: spaces.left <= thr,
    R: spaces.right <= thr,
    T: spaces.above <= thr,
    B: spaces.below <= thr,
  };
}

function rank(z) {
  if (!z || z === "open") return 0;
  if (String(z).startsWith("corner")) return 2;
  if (String(z).startsWith("edge")) return 1;
  return 0;
}

/**
 * @param {{ left:number,right:number,above:number,below:number }} spaces
 * @param {number} [enterPx]
 * @returns {ZoneId}
 */
export function classifyRaw(spaces, enterPx = ZONE_CONFIG.ENTER_EDGE_PX) {
  const f = axisFlags(spaces, enterPx);
  const hSide =
    f.L && f.R
      ? spaces.left <= spaces.right
        ? "left"
        : "right"
      : f.L
        ? "left"
        : f.R
          ? "right"
          : null;
  const vSide =
    f.T && f.B
      ? spaces.above <= spaces.below
        ? "top"
        : "bottom"
      : f.T
        ? "top"
        : f.B
          ? "bottom"
          : null;

  if (hSide && vSide) {
    const map = {
      "left|top": "corner-tl",
      "right|top": "corner-tr",
      "left|bottom": "corner-bl",
      "right|bottom": "corner-br",
    };
    return /** @type {ZoneId} */ (map[`${hSide}|${vSide}`]);
  }
  if (hSide) return hSide === "left" ? "edge-left" : "edge-right";
  if (vSide) return vSide === "top" ? "edge-top" : "edge-bottom";
  return "open";
}

/**
 * @param {ZoneId|string|null} prevZone
 * @param {{ left:number,right:number,above:number,below:number }} spaces
 * @param {number} [exitPx]
 */
export function stillInZone(prevZone, spaces, exitPx = ZONE_CONFIG.EXIT_EDGE_PX) {
  if (!prevZone || prevZone === "open") return false;
  const s = spaces;
  switch (prevZone) {
    case "edge-left":
      return s.left <= exitPx;
    case "edge-right":
      return s.right <= exitPx;
    case "edge-top":
      return s.above <= exitPx;
    case "edge-bottom":
      return s.below <= exitPx;
    case "corner-bl":
      return s.left <= exitPx && s.below <= exitPx;
    case "corner-br":
      return s.right <= exitPx && s.below <= exitPx;
    case "corner-tl":
      return s.left <= exitPx && s.above <= exitPx;
    case "corner-tr":
      return s.right <= exitPx && s.above <= exitPx;
    default:
      return false;
  }
}

/**
 * @param {{ left:number,right:number,above:number,below:number }} spaces
 * @param {ZoneId|string|null} prevZone
 * @param {number} now
 * @param {{ force?: boolean, enteredAt?: number|null }} [meta]
 * @returns {ZoneId}
 */
export function resolveZone(spaces, prevZone, now, meta = {}) {
  const raw = classifyRaw(spaces);
  if (!prevZone) return raw;
  if (meta.force) return raw;

  const dwellOk =
    meta.enteredAt == null ||
    now - meta.enteredAt >= ZONE_CONFIG.MIN_ZONE_DWELL_MS;

  // Inward promotion: open→edge→corner when dwell elapsed
  if (rank(raw) > rank(prevZone)) {
    return dwellOk ? raw : /** @type {ZoneId} */ (prevZone);
  }

  if (raw === prevZone) return /** @type {ZoneId} */ (prevZone);

  // Outward or lateral: hold while still in exit band
  if (stillInZone(prevZone, spaces)) {
    return /** @type {ZoneId} */ (prevZone);
  }

  return dwellOk ? raw : /** @type {ZoneId} */ (prevZone);
}

/**
 * @param {ZoneId|string} zoneId
 * @param {{ bootAt?: number, now?: number }} [ctx]
 * @returns {Record<string, number>}
 */
export function zoneIdleWeights(zoneId, ctx = {}) {
  const table = WEIGHTS[zoneId] || WEIGHTS.open;
  const bootAt = ctx.bootAt ?? 0;
  const now = ctx.now ?? Date.now();
  if (bootAt && now - bootAt < ZONE_CONFIG.BOOT_ZONE_GRACE_MS) {
    const open = WEIGHTS.open;
    const b = ZONE_CONFIG.BOOT_OPEN_BLEND;
    /** @type {Record<string, number>} */
    const w = {};
    for (const id of ZONE_IDLE_ACTIONS) {
      w[id] = b * (open[id] || 0) + (1 - b) * (table[id] || 0);
    }
    return w;
  }
  return { ...table };
}

/**
 * @param {ZoneId|string} zoneId
 */
export function zoneRoamBias(zoneId) {
  const b = ROAM_BIAS[zoneId] || ROAM_BIAS.open;
  return {
    roamChanceMul: b.roamChanceMul,
    walkVsHop: b.walkVsHop,
    preferDir: b.preferDir,
  };
}

/**
 * @param {ZoneId|string} zoneId
 * @returns {"left"|"right"|null}
 */
export function zoneFacingHint(zoneId) {
  const z = String(zoneId || "");
  if (z === "edge-left" || z.endsWith("-l") || z === "corner-tl" || z === "corner-bl") {
    return "left";
  }
  if (z === "edge-right" || z.endsWith("-r") || z === "corner-tr" || z === "corner-br") {
    return "right";
  }
  return null;
}

export function isLookishAction(actionId) {
  return LOOKISH.has(actionId);
}

/**
 * @param {Record<string, number>} weights
 * @param {Map<string, number>|Record<string, number>} cooldowns
 * @param {number} now
 * @param {Record<string, unknown>} actionCatalog
 * @returns {string}
 */
export function pickWeightedAction(weights, cooldowns, now, actionCatalog) {
  const getCd = (id) =>
    cooldowns instanceof Map ? cooldowns.get(id) || 0 : cooldowns[id] || 0;

  const entries = Object.entries(weights || {})
    .filter(([id, w]) => w > 0 && Boolean(actionCatalog?.[id]))
    .map(([id, w]) => {
      const readyAt = getCd(id);
      const factor = now < readyAt ? 0.15 : 1;
      return /** @type {[string, number]} */ ([id, w * factor]);
    });

  const sum = entries.reduce((s, [, w]) => s + w, 0);
  if (sum <= 0 || entries.length === 0) return "idle";

  let r = Math.random() * sum;
  for (const [id, w] of entries) {
    r -= w;
    if (r <= 0) return id;
  }
  return entries[entries.length - 1][0];
}

/**
 * @param {string} actionId
 * @param {Map<string, number>} cooldowns
 * @param {number} [now]
 */
export function markActionCooldown(actionId, cooldowns, now = Date.now()) {
  const ms = ACTION_COOLDOWN_MS[actionId];
  if (!ms || !cooldowns) return;
  cooldowns.set(actionId, now + ms);
}

/**
 * @typedef {{
 *   zoneId: ZoneId,
 *   spaces: { left:number,right:number,above:number,below:number },
 *   idleWeights: Record<string, number>,
 *   roam: { roamChanceMul: number, walkVsHop: number, preferDir: number|null },
 *   facingHint: "left"|"right"|null,
 *   sampledAt: number,
 * }} ZoneSnapshot
 */

/**
 * @param {{
 *   getBounds: () => Promise<object|null>,
 *   getWorkArea: () => Promise<object|null>,
 *   enabled?: () => boolean,
 * }} deps
 */
export function createZoneTracker(deps) {
  const { getBounds, getWorkArea, enabled = () => true } = deps;

  let bootAt = 0;
  /** @type {ZoneId|null} */
  let zoneId = null;
  let enteredAt = 0;
  /** @type {ZoneSnapshot|null} */
  let cache = null;
  let sampleInFlight = null;

  function isOn() {
    try {
      return typeof enabled === "function" ? enabled() : Boolean(enabled);
    } catch {
      return true;
    }
  }

  function buildSnapshot(spaces, z, now) {
    /** @type {ZoneSnapshot} */
    const snap = {
      zoneId: z,
      spaces,
      idleWeights: zoneIdleWeights(z, { bootAt, now }),
      roam: zoneRoamBias(z),
      facingHint: zoneFacingHint(z),
      sampledAt: now,
    };
    return snap;
  }

  function withTimeout(promise, ms) {
    return new Promise((resolve) => {
      let settled = false;
      const t = setTimeout(() => {
        if (settled) return;
        settled = true;
        resolve(null);
      }, ms);
      Promise.resolve(promise)
        .then((v) => {
          if (settled) return;
          settled = true;
          clearTimeout(t);
          resolve(v);
        })
        .catch(() => {
          if (settled) return;
          settled = true;
          clearTimeout(t);
          resolve(null);
        });
    });
  }

  async function sampleRects() {
    const pair = Promise.all([
      Promise.resolve(getBounds?.() ?? null).catch(() => null),
      Promise.resolve(getWorkArea?.() ?? null).catch(() => null),
    ]);
    const result = await withTimeout(pair, ZONE_CONFIG.IPC_TIMEOUT_MS);
    if (!result) return null;
    const [bounds, workArea] = result;
    if (!bounds || !workArea) return null;
    if (
      typeof bounds.x !== "number" ||
      typeof bounds.y !== "number" ||
      typeof bounds.width !== "number" ||
      typeof bounds.height !== "number"
    ) {
      return null;
    }
    if (
      typeof workArea.x !== "number" ||
      typeof workArea.y !== "number" ||
      typeof workArea.width !== "number" ||
      typeof workArea.height !== "number"
    ) {
      return null;
    }
    return { bounds, workArea };
  }

  /**
   * @param {{ force?: boolean }} [opts]
   * @returns {Promise<ZoneSnapshot|null>}
   */
  async function refresh(opts = {}) {
    if (!isOn()) return null;

    if (sampleInFlight) {
      return sampleInFlight;
    }

    sampleInFlight = (async () => {
      try {
        const rects = await sampleRects();
        if (!rects) return cache;

        const now = Date.now();
        const spaces = computeSpaces(rects.bounds, rects.workArea);
        const next = resolveZone(spaces, zoneId, now, {
          force: Boolean(opts.force),
          enteredAt: zoneId ? enteredAt : null,
        });

        if (next !== zoneId) {
          zoneId = next;
          enteredAt = now;
        } else if (!zoneId) {
          zoneId = next;
          enteredAt = now;
        }

        cache = buildSnapshot(spaces, zoneId, now);
        return cache;
      } finally {
        sampleInFlight = null;
      }
    })();

    return sampleInFlight;
  }

  /**
   * @param {{ ensureFresh?: boolean }} [opts]
   * @returns {ZoneSnapshot|null|Promise<ZoneSnapshot|null>}
   */
  function getSnapshot(opts = {}) {
    if (!isOn()) return null;
    const now = Date.now();
    const fresh =
      cache && now - cache.sampledAt <= ZONE_CONFIG.SNAPSHOT_FRESH_MS;
    if (opts.ensureFresh && !fresh) {
      return refresh({ force: false });
    }
    return cache;
  }

  /**
   * @param {{ ensureFresh?: boolean }} [opts]
   */
  async function getRoamBias(opts = {}) {
    const snap = await Promise.resolve(getSnapshot(opts));
    if (!snap) {
      return { roamChanceMul: 1, walkVsHop: 0.82, preferDir: null, zoneId: null };
    }
    return { ...snap.roam, zoneId: snap.zoneId };
  }

  function getZoneId() {
    return zoneId || cache?.zoneId || null;
  }

  function start() {
    bootAt = Date.now();
    // Warm cache lazily on first ensureFresh; optional silent warm:
    void refresh({ force: true }).catch(() => {});
  }

  function stop() {
    // keep cache for debug; no timers to clear
  }

  return {
    start,
    stop,
    refresh,
    getSnapshot,
    getRoamBias,
    getZoneId,
  };
}
