import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("petApi", {
  focus: () => ipcRenderer.invoke("pet:focus"),
  hide: () => ipcRenderer.invoke("pet:hide"),
  move: (position) => ipcRenderer.invoke("pet:move", position),
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
  setMode: (mode) => ipcRenderer.invoke("pet:set-mode", mode),
  notify: (payload) => ipcRenderer.invoke("pet:notify", payload),
  getPath: (name) => ipcRenderer.invoke("pet:get-path", name),
  onSetMode: (handler) => {
    const listener = (_event, mode) => handler(mode);
    ipcRenderer.on("pet:set-mode", listener);
    return () => ipcRenderer.removeListener("pet:set-mode", listener);
  },
});
