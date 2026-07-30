const STORAGE_KEY = "amanogawa.saya.pet.v3";

export const DEFAULT_STATE = {
  version: 3,
  mode: "compact", // compact | dock
  affinity: 12,
  totalInteractions: 0,
  lastScene: "boot",
  lastLine: "",
};

export function loadState() {
  try {
    let raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      raw = localStorage.getItem("amanogawa.saya.pet.v2");
    }
    if (!raw) return { ...DEFAULT_STATE };
    const parsed = JSON.parse(raw);
    return {
      ...DEFAULT_STATE,
      affinity: Math.min(100, Number(parsed.affinity) || DEFAULT_STATE.affinity),
      totalInteractions: Number(parsed.totalInteractions) || 0,
      lastScene: parsed.lastScene || DEFAULT_STATE.lastScene,
      lastLine: parsed.lastLine || "",
      mode: ["compact", "dock"].includes(parsed.mode) ? parsed.mode : "compact",
      version: 3,
    };
  } catch {
    return { ...DEFAULT_STATE };
  }
}

export function saveState(state) {
  try {
    const slim = {
      version: 3,
      mode: state.mode === "dock" ? "dock" : "compact",
      affinity: state.affinity,
      totalInteractions: state.totalInteractions || 0,
      lastScene: state.lastScene || "",
      lastLine: state.lastLine || "",
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(slim));
  } catch {
    // quota / private mode
  }
}

/**
 * Small pure helpers around affinity for future systems.
 */
export function gainAffinity(state, amount = 1) {
  const next = Math.min(100, (state.affinity || 0) + amount);
  const gained = next > state.affinity;
  return {
    ...state,
    affinity: next,
    totalInteractions: (state.totalInteractions || 0) + 1,
    _affinityGained: gained && amount > 0,
  };
}
