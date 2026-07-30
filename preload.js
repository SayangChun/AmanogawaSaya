import { contextBridge, ipcRenderer } from "electron";

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
  /**
   * @param {string} mode
   * @param {{ dockPlacement?: "above" | "below", animate?: boolean, force?: boolean }} [options]
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
});
