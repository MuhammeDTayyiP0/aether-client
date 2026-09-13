const {
  app,
  BrowserWindow,
  ipcMain,
  Tray,
  Menu,
  nativeImage,
  powerMonitor,
} = require("electron");
const path = require("path");
const fs = require("fs");
const https = require("https");
const http = require("http");
const { spawn } = require("child_process");

const VLIST_URLS = [
  "https://vlist.geldesat.com/list.json",
  "https://vlist.geldesat.com/list.txt",
  "https://vlist.geldesat.com/",
];

let win = null;
let tray = null;
let child = null;
let activeId = null;
let quitting = false;

function storePath() {
  return path.join(app.getPath("userData"), "profiles.json");
}
function pidPath() {
  return path.join(app.getPath("userData"), "core.pid");
}
function iconFile() {
  const local = path.join(__dirname, "icon.png");
  if (fs.existsSync(local)) return local;
  const packed = path.join(process.resourcesPath || "", "icon.png");
  if (packed && fs.existsSync(packed)) return packed;
  return local;
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
    vlist: VLIST_URLS[0],
    ...extra,
  };
}

function killPid(pid) {
  if (!pid) return;
  try {
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(pid), "/f", "/t"], { windowsHide: true, stdio: "ignore" });
    } else {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        /* gone */
      }
      setTimeout(() => {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          /* gone */
        }
      }, 800);
    }
  } catch {
    /* ignore */
  }
}

function killStale() {
  try {
    const pid = parseInt(fs.readFileSync(pidPath(), "utf8"), 10);
    if (pid && pid !== process.pid) killPid(pid);
  } catch {
    /* no pid file */
  }
  try {
    fs.unlinkSync(pidPath());
  } catch {
    /* ignore */
  }
}

function stopCore() {
  const proc = child;
  child = null;
  activeId = null;
  if (proc && proc.pid) killPid(proc.pid);
  try {
    fs.unlinkSync(pidPath());
  } catch {
    /* ignore */
  }
  send("status", statusPayload());
}

function fetchText(url, timeoutMs = 9000, hops = 0) {
  return new Promise((resolve, reject) => {
    if (hops > 5) return reject(new Error("redirect"));
    const lib = url.startsWith("http://") ? http : https;
    const req = lib.get(
      url,
      {
        headers: { "User-Agent": "AetherClient/1.1", Accept: "application/json, text/plain, */*" },
        timeout: timeoutMs,
      },
      (res) => {
        const loc = res.headers.location;
        if (res.statusCode >= 300 && res.statusCode < 400 && loc) {
          res.resume();
          const next = loc.startsWith("http") ? loc : new URL(loc, url).href;
          return fetchText(next, timeoutMs, hops + 1).then(resolve, reject);
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error("HTTP " + res.statusCode));
        }
        let d = "";
        res.setEncoding("utf8");
        res.on("data", (c) => {
          d += c;
          if (d.length > 2e6) {
            req.destroy();
            reject(new Error("liste çok büyük"));
          }
        });
        res.on("end", () => resolve(d));
      }
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("zaman aşımı"));
    });
  });
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
      log: { level: "warn", timestamp: true },
      dns: {
        servers: [
          { tag: "local", address: "local" },
          { tag: "cloud", address: "https://1.1.1.1/dns-query", detour: "proxy" },
        ],
        strategy: "prefer_ipv4",
      },
      inbounds: [{ type: "mixed", tag: "mixed-in", listen: "127.0.0.1", listen_port: 1080 }],
      outbounds: [
        {
          type: "vless",
          tag: "proxy",
          server: host,
          server_port: port,
          uuid,
          packet_encoding: "xudp",
          tls: { enabled: true, server_name: sni, utls: { enabled: true, fingerprint: fp } },
          transport: { type: "ws", path: wsPath, headers: { Host: wsHost } },
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

function itemToProfile(item, i) {
  if (typeof item === "string") {
    const parsed = singboxFromVless(item);
    return {
      id: "remote-" + i + "-" + parsed.domain,
      name: parsed.name,
      domain: parsed.domain,
      config: parsed.config,
      source: "remote",
    };
  }
  if (item && item.vless) {
    const parsed = singboxFromVless(item.vless);
    return {
      id: "remote-" + i + "-" + parsed.domain,
      name: item.name || parsed.name,
      domain: parsed.domain,
      config: parsed.config,
      source: "remote",
    };
  }
  if (item && item.config && item.config.outbounds) {
    return {
      id: "remote-" + i + "-" + domainFromConfig(item.config),
      name: item.name || domainFromConfig(item.config),
      domain: domainFromConfig(item.config),
      config: item.config,
      source: "remote",
    };
  }
  throw new Error("düğüm okunamadı");
}

function parseVlist(text) {
  const t = String(text || "").trim();
  if (!t) throw new Error("liste boş");
  if (t.startsWith("vless://")) {
    return t
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.startsWith("vless://") && !l.startsWith("#"));
  }
  const j = JSON.parse(t);
  if (Array.isArray(j)) return j;
  if (j.nodes) return j.nodes;
  if (j.vless || j.config) return [j];
  throw new Error("list.json biçimi hatalı");
}

async function pullVlist() {
  let lastErr = null;
  for (const url of VLIST_URLS) {
    try {
      const text = await fetchText(url);
      const items = parseVlist(text);
      const remote = items.map((it, i) => itemToProfile(it, i));
      if (!remote.length) throw new Error("düğüm yok");
      const store = loadStore();
      const local = (store.profiles || []).filter((p) => p.source === "local");
      store.profiles = remote.concat(local);
      store.remoteAt = new Date().toISOString();
      saveStore(store);
      return { profiles: store.profiles, remoteAt: store.remoteAt };
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error("liste alınamadı");
}

function addFromText(raw) {
  const text = String(raw || "").trim();
  if (!text) throw new Error("Boş");
  const store = loadStore();
  let profile;
  if (text.startsWith("vless://")) {
    const parsed = singboxFromVless(text);
    profile = {
      id: "local-" + Date.now(),
      name: parsed.name,
      domain: parsed.domain,
      config: parsed.config,
      source: "local",
    };
  } else {
    const cfg = JSON.parse(text);
    if (!cfg.outbounds) throw new Error("sing-box JSON değil");
    profile = {
      id: "local-" + Date.now(),
      name: domainFromConfig(cfg),
      domain: domainFromConfig(cfg),
      config: cfg,
      source: "local",
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
    throw new Error("Çekirdek yok — GitHub Release paketini kullan");
  }
  const cfgPath = path.join(app.getPath("userData"), "active.json");
  fs.writeFileSync(cfgPath, JSON.stringify(profile.config, null, 2));
  const proc = spawn(bin, ["run", "-c", cfgPath], {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    detached: false,
  });
  child = proc;
  activeId = id;
  try {
    fs.writeFileSync(pidPath(), String(proc.pid));
  } catch {
    /* ignore */
  }
  let errBuf = "";
  proc.stderr.on("data", (d) => {
    errBuf += d.toString();
    if (errBuf.length > 4000) errBuf = errBuf.slice(-2000);
  });
  proc.on("exit", (code) => {
    if (child === proc) {
      child = null;
      activeId = null;
      try {
        fs.unlinkSync(pidPath());
      } catch {
        /* ignore */
      }
      send("status", statusPayload({ lastError: code ? errBuf || "çıkış " + code : "" }));
    }
  });
  send("status", statusPayload());
  return statusPayload();
}

function createWindow() {
  const ico = iconFile();
  win = new BrowserWindow({
    width: 400,
    height: 680,
    resizable: false,
    backgroundColor: "#0b0b0c",
    autoHideMenuBar: true,
    title: "Aether",
    icon: fs.existsSync(ico) ? ico : undefined,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, "renderer", "index.html"));
  win.on("close", () => {
    stopCore();
  });
}

function createTray() {
  const ico = iconFile();
  let img = fs.existsSync(ico) ? nativeImage.createFromPath(ico) : nativeImage.createEmpty();
  if (!img.isEmpty()) img = img.resize({ width: 16, height: 16 });
  tray = new Tray(img);
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
      {
        label: "Çık",
        click: () => {
          quitting = true;
          stopCore();
          app.quit();
        },
      },
    ]);
  tray.setToolTip("Aether");
  tray.setContextMenu(menu());
  tray.on("click", () => {
    if (win) {
      win.show();
      win.focus();
    }
  });
  setInterval(() => {
    try {
      tray.setContextMenu(menu());
    } catch {
      /* tray gone */
    }
  }, 2500);
}

function shutdownAll() {
  if (quitting) return;
  quitting = true;
  stopCore();
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    }
  });
}

app.whenReady().then(() => {
  killStale();
  createWindow();
  createTray();
  pullVlist()
    .then((r) => send("vlist", r))
    .catch((e) => send("vlist-error", { message: e.message || String(e) }));
});

app.on("window-all-closed", () => {
  stopCore();
  app.quit();
});
app.on("before-quit", shutdownAll);
app.on("will-quit", shutdownAll);
app.on("quit", shutdownAll);
try {
  powerMonitor.on("shutdown", shutdownAll);
} catch {
  /* platform */
}
process.on("SIGINT", () => {
  shutdownAll();
  app.quit();
});
process.on("SIGTERM", () => {
  shutdownAll();
  app.quit();
});
process.on("exit", () => {
  if (child && child.pid) killPid(child.pid);
});

ipcMain.handle("state", () => {
  const store = loadStore();
  return {
    ...statusPayload(),
    profiles: store.profiles,
    locale: store.locale || "tr",
    remoteAt: store.remoteAt || null,
  };
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
ipcMain.handle("refresh-vlist", async () => pullVlist());
