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

/** Window modes: compact full-body VPet + bubble / interactive dock / full panel */
const WINDOW_MODES = {
  // Taller compact: room for speech bubble above full-body sprite
  compact: { width: 220, height: 320 },
  dock: { width: 300, height: 420 },
  panel: { width: 360, height: 560 },
};

function modeSize(mode = currentMode) {
  return WINDOW_MODES[mode] || WINDOW_MODES.compact;
}

const STATE_PATH = path.join(app.getPath("userData"), "saya-pet-state.json");

const trayIcon = nativeImage.createFromDataURL(
  "data:image/svg+xml;charset=UTF-8," +
    encodeURIComponent(`
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
        <defs>
          <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stop-color="#e8f0ff"/>
            <stop offset="55%" stop-color="#8eb0e8"/>
            <stop offset="100%" stop-color="#4a6fa5"/>
          </linearGradient>
          <linearGradient id="r" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stop-color="#5ec8e8"/>
            <stop offset="100%" stop-color="#3aa8d0"/>
          </linearGradient>
        </defs>
        <rect width="64" height="64" rx="18" fill="#0b1220"/>
        <circle cx="32" cy="28" r="14" fill="url(#g)"/>
        <ellipse cx="24" cy="27" rx="2.2" ry="2.8" fill="#c9a227"/>
        <ellipse cx="40" cy="27" rx="2.2" ry="2.8" fill="#4a9fd4"/>
        <path d="M26 35c2.5 2.2 9.5 2.2 12 0" stroke="#f0f4ff" stroke-width="1.8" stroke-linecap="round" fill="none"/>
        <path d="M42 14c3-1 7 1 8 5" stroke="url(#r)" stroke-width="2" stroke-linecap="round" fill="none"/>
        <circle cx="50" cy="12" r="2" fill="#7fd4f0"/>
      </svg>
    `),
);

function loadPersistedBounds() {
  try {
    if (!fs.existsSync(STATE_PATH)) return null;
    const data = JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
    return data?.bounds ?? null;
  } catch {
    return null;
  }
}

function savePersistedBounds(bounds) {
  try {
    let existing = {};
    if (fs.existsSync(STATE_PATH)) {
      existing = JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
    }
    existing.bounds = bounds;
    fs.writeFileSync(STATE_PATH, JSON.stringify(existing, null, 2), "utf8");
  } catch {
    // ignore persistence errors
  }
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
  // Stage focus: only compact window — no dock / panel chrome.
  if (mode === "dock" || mode === "panel") {
    mode = "compact";
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
  savePersistedBounds(bounds);
  return { mode, ...bounds };
}

/** Move window without changing size; always re-assert mode dimensions. */
function moveWindowBy(dx, dy) {
  if (!mainWindow) return null;
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return null;

  const size = modeSize();
  const { x, y } = mainWindow.getBounds();
  if (dx === 0 && dy === 0) {
    return { x, y, width: size.width, height: size.height };
  }

  const next = clampToWorkArea(
    Math.round(x + dx),
    Math.round(y + dy),
    size.width,
    size.height,
  );
  if (!Number.isFinite(next.x) || !Number.isFinite(next.y)) return null;

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
      savePersistedBounds(bounds);
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
    savePersistedBounds(bounds);
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

  ipcMain.handle("pet:set-mode", (_e, mode) => setMode(mode));

  ipcMain.handle("pet:notify", (_e, payload) => {
    if (!Notification.isSupported()) return false;
    const n = new Notification({
      title: payload?.title || "天之川沙夜",
      body: payload?.body || "",
      silent: Boolean(payload?.silent),
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
