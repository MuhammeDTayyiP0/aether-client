const {
  app,
  BrowserWindow,
  ipcMain,
  Tray,
  Menu,
  nativeImage,
  shell,
} = require("electron");
const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");

let win = null;
let tray = null;
let child = null;
let activeId = null;

function storePath() {
  return path.join(app.getPath("userData"), "profiles.json");
}

function loadStore() {
  try {
    return JSON.parse(fs.readFileSync(storePath(), "utf8"));
  } catch {
    return { profiles: [], locale: "tr" };
  }
}

function saveStore(data) {
  fs.mkdirSync(app.getPath("userData"), { recursive: true });
  fs.writeFileSync(storePath(), JSON.stringify(data, null, 2));
}

function corePath() {
  const name = process.platform === "win32" ? "aether-core.exe" : "aether-core";
  if (app.isPackaged) return path.join(process.resourcesPath, "bin", name);
  return path.join(__dirname, "..", "resources", "bin", name);
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function statusPayload(extra = {}) {
  return {
    running: Boolean(child),
    activeId,
    core: corePath(),
    coreOk: fs.existsSync(corePath()),
    ...extra,
  };
}

function stopCore() {
  if (!child) {
    activeId = null;
    send("status", statusPayload());
    return;
  }
  const proc = child;
  child = null;
  activeId = null;
  try {
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(proc.pid), "/f", "/t"], { windowsHide: true });
    } else {
      proc.kill("SIGTERM");
      setTimeout(() => {
        try {
          proc.kill("SIGKILL");
        } catch {
          /* already gone */
        }
      }, 1500);
    }
  } catch {
    /* ignore */
  }
  send("status", statusPayload());
}

function singboxFromVless(link) {
  const u = new URL(link.trim());
  if (u.protocol !== "vless:") throw new Error("vless:// bekleniyor");
  const uuid = decodeURIComponent(u.username);
  const host = u.hostname;
  const port = Number(u.port || 443);
  const q = u.searchParams;
  const name = decodeURIComponent(u.hash.replace(/^#/, "")) || host;
  const wsPath = decodeURIComponent(q.get("path") || "/");
  const sni = q.get("sni") || host;
  const fp = q.get("fp") || "chrome";
  const wsHost = q.get("host") || host;
  return {
    name,
    domain: host,
    config: {
      log: { level: "info", timestamp: true },
      dns: {
        servers: [
          { tag: "local", address: "local" },
          { tag: "cloud", address: "https://1.1.1.1/dns-query", detour: "proxy" },
        ],
        strategy: "prefer_ipv4",
      },
      inbounds: [
        { type: "mixed", tag: "mixed-in", listen: "127.0.0.1", listen_port: 1080 },
      ],
      outbounds: [
        {
          type: "vless",
          tag: "proxy",
          server: host,
          server_port: port,
          uuid,
          packet_encoding: "xudp",
          tls: {
            enabled: true,
            server_name: sni,
            utls: { enabled: true, fingerprint: fp },
          },
          transport: {
            type: "ws",
            path: wsPath,
            headers: { Host: wsHost },
          },
        },
        { type: "direct", tag: "direct" },
      ],
      route: {
        auto_detect_interface: true,
        rules: [
          { protocol: "dns", outbound: "proxy" },
          { ip_is_private: true, outbound: "direct" },
        ],
        final: "proxy",
      },
    },
  };
}

function domainFromConfig(cfg) {
  const o = (cfg.outbounds || []).find((x) => x.server);
  return o ? o.server : "aether";
}

function addFromText(raw) {
  const text = String(raw || "").trim();
  if (!text) throw new Error("Boş");
  const store = loadStore();
  let profile;
  if (text.startsWith("vless://")) {
    const parsed = singboxFromVless(text);
    profile = {
      id: `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
      name: parsed.name,
      domain: parsed.domain,
      config: parsed.config,
    };
  } else {
    const cfg = JSON.parse(text);
    if (!cfg.outbounds) throw new Error("sing-box JSON değil");
    profile = {
      id: `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
      name: cfg.outbounds.find((o) => o.tag === "proxy")?.server || domainFromConfig(cfg),
      domain: domainFromConfig(cfg),
      config: cfg,
    };
  }
  store.profiles.push(profile);
  saveStore(store);
  return store.profiles;
}

function startCore(id) {
  if (child) stopCore();
  const store = loadStore();
  const profile = store.profiles.find((p) => p.id === id);
  if (!profile) throw new Error("Düğüm yok");
  const bin = corePath();
  if (!fs.existsSync(bin)) {
    throw new Error("Çekirdek yok — uygulamayı GitHub Release paketinden kur");
  }
  const cfgPath = path.join(app.getPath("userData"), "active.json");
  fs.writeFileSync(cfgPath, JSON.stringify(profile.config, null, 2));
  const proc = spawn(bin, ["run", "-c", cfgPath], {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  child = proc;
  activeId = id;
  let errBuf = "";
  proc.stderr.on("data", (d) => {
    errBuf += d.toString();
    if (errBuf.length > 4000) errBuf = errBuf.slice(-2000);
  });
  proc.on("exit", (code) => {
    if (child === proc) {
      child = null;
      activeId = null;
      send("status", statusPayload({ lastError: errBuf || `çıkış ${code}` }));
    }
  });
  send("status", statusPayload());
  return statusPayload();
}

function createWindow() {
  win = new BrowserWindow({
    width: 380,
    height: 640,
    resizable: false,
    backgroundColor: "#0c0c0d",
    autoHideMenuBar: true,
    title: "Aether",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, "renderer", "index.html"));
  win.on("close", (e) => {
    if (child && process.platform === "win32") {
      e.preventDefault();
      win.hide();
    }
  });
}

function createTray() {
  const img = nativeImage.createFromDataURL(
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAGUlEQVRYR+3BAQEAAACCIP+vbkhAAQAA8GahFgAB2lO+XwAAAABJRU5ErkJggg=="
  );
  tray = new Tray(img.isEmpty() ? nativeImage.createEmpty() : img);
  const menu = () =>
    Menu.buildFromTemplate([
      { label: child ? "Bağlı" : "Kesik", enabled: false },
      {
        label: "Göster",
        click: () => {
          if (win) {
            win.show();
            win.focus();
          }
        },
      },
      { label: "Kes", click: () => stopCore() },
      { type: "separator" },
      { label: "Çık", click: () => { stopCore(); app.quit(); } },
    ]);
  tray.setToolTip("Aether");
  tray.setContextMenu(menu());
  setInterval(() => {
    try {
      tray.setContextMenu(menu());
    } catch {
      /* tray gone */
    }
  }, 2000);
}

app.whenReady().then(() => {
  createWindow();
  createTray();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    if (!child) app.quit();
  }
});

app.on("before-quit", () => stopCore());

ipcMain.handle("state", () => {
  const store = loadStore();
  return { ...statusPayload(), profiles: store.profiles, locale: store.locale || "tr" };
});
ipcMain.handle("set-locale", (_e, locale) => {
  const store = loadStore();
  store.locale = locale === "en" ? "en" : "tr";
  saveStore(store);
  return store.locale;
});
ipcMain.handle("add-profile", (_e, text) => addFromText(text));
ipcMain.handle("remove-profile", (_e, id) => {
  const store = loadStore();
  if (activeId === id) stopCore();
  store.profiles = store.profiles.filter((p) => p.id !== id);
  saveStore(store);
  return store.profiles;
});
ipcMain.handle("connect", (_e, id) => startCore(id));
ipcMain.handle("disconnect", () => {
  stopCore();
  return statusPayload();
});
ipcMain.handle("open-proxy", () => {
  shell.openExternal("http://127.0.0.1:1080");
});
