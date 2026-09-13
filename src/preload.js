const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("aether", {
  state: () => ipcRenderer.invoke("state"),
  setLocale: (locale) => ipcRenderer.invoke("set-locale", locale),
  addProfile: (text) => ipcRenderer.invoke("add-profile", text),
  removeProfile: (id) => ipcRenderer.invoke("remove-profile", id),
  connect: (id) => ipcRenderer.invoke("connect", id),
  disconnect: () => ipcRenderer.invoke("disconnect"),
  openProxy: () => ipcRenderer.invoke("open-proxy"),
  onStatus: (fn) => {
    const h = (_e, payload) => fn(payload);
    ipcRenderer.on("status", h);
    return () => ipcRenderer.removeListener("status", h);
  },
});
