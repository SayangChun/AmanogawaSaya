// 注意：preload 与主进程一致用 CJS。原因见 main.js 头部注释——
// Electron 43 起 ESM import "electron" 会命中 npm stub，拿不到内置导出。
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("petApi", {
  focus: () => ipcRenderer.invoke("pet:focus"),
  hide: () => ipcRenderer.invoke("pet:hide"),
  /** Fire-and-forget relative move — avoids invoke backlog mid-drag. */
  moveBy: (delta) => {
    ipcRenderer.send("pet:move-by", delta);
  },
  /** Lock window size in main process while the pet is being dragged. */
  setDragging: (dragging) => {
    ipcRenderer.send("pet:set-dragging", dragging);
  },
  bounds: () => ipcRenderer.invoke("pet:bounds"),
  workArea: () => ipcRenderer.invoke("pet:work-area"),
  /** 系统输入空闲秒数（powerMonitor.getSystemIdleTime；不可用时 null） */
  idleSeconds: () => ipcRenderer.invoke("pet:idle-seconds"),
  /** 锁屏 / 解锁 / 挂起 / 恢复事件（她说「你回来了」的依据之一） */
  onSystemEvent: (handler) => {
    const listener = (_event, type) => handler(type);
    ipcRenderer.on("pet:system-event", listener);
    return () => ipcRenderer.removeListener("pet:system-event", listener);
  },
  /**
   * @param {string} mode
   * @param {{ dockPlacement?: "left" | "right", animate?: boolean, force?: boolean }} [options]
   */
  setMode: (mode, options) => ipcRenderer.invoke("pet:set-mode", mode, options),
  /**
   * Toggle OS-level mouse ignore so transparent pixels click through.
   * @param {boolean} ignore
   * @param {{ forward?: boolean }} [options] forward=true keeps mousemove for hit-test
   */
  setIgnoreMouseEvents: (ignore, options) => {
    ipcRenderer.send("pet:set-ignore-mouse", Boolean(ignore), {
      forward: options?.forward !== false,
    });
  },
  onSetMode: (handler) => {
    const listener = (_event, mode) => handler(mode);
    ipcRenderer.on("pet:set-mode", listener);
    return () => ipcRenderer.removeListener("pet:set-mode", listener);
  },
  /**
   * 记忆层：全部调用转发到主进程 memory-store。
   * 渲染进程不直接碰文件系统，主进程是唯一写入口。
   */
  memory: {
    getState: () => ipcRenderer.invoke("memory:get-state"),
    appendEvent: (ev) => ipcRenderer.invoke("memory:append-event", ev),
    addFact: (text, opts) => ipcRenderer.invoke("memory:add-fact", text, opts),
    removeFact: (id) => ipcRenderer.invoke("memory:remove-fact", id),
    addFollowUp: (input) => ipcRenderer.invoke("memory:add-followup", input),
    completeFollowUp: (id) => ipcRenderer.invoke("memory:complete-followup", id),
    dueFollowUps: () => ipcRenderer.invoke("memory:due-followups"),
    updateMood: (patch) => ipcRenderer.invoke("memory:update-mood", patch),
    appendJournal: (text) => ipcRenderer.invoke("memory:append-journal", text),
    migrateLegacy: (legacy) => ipcRenderer.invoke("memory:migrate-legacy", legacy),
  },
});
