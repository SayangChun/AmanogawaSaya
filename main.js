// 注意：主进程必须用 CJS。Electron 43 起 ESM 的 import ... from "electron"
// 会解析到 node_modules/electron 这个 npm stub（导出的是可执行文件路径），
// 拿不到 app/BrowserWindow 等内置导出。require("electron") 才命中内置模块。
const {
  app,
  BrowserWindow,
  ipcMain,
  Menu,
  Tray,
  nativeImage,
  screen,
  powerMonitor,
} = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const { createMemoryStore } = require("./src/memory/memory-store.js");

/** @type {BrowserWindow | null} */
let mainWindow = null;
/** @type {Tray | null} */
let tray = null;
let isQuitting = false;
/** Current logical window mode — used to lock size while dragging */
let currentMode = "compact";
/** When true, refuse setMode resizes (prevents drag → window grow) */
let windowDragging = false;

/**
 * Window modes — sized tightly around the full-body sprite so the
 * transparent chrome does not occupy a large desktop rectangle.
 * Resizes keep the character *body center-X* and *feet-Y* fixed on screen,
 * so a side dock can open left/right without Saya or her bubble jumping.
 * Mouse passthrough (renderer) lets empty pixels click through to the desktop.
 */
/** Character column width (sprite + horizontal pad) while dock is open. */
const BODY_COL = 132;

/** @type {import("./src/memory/memory-store.js").ReturnType | null} */
let memory = null;

const WINDOW_MODES = {
  // Body only: pet-hit ~120×170 + minimal padding
  compact: { width: 136, height: 196 },
  // Bubble above body (short 1–2 line lines)
  speak: { width: 196, height: 272 },
  // Body + vertical side dock (8 action buttons)
  dock: { width: 204, height: 312 },
  // Side dock + secondary stats submenu (affinity / counts / facts)
  dockStats: { width: 360, height: 312 },
  // Companion chat: bubble + scrollback + input row (feet lifted for input)
  chat: { width: 420, height: 440 },
};

/**
 * Anchor inset from window bottom to the character feet line.
 * Side dock grows horizontally (and upward if taller); feet stay at bottom.
 */
const FEET_PAD = 20;

/** @type {"left" | "right"} dock placement relative to the character */
let currentDockPlacement = "right";

function modeSize(mode = currentMode) {
  return WINDOW_MODES[mode] || WINDOW_MODES.compact;
}

/**
 * Distance from window bottom to the character feet anchor.
 * @param {string} [_mode]
 * @param {"left" | "right"} [_placement]
 */
function feetFromBottom(_mode, _placement = currentDockPlacement) {
  return FEET_PAD;
}

/**
 * Character body center-X within the window (for horizontal anchor on resize).
 * Side dock places the sprite in the left or right body column — not window center.
 * @param {string} mode
 * @param {"left" | "right"} placement
 * @param {number} width
 */
function bodyCenterFromLeft(mode, placement, width) {
  if (mode === "dock" || mode === "dockStats") {
    if (placement === "left") {
      // Dock on the left → sprite column on the right.
      return width - BODY_COL / 2;
    }
    // Dock on the right → sprite column on the left.
    return BODY_COL / 2;
  }
  return width / 2;
}

const STATE_PATH = path.join(app.getPath("userData"), "saya-pet-state.json");

/** App / window icon (Windows prefers .ico; PNG works cross-platform). */
const APP_ICON_PATH = (() => {
  const ico = path.join(__dirname, "assets", "icons", "icon.ico");
  const png = path.join(__dirname, "assets", "icons", "icon.png");
  if (process.platform === "win32" && fs.existsSync(ico)) return ico;
  if (fs.existsSync(png)) return png;
  return null;
})();

/**
 * Load tray bitmap. Windows tray does not reliably render SVG data-URLs;
 * use a small PNG so the icon actually appears in the notification area.
 */
function loadTrayIcon() {
  const candidates = [
    path.join(__dirname, "assets", "icons", "tray-32.png"),
    path.join(__dirname, "assets", "icons", "tray.png"),
    path.join(__dirname, "assets", "icons", "icon.png"),
    APP_ICON_PATH,
  ].filter(Boolean);

  for (const p of candidates) {
    if (!fs.existsSync(p)) continue;
    const img = nativeImage.createFromPath(p);
    if (img && !img.isEmpty()) {
      // Prefer 16–32px for the notification area on Windows.
      if (img.getSize().width > 32) {
        return img.resize({ width: 32, height: 32, quality: "best" });
      }
      return img;
    }
  }

  // Last-resort 1×1 so Tray construction never throws.
  return nativeImage.createEmpty();
}

const trayIcon = loadTrayIcon();

function loadPersistedBounds() {
  try {
    if (!fs.existsSync(STATE_PATH)) return null;
    const data = JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
    return data?.bounds ?? null;
  } catch {
    return null;
  }
}

/** @type {ReturnType<typeof setTimeout> | null} */
let persistBoundsTimer = null;
/** @type {{ x: number, y: number, width: number, height: number } | null} */
let pendingPersistBounds = null;

function savePersistedBounds(bounds, { immediate = false } = {}) {
  if (!bounds) return;
  pendingPersistBounds = {
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
  };

  const flush = () => {
    persistBoundsTimer = null;
    const toSave = pendingPersistBounds;
    pendingPersistBounds = null;
    if (!toSave) return;
    try {
      let existing = {};
      if (fs.existsSync(STATE_PATH)) {
        existing = JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
      }
      existing.bounds = toSave;
      fs.writeFileSync(STATE_PATH, JSON.stringify(existing, null, 2), "utf8");
    } catch {
      // ignore persistence errors
    }
  };

  if (immediate) {
    if (persistBoundsTimer) {
      clearTimeout(persistBoundsTimer);
      persistBoundsTimer = null;
    }
    flush();
    return;
  }

  // Walk/hop moves every frame — debounce disk writes so locomotion stays smooth.
  if (persistBoundsTimer) return;
  persistBoundsTimer = setTimeout(flush, 400);
}

function defaultPosition(size) {
  const { workArea } = screen.getPrimaryDisplay();
  return {
    x: workArea.x + workArea.width - size.width - 24,
    y: workArea.y + workArea.height - size.height - 24,
  };
}

function clampToWorkArea(x, y, width, height) {
  const displays = screen.getAllDisplays();
  let best = screen.getPrimaryDisplay().workArea;
  let bestArea = 0;

  for (const d of displays) {
    const wa = d.workArea;
    const overlapX = Math.max(0, Math.min(x + width, wa.x + wa.width) - Math.max(x, wa.x));
    const overlapY = Math.max(0, Math.min(y + height, wa.y + wa.height) - Math.max(y, wa.y));
    const area = overlapX * overlapY;
    if (area > bestArea) {
      bestArea = area;
      best = wa;
    }
  }

  return {
    x: Math.min(Math.max(x, best.x), best.x + best.width - width),
    y: Math.min(Math.max(y, best.y), best.y + best.height - height),
  };
}

/**
 * Resize while keeping the character *body center-X* and *feet-Y* fixed.
 * Dock placement (`left` | `right`) decides which side extra chrome grows
 * so Saya and her dialogue bubble do not jump when the shortcut bar opens.
 * No-ops when already at target size + placement (avoids jitter while dragging).
 * Blocked while the user is dragging the pet (window must not grow mid-drag).
 *
 * @param {string} mode
 * @param {{
 *   animate?: boolean,
 *   force?: boolean,
 *   dockPlacement?: "left" | "right",
 *   prevFeetFromBottom?: number,
 *   feetFromBottom?: number,
 * }} [opts]
 */
function setMode(
  mode,
  {
    animate = false,
    force = false,
    dockPlacement,
    prevFeetFromBottom: prevFeetOverride,
    feetFromBottom: nextFeetOverride,
  } = {},
) {
  // Legacy aliases
  if (mode === "panel" || mode === "menu") {
    mode = mode === "menu" ? "speak" : "compact";
  }
  if (!mainWindow || !WINDOW_MODES[mode]) return null;

  // Never change window size during an active drag session.
  if (windowDragging && !force) {
    return { mode: currentMode, ...mainWindow.getBounds(), blocked: true };
  }

  // Map legacy above/below → right/left so older callers stay safe.
  let requested = dockPlacement;
  if (requested === "above" || requested === "below") {
    requested = requested === "above" ? "left" : "right";
  }

  const nextPlacement =
    mode === "dock" || mode === "dockStats"
      ? requested === "left" || requested === "right"
        ? requested
        : currentDockPlacement
      : "right";

  const next = WINDOW_MODES[mode];
  const current = mainWindow.getBounds();
  const prevMode = currentMode;
  const prevPlacement = currentDockPlacement;

  if (
    !force &&
    current.width === next.width &&
    current.height === next.height &&
    prevMode === mode &&
    prevPlacement === nextPlacement &&
    prevFeetOverride == null &&
    nextFeetOverride == null
  ) {
    return { mode, ...current, skipped: true };
  }

  // Body screen position before resize (body center-X + feet-Y).
  // Renderer may pass measured feet insets when layout differs slightly.
  const prevFeet =
    typeof prevFeetOverride === "number" && Number.isFinite(prevFeetOverride)
      ? prevFeetOverride
      : feetFromBottom(prevMode, prevPlacement);
  const nextFeet =
    typeof nextFeetOverride === "number" && Number.isFinite(nextFeetOverride)
      ? nextFeetOverride
      : feetFromBottom(mode, nextPlacement);
  const prevBodyCx = bodyCenterFromLeft(prevMode, prevPlacement, current.width);
  const nextBodyCx = bodyCenterFromLeft(mode, nextPlacement, next.width);
  const anchorX = current.x + prevBodyCx;
  const anchorY = current.y + current.height - prevFeet;

  let x = Math.round(anchorX - nextBodyCx);
  let y = Math.round(anchorY - (next.height - nextFeet));
  ({ x, y } = clampToWorkArea(x, y, next.width, next.height));

  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    const fallback = defaultPosition(next);
    x = fallback.x;
    y = fallback.y;
  }

  currentMode = mode;
  currentDockPlacement = nextPlacement;

  const bounds = {
    x: Math.round(x),
    y: Math.round(y),
    width: next.width,
    height: next.height,
  };
  mainWindow.setBounds(bounds, animate);
  savePersistedBounds(bounds, { immediate: true });
  return { mode, dockPlacement: nextPlacement, ...bounds };
}

/** Move window without changing size; always re-assert mode dimensions. */
function moveWindowBy(dx, dy) {
  if (!mainWindow) return null;
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return null;
  if (dx === 0 && dy === 0) return null;

  const size = modeSize();
  const { x, y } = mainWindow.getBounds();
  // Prefer whole-pixel steps from the renderer (wander accumulates sub-pixels).
  // Math.round still accepts drag deltas that land on a new integer cell.
  const targetX = Math.round(x + dx);
  const targetY = Math.round(y + dy);
  if (targetX === x && targetY === y) {
    return { x, y, width: size.width, height: size.height };
  }

  const next = clampToWorkArea(targetX, targetY, size.width, size.height);
  if (!Number.isFinite(next.x) || !Number.isFinite(next.y)) return null;

  // No-op if clamp (edge of work area) cancelled the move.
  if (next.x === x && next.y === y) {
    return { x, y, width: size.width, height: size.height };
  }

  // setBounds with fixed size — setPosition alone can drift size on some DPI paths
  const bounds = {
    x: next.x,
    y: next.y,
    width: size.width,
    height: size.height,
  };
  mainWindow.setBounds(bounds, false);
  savePersistedBounds(bounds);
  return bounds;
}

function setWindowDragging(dragging) {
  windowDragging = Boolean(dragging);
  if (!windowDragging && mainWindow) {
    // Re-assert correct size after drag ends (in case anything drifted).
    const size = modeSize();
    const b = mainWindow.getBounds();
    if (b.width !== size.width || b.height !== size.height) {
      const bounds = { x: b.x, y: b.y, width: size.width, height: size.height };
      mainWindow.setBounds(bounds, false);
      savePersistedBounds(bounds, { immediate: true });
    }
  }
  return windowDragging;
}

function createWindow() {
  const size = WINDOW_MODES.compact;
  const saved = loadPersistedBounds();
  let x;
  let y;
  if (saved && typeof saved.x === "number" && typeof saved.y === "number") {
    ({ x, y } = clampToWorkArea(saved.x, saved.y, size.width, size.height));
  } else {
    ({ x, y } = defaultPosition(size));
  }

  mainWindow = new BrowserWindow({
    width: size.width,
    height: size.height,
    x,
    y,
    frame: false,
    transparent: true,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    movable: true,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    show: false,
    backgroundColor: "#00000000",
    ...(APP_ICON_PATH ? { icon: APP_ICON_PATH } : {}),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  mainWindow.setAlwaysOnTop(true, "screen-saver");
  mainWindow.loadFile(path.join(__dirname, "index.html"));

  mainWindow.once("ready-to-show", () => {
    mainWindow?.showInactive();
  });

  mainWindow.on("moved", () => {
    if (!mainWindow) return;
    savePersistedBounds(mainWindow.getBounds());
  });

  mainWindow.on("close", (event) => {
    if (isQuitting) return;
    event.preventDefault();
    mainWindow.hide();
  });
}

function createTray() {
  tray = new Tray(trayIcon);
  tray.setToolTip("天之川沙夜 · 桌面陪伴");
  // Stage focus: tray only for show / hide / quit — no panel entry.
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: "显示沙夜",
        click: () => {
          mainWindow?.show();
          mainWindow?.focus();
          mainWindow?.webContents.send("pet:set-mode", "compact");
          setMode("compact");
        },
      },
      {
        label: "隐藏到托盘",
        click: () => mainWindow?.hide(),
      },
      { type: "separator" },
      {
        label: "退出",
        click: () => {
          isQuitting = true;
          app.quit();
        },
      },
    ]),
  );

  tray.on("double-click", () => {
    if (!mainWindow) return;
    if (mainWindow.isVisible()) {
      mainWindow.focus();
    } else {
      mainWindow.show();
    }
  });
}

// Single instance: a companion should never exist twice on one desktop.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isVisible()) mainWindow.focus();
    else mainWindow.show();
  });

  app.whenReady().then(() => {
    // Windows: group taskbar / toast notifications under a stable app id
    if (process.platform === "win32") {
      app.setAppUserModelId("com.amanogawa.saya.desktop-pet");
    }

    memory = createMemoryStore({ dir: path.join(app.getPath("userData"), "saya") });

    createWindow();
    createTray();

    ipcMain.handle("pet:focus", () => {
      mainWindow?.show();
      mainWindow?.focus();
    });

    ipcMain.handle("pet:hide", () => {
      mainWindow?.hide();
    });

    /** —— 记忆层（主进程唯一写入口，renderer 经 IPC 访问） —— */
    ipcMain.handle("memory:get-state", () => {
      try {
        return { ok: true, snapshot: memory?.snapshot() ?? null };
      } catch (err) {
        return { ok: false, error: String(err?.message || err) };
      }
    });

    ipcMain.handle("memory:append-event", (_e, ev) => {
      try {
        return { ok: true, event: memory?.appendEvent(ev) ?? null };
      } catch (err) {
        return { ok: false, error: String(err?.message || err) };
      }
    });

    ipcMain.handle("memory:add-fact", (_e, text, opts) => {
      try {
        return { ok: true, fact: memory?.addFact(text, opts || {}) ?? null };
      } catch (err) {
        return { ok: false, error: String(err?.message || err) };
      }
    });

    ipcMain.handle("memory:remove-fact", (_e, id) => {
      try {
        return { ok: true, removed: memory?.removeFact(id) ?? false };
      } catch (err) {
        return { ok: false, error: String(err?.message || err) };
      }
    });

    ipcMain.handle("memory:add-followup", (_e, input) => {
      try {
        return { ok: true, followUp: memory?.addFollowUp(input) ?? null };
      } catch (err) {
        return { ok: false, error: String(err?.message || err) };
      }
    });

    ipcMain.handle("memory:complete-followup", (_e, id) => {
      try {
        return { ok: true, completed: memory?.completeFollowUp(id) ?? false };
      } catch (err) {
        return { ok: false, error: String(err?.message || err) };
      }
    });

    ipcMain.handle("memory:due-followups", () => {
      try {
        return { ok: true, due: memory?.dueFollowUps() ?? [] };
      } catch (err) {
        return { ok: false, error: String(err?.message || err) };
      }
    });

    ipcMain.handle("memory:update-mood", (_e, patch) => {
      try {
        return { ok: true, mood: memory?.updateMood(patch) ?? null };
      } catch (err) {
        return { ok: false, error: String(err?.message || err) };
      }
    });

    ipcMain.handle("memory:append-journal", (_e, text) => {
      try {
        return { ok: true, entry: memory?.appendJournal(text) ?? null };
      } catch (err) {
        return { ok: false, error: String(err?.message || err) };
      }
    });

    ipcMain.handle("memory:migrate-legacy", (_e, legacy) => {
      try {
        return { ok: true, result: memory?.migrateLegacy(legacy) ?? null };
      } catch (err) {
        return { ok: false, error: String(err?.message || err) };
      }
    });

  /** Relative move — fire-and-forget path preferred for drag smoothness. */
  ipcMain.on("pet:move-by", (_e, delta) => {
    moveWindowBy(Number(delta?.dx), Number(delta?.dy));
  });

  ipcMain.on("pet:set-dragging", (_e, dragging) => {
    setWindowDragging(dragging);
  });

  ipcMain.handle("pet:bounds", () => mainWindow?.getBounds() ?? null);

  /** Work area of the display that currently holds the pet window. */
  ipcMain.handle("pet:work-area", () => {
    if (!mainWindow) return null;
    const bounds = mainWindow.getBounds();
    const display = screen.getDisplayMatching(bounds);
    return display?.workArea ?? screen.getPrimaryDisplay().workArea;
  });

  /** —— 直播感观察：系统输入空闲（她据此知道你在不在电脑前） —— */
  ipcMain.handle("pet:idle-seconds", () => {
    try {
      return Number.isFinite(powerMonitor.getSystemIdleTime?.())
        ? Math.max(0, Math.round(powerMonitor.getSystemIdleTime()))
        : null;
    } catch {
      return null;
    }
  });

  /**
   * 锁屏 / 解锁 / 挂起 / 恢复 → 转发给渲染层（她对你的来留有反应）。
   * 只在窗口存活时发送；powerMonitor 事件 app ready 后才可靠。
   */
  {
    /** @param {string} type */
    const forward = (type) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("pet:system-event", type);
      }
    };
    powerMonitor.on("lock-screen", () => forward("lock-screen"));
    powerMonitor.on("unlock-screen", () => forward("unlock-screen"));
    powerMonitor.on("suspend", () => forward("suspend"));
    powerMonitor.on("resume", () => forward("resume"));
  }

  ipcMain.handle("pet:set-mode", (_e, mode, options) =>
    setMode(mode, options && typeof options === "object" ? options : {}),
  );

  /**
   * Click-through for transparent desktop-pet chrome.
   * When ignore=true + forward, empty pixels pass to apps below while the
   * renderer still receives mousemove for hover hit-testing.
   */
  ipcMain.on("pet:set-ignore-mouse", (_e, ignore, options) => {
    if (!mainWindow) return;
    if (ignore) {
      mainWindow.setIgnoreMouseEvents(true, {
        forward: options?.forward !== false,
      });
    } else {
      mainWindow.setIgnoreMouseEvents(false);
    }
  });
  });

  app.on("window-all-closed", (event) => {
    event.preventDefault();
  });

  app.on("before-quit", () => {
    isQuitting = true;
  });
}
