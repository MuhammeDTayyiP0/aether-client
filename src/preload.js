const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("aether", {
  state: () => ipcRenderer.invoke("state"),
  setLocale: (locale) => ipcRenderer.invoke("set-locale", locale),
  addProfile: (text) => ipcRenderer.invoke("add-profile", text),
  removeProfile: (id) => ipcRenderer.invoke("remove-profile", id),
  connect: (id) => ipcRenderer.invoke("connect", id),
  disconnect: () => ipcRenderer.invoke("disconnect"),
  refreshVlist: () => ipcRenderer.invoke("refresh-vlist"),
  onStatus: (fn) => {
    ipcRenderer.on("status", (_e, payload) => fn(payload));
  },
  onVlist: (fn) => {
    ipcRenderer.on("vlist", (_e, payload) => fn(payload));
  },
  onVlistError: (fn) => {
    ipcRenderer.on("vlist-error", (_e, payload) => fn(payload));
  },
});
