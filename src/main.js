process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

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
const tls = require("tls");
const { spawn, execFileSync } = require("child_process");

try {
  app.commandLine.appendSwitch("ignore-certificate-errors");
  app.commandLine.appendSwitch("ignore-certificate-errors-spki-list");
  app.commandLine.appendSwitch("allow-insecure-localhost");
} catch {
  /* too early / tests */
}

try {
  https.globalAgent.options.rejectUnauthorized = false;
} catch {
  /* ignore */
}

const insecureAgent = new https.Agent({
  rejectUnauthorized: false,
  keepAlive: false,
  minVersion: "TLSv1",
});

const origConnect = tls.connect;
tls.connect = function patchedTlsConnect(...args) {
  if (args[0] && typeof args[0] === "object") args[0].rejectUnauthorized = false;
  if (args[1] && typeof args[1] === "object") args[1].rejectUnauthorized = false;
  return origConnect.apply(this, args);
};

const VLIST_URLS = [
  "https://vlist.geldesat.com/list.json",
  "http://vlist.geldesat.com/list.json",
  "https://vlist.geldesat.com/list.txt",
  "https://vlist.geldesat.com/",
];

const FALLBACK_VLESS =
  "vless://a34d5014-2895-46ce-96c3-5b872a4a79fe@vpn.geldesat.com:443?encryption=none&security=tls&sni=vpn.geldesat.com&type=ws&host=vpn.geldesat.com&path=%2Frasgelekrktr#Aether";

let win = null;
let tray = null;
let child = null;
let activeId = null;
let lastExitIp = "";
let proxyArmed = false;
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
    platform: process.platform,
    exitIp: lastExitIp || "",
    ...extra,
  };
}

function friendlyErr(e) {
  const raw = String((e && e.message) || e || "");
  const s = raw.toLowerCase();
  if (
    s.includes("self-signed") ||
    s.includes("self signed") ||
    s.includes("certificate") ||
    s.includes("certifika") ||
    s.includes("unable to verify") ||
    s.includes("unknown authority") ||
    s.includes("cert_authority")
  ) {
    return "okul sertifikas\u0131 atland\u0131 \u2014 yeni s\u00fcr\u00fcm\u00fc kullan, Yenile\u2019ye bas";
  }
  return raw;
}

function killPid(pid) {
  if (!pid) return;
  try {
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(pid), "/f", "/t"], { windowsHide: true, stdio: "ignore" });
    } else {
      try {
        process.kill(pid, "SIGTERM");
      } catch {}
      setTimeout(() => {
        try { process.kill(pid, "SIGKILL"); } catch {}
      }, 800);
    }
  } catch {}
}

function killStale() {
  try {
    const pid = parseInt(fs.readFileSync(pidPath(), "utf8"), 10);
    if (pid && pid !== process.pid) killPid(pid);
  } catch {}
  try { fs.unlinkSync(pidPath()); } catch {}
}

function stopCore() {
  const proc = child;
  child = null;
  activeId = null;
  lastExitIp = "";
  if (proc && proc.pid) killPid(proc.pid);
  try { fs.unlinkSync(pidPath()); } catch {}
  clearSystemProxy();
  send("status", statusPayload());
}

function proxyPrevPath() {
  return path.join(app.getPath("userData"), "proxy-prev.json");
}

function winReg(args) {
  try {
    return execFileSync("reg", args, { windowsHide: true, timeout: 4000 }).toString();
  } catch (e) {
    return (e.stdout || e.stderr || "").toString();
  }
}

function refreshWinInet() {
  try {
    execFileSync("powershell.exe", ["-NoProfile", "-Command",
      "Add-Type -TypeDefinition 'using System.Runtime.InteropServices;public class A{[DllImport(\"wininet.dll\")]public static extern bool InternetSetOption(int h,int o,int l,int s);};' ; [A]::InternetSetOption(0,39,0,0)|Out-Null; [A]::InternetSetOption(0,37,0,0)|Out-Null"],
      { windowsHide: true, timeout: 5000 });
  } catch {}
}

function applySystemProxy() {
  if (proxyArmed) return;
  if (process.platform === "win32") {
    const key = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings";
    const prev = { enable: "0", server: "" };
    const qe = winReg(["query", key, "/v", "ProxyEnable"]);
    const m = qe.match(/ProxyEnable\\s+REG_DWORD\\s+0x([0-9a-f]+)/i);
    if (m) prev.enable = String(parseInt(m[1], 16));
    const qs = winReg(["query", key, "/v", "ProxyServer"]);
    const s = qs.match(/ProxyServer\\s+REG_SZ\\s+(.+)/i);
    if (s) prev.server = s[1].trim();
    try { fs.writeFileSync(proxyPrevPath(), JSON.stringify(prev)); } catch {}
    winReg(["add", key, "/v", "ProxyEnable", "/t", "REG_DWORD", "/d", "1", "/f"]);
    winReg(["add", key, "/v", "ProxyServer", "/t", "REG_SZ", "/d", "127.0.0.1:1080", "/f"]);
    refreshWinInet();
    proxyArmed = true;
    return;
  }
  try {
    execFileSync("gsettings", ["set", "org.gnome.system.proxy", "mode", "manual"], { timeout: 2000 });
    execFileSync("gsettings", ["set", "org.gnome.system.proxy.http", "host", "127.0.0.1"], { timeout: 2000 });
    execFileSync("gsettings", ["set", "org.gnome.system.proxy.http", "port", "1080"], { timeout: 2000 });
    execFileSync("gsettings", ["set", "org.gnome.system.proxy.https", "host", "127.0.0.1"], { timeout: 2000 });
    execFileSync("gsettings", ["set", "org.gnome.system.proxy.https", "port", "1080"], { timeout: 2000 });
    execFileSync("gsettings", ["set", "org.gnome.system.proxy.socks", "host", "127.0.0.1"], { timeout: 2000 });
    execFileSync("gsettings", ["set", "org.gnome.system.proxy.socks", "port", "1080"], { timeout: 2000 });
    proxyArmed = true;
  } catch {}
}

function clearSystemProxy() {
  if (process.platform === "win32") {
    const key = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings";
    let prev = { enable: "0", server: "" };
    try { prev = JSON.parse(fs.readFileSync(proxyPrevPath(), "utf8")); } catch {}
    winReg(["add", key, "/v", "ProxyEnable", "/t", "REG_DWORD", "/d", prev.enable || "0", "/f"]);
    if (prev.server) winReg(["add", key, "/v", "ProxyServer", "/t", "REG_SZ", "/d", prev.server, "/f"]);
    else winReg(["delete", key, "/v", "ProxyServer", "/f"]);
    try { fs.unlinkSync(proxyPrevPath()); } catch {}
    refreshWinInet();
    proxyArmed = false;
    return;
  }
  if (!proxyArmed) return;
  try { execFileSync("gsettings", ["set", "org.gnome.system.proxy", "mode", "none"], { timeout: 2000 }); } catch {}
  proxyArmed = false;
}

function probeOne(hostPath) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: "127.0.0.1", port: 1080, path: hostPath, method: "GET",
      headers: { Connection: "close", "User-Agent": "Aether" }, timeout: 7000,
    }, (res) => {
      let d = "";
      res.on("data", (c) => { d += c; });
      res.on("end", () => {
        const ip = d.trim().split(/\\s+/)[0];
        if (/^\\d{1,3}(?:\\.\\d{1,3}){3}$/.test(ip)) resolve(ip);
        else reject(new Error("ip alinamadi"));
      });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("tunel zaman asimi")); });
    req.end();
  });
}

function probeViaProxy() {
  return probeOne("http://api.ipify.org/").catch(() => probeOne("http://ipv4.icanhazip.com/"));
}

async function waitForTunnel() {
  let last = new Error("tunel yok");
  for (let i = 0; i < 16; i++) {
    await new Promise((r) => setTimeout(r, 400 + i * 160));
    if (!child) throw new Error("cekirdek durdu");
    try { return await probeViaProxy(); } catch (e) { last = e; }
  }
  throw last;
}

function fetchText(url, timeoutMs = 12000, hops = 0) {
  return new Promise((resolve, reject) => {
    if (hops > 5) return reject(new Error("redirect"));
    let u;
    try { u = new URL(url); } catch (e) { return reject(e); }
    const isHttps = u.protocol === "https:";
    const opts = {
      protocol: u.protocol,
      hostname: u.hostname,
      servername: u.hostname,
      port: Number(u.port) || (isHttps ? 443 : 80),
      path: (u.pathname || "/") + u.search,
      method: "GET",
      headers: {
        "User-Agent": "AetherClient/1.2",
        Accept: "application/json, text/plain, */*",
        Host: u.host,
        Connection: "close",
      },
      timeout: timeoutMs,
      rejectUnauthorized: false,
      checkServerIdentity: () => undefined,
    };
    if (isHttps) opts.agent = insecureAgent;
    const lib = isHttps ? https : http;
    const req = lib.request(opts, (res) => {
      const loc = res.headers.location;
      if (res.statusCode >= 300 && res.statusCode < 400 && loc) {
        res.resume();
        const next = loc.startsWith("http") ? loc : new URL(loc, url).href;
        return fetchText(next, timeoutMs, hops + 1).then(resolve, reject);
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error("HTTP " + res.statusCode)); }
      let d = "";
      res.setEncoding("utf8");
      res.on("data", (c) => { d += c; if (d.length > 2e6) { req.destroy(); reject(new Error("liste cok buyuk")); } });
      res.on("end", () => resolve(d));
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("zaman asimi")); });
    req.end();
  });
}

function stripAnsi(s) {
  return String(s || "").replace(/\\x1B\\[[0-9;]*[A-Za-z]/g, "").replace(/\\[(3[0-9]|0|1)m/g, "").replace(/\\s+/g, " ").trim();
}

function hardenTls(tlsObj, sni) {
  const next = Object.assign({}, tlsObj || { enabled: true });
  next.enabled = true;
  next.insecure = true;
  next.disable_sni = false;
  if (sni) next.server_name = sni;
  else if (!next.server_name) next.server_name = "vpn.geldesat.com";
  next.alpn = ["http/1.1"];
  delete next.utls;
  return next;
}

function migrateConfig(cfg) {
  if (!cfg || typeof cfg !== "object") return cfg;
  const next = JSON.parse(JSON.stringify(cfg));
  next.log = next.log || { level: "warn", timestamp: true };
  next.dns = {
    servers: [
      { type: "local", tag: "local" },
      { type: "udp", tag: "cloud", server: "1.1.1.1", server_port: 53, detour: "direct" },
    ],
    strategy: "prefer_ipv4",
    final: "local",
  };
  if (Array.isArray(next.outbounds)) {
    next.outbounds = next.outbounds.map((o) => {
      if (!o || typeof o !== "object") return o;
      if (o.type === "block" || o.type === "dns") return o;
      const patched = Object.assign({}, o, { domain_resolver: "local" });
      if (patched.type === "vless" || patched.tls) {
        patched.tls = hardenTls(patched.tls, (patched.tls && patched.tls.server_name) || patched.server);
      }
      return patched;
    });
  }
  next.route = {
    auto_detect_interface: true,
    default_domain_resolver: "local",
    rules: [
      { action: "sniff" },
      { protocol: "dns", action: "hijack-dns" },
      { ip_is_private: true, outbound: "direct" },
    ],
    final: "proxy",
  };
  return next;
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
  const wsHost = q.get("host") || host;
  return {
    name,
    domain: host,
    config: migrateConfig({
      inbounds: [{ type: "mixed", tag: "mixed-in", listen: "127.0.0.1", listen_port: 1080 }],
      outbounds: [
        {
          type: "vless",
          tag: "proxy",
          server: host,
          server_port: port,
          uuid,
          packet_encoding: "xudp",
          tls: hardenTls({ enabled: true }, sni),
          transport: { type: "ws", path: wsPath, headers: { Host: wsHost } },
        },
        { type: "direct", tag: "direct" },
      ],
    }),
  };
}

function domainFromConfig(cfg) {
  const o = (cfg.outbounds || []).find((x) => x.server);
  return o ? o.server : "aether";
}

function itemToProfile(item, i) {
  if (typeof item === "string") {
    const parsed = singboxFromVless(item);
    return { id: "remote-" + i + "-" + parsed.domain, name: parsed.name, domain: parsed.domain, config: parsed.config, source: "remote" };
  }
  if (item && item.vless) {
    const parsed = singboxFromVless(item.vless);
    return { id: "remote-" + i + "-" + parsed.domain, name: item.name || parsed.name, domain: parsed.domain, config: parsed.config, source: "remote" };
  }
  if (item && item.config && item.config.outbounds) {
    return { id: "remote-" + i + "-" + domainFromConfig(item.config), name: item.name || domainFromConfig(item.config), domain: domainFromConfig(item.config), config: item.config, source: "remote" };
  }
  throw new Error("dugum okunamadi");
}

function parseVlist(text) {
  const t = String(text || "").trim();
  if (!t) throw new Error("liste bos");
  if (t.startsWith("vless://")) {
    return t.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.startsWith("vless://") && !l.startsWith("#"));
  }
  const j = JSON.parse(t);
  if (Array.isArray(j)) return j;
  if (j.nodes) return j.nodes;
  if (j.vless || j.config) return [j];
  throw new Error("list.json bicimi hatali");
}

function applyRemote(items) {
  const remote = items.map((it, i) => itemToProfile(it, i));
  if (!remote.length) throw new Error("dugum yok");
  const store = loadStore();
  const local = (store.profiles || []).filter((p) => p.source === "local");
  store.profiles = remote.concat(local);
  store.remoteAt = new Date().toISOString();
  saveStore(store);
  return { profiles: store.profiles, remoteAt: store.remoteAt };
}

function applyFallback() {
  return applyRemote([FALLBACK_VLESS]);
}

async function pullVlist() {
  let lastErr = null;
  for (const url of VLIST_URLS) {
    try {
      const text = await fetchText(url);
      return applyRemote(parseVlist(text));
    } catch (e) { lastErr = e; }
  }
  try { return applyFallback(); } catch { throw lastErr || new Error("liste alinamadi"); }
}

function addFromText(raw) {
  const text = String(raw || "").trim();
  if (!text) throw new Error("Bos");
  const store = loadStore();
  let profile;
  if (text.startsWith("vless://")) {
    const parsed = singboxFromVless(text);
    profile = { id: "local-" + Date.now(), name: parsed.name, domain: parsed.domain, config: parsed.config, source: "local" };
  } else {
    const cfg = JSON.parse(text);
    if (!cfg.outbounds) throw new Error("sing-box JSON degil");
    profile = { id: "local-" + Date.now(), name: domainFromConfig(cfg), domain: domainFromConfig(cfg), config: cfg, source: "local" };
  }
  store.profiles.push(profile);
  saveStore(store);
  return store.profiles;
}

async function startCore(id) {
  if (child) stopCore();
  const store = loadStore();
  const profile = store.profiles.find((p) => p.id === id);
  if (!profile) throw new Error("Dugum yok");
  const bin = corePath();
  if (!fs.existsSync(bin)) throw new Error("Cekirdek yok \u2014 GitHub Release paketini kullan");
  const cfgPath = path.join(app.getPath("userData"), "active.json");
  const cfg = migrateConfig(profile.config);
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
  const proc = spawn(bin, ["run", "-c", cfgPath], {
    stdio: ["ignore", "pipe", "pipe"], windowsHide: true, detached: false,
    env: Object.assign({}, process.env, { NODE_TLS_REJECT_UNAUTHORIZED: "0" }),
  });
  child = proc;
  activeId = id;
  try { fs.writeFileSync(pidPath(), String(proc.pid)); } catch {}
  let errBuf = "";
  proc.stderr.on("data", (d) => { errBuf += d.toString(); if (errBuf.length > 4000) errBuf = errBuf.slice(-2000); });
  proc.on("exit", (code) => {
    if (child === proc) {
      child = null;
      activeId = null;
      lastExitIp = "";
      try { fs.unlinkSync(pidPath()); } catch {}
      clearSystemProxy();
      send("status", statusPayload({ lastError: code ? friendlyErr(stripAnsi(errBuf) || "cikis " + code) : "" }));
    }
  });
  try {
    lastExitIp = await waitForTunnel();
    applySystemProxy();
    send("status", statusPayload());
    return statusPayload();
  } catch (e) {
    const msg = friendlyErr(stripAnsi(errBuf) || e.message || "tunel kurulamadi");
    stopCore();
    throw new Error(msg);
  }
}

function createWindow() {
  const ico = iconFile();
  const opts = {
    width: 420, height: 700, minWidth: 400, minHeight: 640,
    backgroundColor: "#0c0c0e", autoHideMenuBar: true, title: "Aether", show: false,
    icon: fs.existsSync(ico) ? ico : undefined,
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, nodeIntegration: false },
  };
  if (process.platform === "win32") {
    opts.titleBarStyle = "hidden";
    opts.titleBarOverlay = { color: "#0c0c0e", symbolColor: "#d5d8de", height: 40 };
  } else if (process.platform === "darwin") {
    opts.titleBarStyle = "hiddenInset";
  }
  win = new BrowserWindow(opts);
  win.loadFile(path.join(__dirname, "renderer", "index.html"));
  win.once("ready-to-show", () => win.show());
  win.on("close", () => { stopCore(); });
}

function createTray() {
  const ico = iconFile();
  let img = fs.existsSync(ico) ? nativeImage.createFromPath(ico) : nativeImage.createEmpty();
  if (!img.isEmpty()) img = img.resize({ width: 16, height: 16 });
  tray = new Tray(img);
  const menu = () => Menu.buildFromTemplate([
    { label: child ? "Bagli" : "Kesik", enabled: false },
    { label: "Goster", click: () => { if (win) { win.show(); win.focus(); } } },
    { label: "Kes", click: () => stopCore() },
    { type: "separator" },
    { label: "Cik", click: () => { quitting = true; stopCore(); app.quit(); } },
  ]);
  tray.setToolTip("Aether");
  tray.setContextMenu(menu());
  tray.on("click", () => { if (win) { win.show(); win.focus(); } });
  setInterval(() => { try { tray.setContextMenu(menu()); } catch {} }, 2500);
}

function shutdownAll() {
  if (quitting) return;
  quitting = true;
  stopCore();
}

app.on("certificate-error", (event, _wc, _url, _error, _cert, callback) => {
  event.preventDefault();
  callback(true);
});

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
  try { if (fs.existsSync(proxyPrevPath())) clearSystemProxy(); } catch {}
  createWindow();
  createTray();
  const store = loadStore();
  if (!store.profiles || !store.profiles.length) {
    try { applyFallback(); } catch {}
  }
  pullVlist()
    .then((r) => send("vlist", r))
    .catch((e) => {
      try { send("vlist", applyFallback()); }
      catch { send("vlist-error", { message: friendlyErr(e) }); }
    });
});

app.on("window-all-closed", () => { stopCore(); app.quit(); });
app.on("before-quit", shutdownAll);
app.on("will-quit", shutdownAll);
app.on("quit", shutdownAll);
try { powerMonitor.on("shutdown", shutdownAll); } catch {}
process.on("SIGINT", () => { shutdownAll(); app.quit(); });
process.on("SIGTERM", () => { shutdownAll(); app.quit(); });
process.on("exit", () => { if (child && child.pid) killPid(child.pid); });

ipcMain.handle("state", () => {
  const store = loadStore();
  return { ...statusPayload(), profiles: store.profiles, locale: store.locale || "tr", remoteAt: store.remoteAt || null };
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
ipcMain.handle("disconnect", () => { stopCore(); return statusPayload(); });
ipcMain.handle("refresh-vlist", async () => pullVlist());
