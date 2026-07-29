import {
  app,
  BrowserWindow,
  ipcMain,
  Menu,
  Tray,
  nativeImage,
  screen,
  Notification,
} from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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
 * `speak` grows upward for the dialogue bubble (bottom anchor fixed).
 * Mouse passthrough (renderer) lets empty pixels click through to the desktop.
 */
const WINDOW_MODES = {
  // Body only: pet-hit ~120×170 + minimal padding
  compact: { width: 136, height: 196 },
  // Bubble above body (short 1–2 line lines)
  speak: { width: 196, height: 272 },
  dock: { width: 280, height: 400 },
  panel: { width: 340, height: 520 },
};

function modeSize(mode = currentMode) {
  return WINDOW_MODES[mode] || WINDOW_MODES.compact;
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
 * Resize while keeping the character anchor (bottom-center of window) fixed.
 * No-ops size write when already in target dimensions (avoids jitter while dragging).
 * Blocked while the user is dragging the pet (window must not grow mid-drag).
 */
function setMode(mode, { animate = false, force = false } = {}) {
  // Stage focus: only compact / speak chrome — no dock / panel.
  if (mode === "dock" || mode === "panel") {
    mode = "compact";
  }
  // Menu needs roughly the same footprint as the speech bubble layout.
  if (mode === "menu") {
    mode = "speak";
  }
  if (!mainWindow || !WINDOW_MODES[mode]) return null;

  // Never change window size during an active drag session.
  if (windowDragging && !force) {
    return { mode: currentMode, ...mainWindow.getBounds(), blocked: true };
  }

  const next = WINDOW_MODES[mode];
  const current = mainWindow.getBounds();
  currentMode = mode;

  if (
    !force &&
    current.width === next.width &&
    current.height === next.height
  ) {
    return { mode, ...current, skipped: true };
  }

  const anchorX = current.x + current.width / 2;
  const anchorY = current.y + current.height - 20;

  let x = Math.round(anchorX - next.width / 2);
  let y = Math.round(anchorY - next.height + 20);
  ({ x, y } = clampToWorkArea(x, y, next.width, next.height));

  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    const fallback = defaultPosition(next);
    x = fallback.x;
    y = fallback.y;
  }

  const bounds = {
    x: Math.round(x),
    y: Math.round(y),
    width: next.width,
    height: next.height,
  };
  mainWindow.setBounds(bounds, animate);
  savePersistedBounds(bounds, { immediate: true });
  return { mode, ...bounds };
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

app.whenReady().then(() => {
  // Windows: group taskbar / toast notifications under a stable app id
  if (process.platform === "win32") {
    app.setAppUserModelId("com.amanogawa.saya.desktop-pet");
  }

  createWindow();
  createTray();

  ipcMain.handle("pet:focus", () => {
    mainWindow?.show();
    mainWindow?.focus();
  });

  ipcMain.handle("pet:hide", () => {
    mainWindow?.hide();
  });

  ipcMain.handle("pet:move", (_e, position) => {
    if (!mainWindow) return null;
    const x = Number(position?.x);
    const y = Number(position?.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;

    const size = modeSize();
    const next = clampToWorkArea(Math.round(x), Math.round(y), size.width, size.height);
    if (!Number.isFinite(next.x) || !Number.isFinite(next.y)) return null;

    const bounds = { x: next.x, y: next.y, width: size.width, height: size.height };
    mainWindow.setBounds(bounds, false);
    savePersistedBounds(bounds, { immediate: true });
    return bounds;
  });

  /** Relative move — fire-and-forget path preferred for drag smoothness. */
  ipcMain.handle("pet:move-by", (_e, delta) =>
    moveWindowBy(Number(delta?.dx), Number(delta?.dy)),
  );

  ipcMain.on("pet:move-by", (_e, delta) => {
    moveWindowBy(Number(delta?.dx), Number(delta?.dy));
  });

  ipcMain.handle("pet:set-dragging", (_e, dragging) => setWindowDragging(dragging));
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

  ipcMain.handle("pet:set-mode", (_e, mode) => setMode(mode));

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

  ipcMain.handle("pet:notify", (_e, payload) => {
    if (!Notification.isSupported()) return false;
    const n = new Notification({
      title: payload?.title || "天之川沙夜",
      body: payload?.body || "",
      silent: Boolean(payload?.silent),
      ...(APP_ICON_PATH ? { icon: APP_ICON_PATH } : {}),
    });
    n.on("click", () => {
      mainWindow?.show();
      mainWindow?.focus();
    });
    n.show();
    return true;
  });

  ipcMain.handle("pet:get-path", (_e, name) => {
    if (name === "userData") return app.getPath("userData");
    return null;
  });
});

app.on("window-all-closed", (event) => {
  event.preventDefault();
});

app.on("before-quit", () => {
  isQuitting = true;
});
