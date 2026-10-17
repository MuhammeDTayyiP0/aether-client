const {
  app,
  BrowserWindow,
  ipcMain,
  Tray,
  Menu,
  nativeImage,
  powerMonitor,
  clipboard,
} = require("electron");
const path = require("path");
const fs = require("fs");
const http = require("http");
const net = require("net");
const tls = require("tls");
const crypto = require("crypto");
const { spawn, execFileSync } = require("child_process");
const {
  LINK_SCHEMES,
  buildCoreConfig,
  makeProfile,
  normalizeSubscription,
  parseIp,
  parseLink,
  parseSubscription,
  pickProfile,
  proxyOutboundFromConfig,
} = require("./links");

const LOCAL_PORT = 17890;
const DEFAULT_SERVER = "vpn.geldesat.com";
// Ana alan adi engellenirse abonelik bu aynalardan da denenir (vlist/ nginx /sub/ proxy'si).
const SUB_MIRRORS = ["vlist.geldesat.com"];

let win = null;
let tray = null;
let child = null;
let activeId = null;
let lastExitIp = "";
let lastLatencyMs = 0;
let proxyArmed = false;
let tunActive = false;
let quitting = false;
// Her baglanti denemesi/iptal bu sayaci arttirir; bekleyen eski deneme kendini iptal eder.
let connectSeq = 0;

// ---------------------------------------------------------------------------
// Depolama
// ---------------------------------------------------------------------------

function dataPath(name) {
  return path.join(app.getPath("userData"), name);
}
const storePath = () => dataPath("profiles.json");
const pidPath = () => dataPath("core.pid");
const proxyPrevPath = () => dataPath("proxy-prev.json");

function iconFile() {
  const local = path.join(__dirname, "icon.png");
  if (fs.existsSync(local)) return local;
  const packed = path.join(process.resourcesPath || "", "icon.png");
  if (packed && fs.existsSync(packed)) return packed;
  return local;
}

function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

function loadStore() {
  let s;
  try {
    s = JSON.parse(fs.readFileSync(storePath(), "utf8"));
  } catch {
    s = {};
  }
  return migrateStore(s);
}

function saveStore(data) {
  writeAtomic(storePath(), JSON.stringify(data, null, 2));
}

// Eski surum (tum kullanicilarin paylastigi gomulu anahtar + tam sing-box config'i) -> yeni bicim.
function migrateStore(s) {
  const store = {
    profiles: [],
    locale: s.locale === "en" ? "en" : "tr",
    tunMode: Boolean(s.tunMode),
    subscription: s.subscription || null,
    remoteAt: s.remoteAt || null,
    network: s.network || null,
  };
  for (const p of Array.isArray(s.profiles) ? s.profiles : []) {
    if (!p || typeof p !== "object") continue;
    // Eski uzak profiller paylasilan (iptal edilen) anahtari tasir; abonelikten yeniden cekilir.
    if (p.source !== "local" && !store.subscription) continue;
    if (p.outbound) {
      store.profiles.push(p);
      continue;
    }
    const ob = p.config && proxyOutboundFromConfig(p.config);
    if (ob) store.profiles.push(makeProfile(ob, p.name, p.source === "remote" ? "remote" : "local", p.id));
  }
  return store;
}

function corePath() {
  const name = process.platform === "win32" ? "aether-core.exe" : "aether-core";
  if (app.isPackaged) return path.join(process.resourcesPath, "bin", name);
  return path.join(__dirname, "..", "resources", "bin", name);
}

// ---------------------------------------------------------------------------
// Durum / IPC yardimcilari
// ---------------------------------------------------------------------------

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
  if (channel === "status") updateTrayMenu();
}

function statusPayload(extra) {
  const store = loadStore();
  return Object.assign({
    running: Boolean(child),
    activeId,
    coreOk: fs.existsSync(corePath()),
    platform: process.platform,
    version: app.getVersion(),
    exitIp: lastExitIp || "",
    latencyMs: lastLatencyMs || 0,
    tunMode: Boolean(store.tunMode),
    tunArmed: Boolean(tunActive),
    subscription: store.subscription ? maskSubscription(store.subscription.url) : "",
    network: store.network || null,
  }, extra || {});
}

function maskSubscription(url) {
  try {
    const u = new URL(url);
    const parts = u.pathname.split("/");
    const token = parts.pop() || "";
    return `${u.host}${parts.join("/")}/${token.slice(0, 4)}…`;
  } catch {
    return "";
  }
}

function friendlyErr(e) {
  const raw = String((e && e.message) || e || "");
  const s = raw.toLowerCase();
  if (s.includes("certificate") || s.includes("x509") || s.includes("self-signed") || s.includes("self signed")) {
    return "Sunucu sertifikası doğrulanamadı. Ağ SSL denetimi yapıyor olabilir; Yenile'ye basıp tekrar deneyin.";
  }
  if (s.includes("operation not permitted") || s.includes("access is denied") || s.includes("erişim engellendi")) {
    return "TUN modu yönetici yetkisi ister.";
  }
  if (s.includes("zaman asimi") || s.includes("timeout") || s.includes("tunel yok")) {
    return "Tünel zaman aşımı: hat engelleniyor olabilir. Başka bir protokol (UPG/WS/gRPC) veya düğüm deneyin.";
  }
  return raw;
}

// ---------------------------------------------------------------------------
// Cekirdek sureci
// ---------------------------------------------------------------------------

function killPid(pid) {
  if (!pid) return;
  try {
    if (process.platform === "win32") {
      execFileSync("taskkill", ["/pid", String(pid), "/f", "/t"], { windowsHide: true, stdio: "ignore", timeout: 4000 });
    } else {
      try { process.kill(pid, "SIGTERM"); } catch { /* yok */ }
      setTimeout(() => { try { process.kill(pid, "SIGKILL"); } catch { /* yok */ } }, 800);
    }
  } catch { /* zaten kapanmis */ }
}

function killStale() {
  try {
    const pid = parseInt(fs.readFileSync(pidPath(), "utf8"), 10);
    if (pid && pid !== process.pid) killPid(pid);
  } catch { /* pid dosyasi yok */ }
  try { fs.unlinkSync(pidPath()); } catch { /* yok */ }
}

function stopCore() {
  connectSeq += 1;
  const proc = child;
  child = null;
  activeId = null;
  lastExitIp = "";
  lastLatencyMs = 0;
  tunActive = false;
  if (proc && proc.pid) killPid(proc.pid);
  try { fs.unlinkSync(pidPath()); } catch { /* yok */ }
  clearSystemProxy();
  send("status", statusPayload());
}

// ---------------------------------------------------------------------------
// Sistem proxy'si (Windows / GNOME / KDE)
// ---------------------------------------------------------------------------

const WIN_INET_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings";
const WIN_BYPASS = "<local>;localhost;127.*;10.*;172.16.*;192.168.*";

function winReg(args) {
  try {
    return execFileSync("reg", args, { windowsHide: true, timeout: 4000, stdio: ["ignore", "pipe", "pipe"] }).toString();
  } catch (e) {
    return String((e && (e.stdout || e.stderr)) || "");
  }
}

function winRegGet(name) {
  const out = winReg(["query", WIN_INET_KEY, "/v", name]);
  const m = out.match(new RegExp(`${name}\\s+(REG_\\w+)\\s+(.*)`, "i"));
  if (!m) return null;
  const value = m[2].trim();
  return m[1].toUpperCase() === "REG_DWORD" ? String(parseInt(value, 16)) : value;
}

function winRegSet(name, type, value) {
  if (value === null || value === undefined) {
    winReg(["delete", WIN_INET_KEY, "/v", name, "/f"]);
  } else {
    winReg(["add", WIN_INET_KEY, "/v", name, "/t", type, "/d", String(value), "/f"]);
  }
}

function refreshWinInet() {
  try {
    execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      "Add-Type -TypeDefinition 'using System.Runtime.InteropServices;public class A{[DllImport(\"wininet.dll\")]public static extern bool InternetSetOption(int h,int o,int l,int s);};' ; [A]::InternetSetOption(0,39,0,0)|Out-Null; [A]::InternetSetOption(0,37,0,0)|Out-Null"],
    { windowsHide: true, timeout: 5000 });
  } catch { /* ayar yine de uygulanir, sadece tarayicilar gec gorur */ }
}

function tryExec(cmd, args) {
  try {
    return execFileSync(cmd, args, { timeout: 2000, stdio: ["ignore", "pipe", "pipe"] }).toString().trim();
  } catch {
    return null;
  }
}

function readPrevProxy() {
  try {
    return JSON.parse(fs.readFileSync(proxyPrevPath(), "utf8"));
  } catch {
    return null;
  }
}

function applySystemProxy() {
  if (proxyArmed) return;
  const local = `127.0.0.1:${LOCAL_PORT}`;
  if (process.platform === "win32") {
    // Onceki degerleri yalnizca ilk kez sakla (cokme sonrasi bizim degerlerimizi "onceki" sanmamak icin).
    if (!readPrevProxy()) {
      const prev = {
        platform: "win32",
        ProxyEnable: winRegGet("ProxyEnable"),
        ProxyServer: winRegGet("ProxyServer"),
        ProxyOverride: winRegGet("ProxyOverride"),
        AutoConfigURL: winRegGet("AutoConfigURL"),
      };
      writeAtomic(proxyPrevPath(), JSON.stringify(prev));
    }
    winRegSet("ProxyEnable", "REG_DWORD", 1);
    winRegSet("ProxyServer", "REG_SZ", local);
    winRegSet("ProxyOverride", "REG_SZ", WIN_BYPASS);
    // PAC betigi elle girilen proxy'den once gelir; bagli kaldigimiz surece kaldir.
    winRegSet("AutoConfigURL", "REG_SZ", null);
    refreshWinInet();
    proxyArmed = true;
    return;
  }

  if (!readPrevProxy()) {
    const prev = { platform: process.platform, gnome: null, kde5: null, kde6: null };
    const mode = tryExec("gsettings", ["get", "org.gnome.system.proxy", "mode"]);
    if (mode !== null) {
      prev.gnome = { mode };
      for (const k of ["http", "https", "socks"]) {
        prev.gnome[k] = {
          host: tryExec("gsettings", ["get", `org.gnome.system.proxy.${k}`, "host"]),
          port: tryExec("gsettings", ["get", `org.gnome.system.proxy.${k}`, "port"]),
        };
      }
      prev.gnome.ignore = tryExec("gsettings", ["get", "org.gnome.system.proxy", "ignore-hosts"]);
    }
    for (const v of ["5", "6"]) {
      const type = tryExec(`kreadconfig${v}`, ["--file", "kioslaverc", "--group", "Proxy Settings", "--key", "ProxyType"]);
      if (type !== null) {
        prev[`kde${v}`] = {
          ProxyType: type,
          httpProxy: tryExec(`kreadconfig${v}`, ["--file", "kioslaverc", "--group", "Proxy Settings", "--key", "httpProxy"]),
          httpsProxy: tryExec(`kreadconfig${v}`, ["--file", "kioslaverc", "--group", "Proxy Settings", "--key", "httpsProxy"]),
        };
      }
    }
    writeAtomic(proxyPrevPath(), JSON.stringify(prev));
  }

  const gs = (schema, key, value) => tryExec("gsettings", ["set", schema, key, value]);
  if (gs("org.gnome.system.proxy", "mode", "manual") !== null) {
    for (const k of ["http", "https", "socks"]) {
      gs(`org.gnome.system.proxy.${k}`, "host", "127.0.0.1");
      gs(`org.gnome.system.proxy.${k}`, "port", String(LOCAL_PORT));
    }
    gs("org.gnome.system.proxy", "ignore-hosts", "['localhost', '127.0.0.0/8', '::1', '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16']");
    proxyArmed = true;
  }
  for (const v of ["5", "6"]) {
    const kw = (key, value) => tryExec(`kwriteconfig${v}`, ["--file", "kioslaverc", "--group", "Proxy Settings", "--key", key, value]);
    if (kw("ProxyType", "1") !== null) {
      kw("httpProxy", `http://${local}`);
      kw("httpsProxy", `http://${local}`);
      proxyArmed = true;
    }
  }
  process.env.http_proxy = `http://${local}`;
  process.env.https_proxy = `http://${local}`;
  process.env.all_proxy = `socks5://${local}`;
  proxyArmed = true;
}

function clearSystemProxy() {
  const prev = readPrevProxy();
  if (!prev && !proxyArmed) return;
  if (process.platform === "win32") {
    const p = prev || {};
    winRegSet("ProxyEnable", "REG_DWORD", p.ProxyEnable || "0");
    winRegSet("ProxyServer", "REG_SZ", p.ProxyServer || null);
    winRegSet("ProxyOverride", "REG_SZ", p.ProxyOverride || null);
    winRegSet("AutoConfigURL", "REG_SZ", p.AutoConfigURL || null);
    refreshWinInet();
  } else {
    const p = prev || {};
    if (p.gnome) {
      const unq = (v) => String(v || "").replace(/^'|'$/g, "");
      tryExec("gsettings", ["set", "org.gnome.system.proxy", "mode", unq(p.gnome.mode) || "none"]);
      for (const k of ["http", "https", "socks"]) {
        const o = p.gnome[k] || {};
        if (o.host !== null && o.host !== undefined) tryExec("gsettings", ["set", `org.gnome.system.proxy.${k}`, "host", unq(o.host)]);
        if (o.port) tryExec("gsettings", ["set", `org.gnome.system.proxy.${k}`, "port", o.port]);
      }
      if (p.gnome.ignore) tryExec("gsettings", ["set", "org.gnome.system.proxy", "ignore-hosts", p.gnome.ignore]);
    } else {
      tryExec("gsettings", ["set", "org.gnome.system.proxy", "mode", "none"]);
    }
    for (const v of ["5", "6"]) {
      const o = p[`kde${v}`];
      const kw = (key, value) => tryExec(`kwriteconfig${v}`, ["--file", "kioslaverc", "--group", "Proxy Settings", "--key", key, value]);
      if (o) {
        kw("ProxyType", o.ProxyType || "0");
        kw("httpProxy", o.httpProxy || "");
        kw("httpsProxy", o.httpsProxy || "");
      } else {
        kw("ProxyType", "0");
      }
    }
    delete process.env.http_proxy;
    delete process.env.https_proxy;
    delete process.env.all_proxy;
  }
  try { fs.unlinkSync(proxyPrevPath()); } catch { /* yok */ }
  proxyArmed = false;
}

// ---------------------------------------------------------------------------
// Okul / kurum proxy'si (uplink) tespiti
// ---------------------------------------------------------------------------

function parseProxyHostPort(raw) {
  if (!raw) return null;
  let s = String(raw).trim().replace(/^["']|["']$/g, "");
  if (!s) return null;
  try {
    if (!s.includes("://")) s = `http://${s}`;
    const u = new URL(s);
    if (!u.hostname || u.hostname === "127.0.0.1" || u.hostname === "localhost") return null;
    return { server: u.hostname, server_port: Number(u.port || 8080) };
  } catch {
    return null;
  }
}

function detectUplink() {
  const env = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.ALL_PROXY;
  const fromEnv = parseProxyHostPort(env);
  if (fromEnv) return fromEnv;

  // Biz proxy'yi ayarladiysak gercek (onceki) degerler proxy-prev.json'dadir.
  const prev = readPrevProxy();
  if (process.platform === "win32") {
    const enabled = prev ? prev.ProxyEnable : winRegGet("ProxyEnable");
    const raw = prev ? prev.ProxyServer : winRegGet("ProxyServer");
    if (enabled !== "1" || !raw) return null;
    const httpsP = raw.match(/https=([^;]+)/i);
    const httpP = raw.match(/http=([^;]+)/i);
    return parseProxyHostPort((httpsP && httpsP[1]) || (httpP && httpP[1]) || raw);
  }
  const g = prev && prev.gnome;
  const mode = g ? g.mode : tryExec("gsettings", ["get", "org.gnome.system.proxy", "mode"]);
  if (mode && mode.includes("manual")) {
    const host = (g ? g.https.host : tryExec("gsettings", ["get", "org.gnome.system.proxy.https", "host"])) || "";
    const port = (g ? g.https.port : tryExec("gsettings", ["get", "org.gnome.system.proxy.https", "port"])) || "";
    return parseProxyHostPort(`${host.replace(/['"\s]/g, "")}:${port.replace(/[^0-9]/g, "") || "8080"}`);
  }
  return null;
}

// ---------------------------------------------------------------------------
// TLS: ag SSL denetimi (MITM) tespiti
// ---------------------------------------------------------------------------

// Sunucuya (gerekirse kurum proxy'si uzerinden) TLS ile baglanir.
// Dogrulamayi biz yapariz: authorized=false ise ag sertifikayi degistiriyordur.
function openTls(host, port, uplink, cb) {
  const done = (rawSocket) => {
    const opts = { host, port, servername: host, rejectUnauthorized: false, ALPNProtocols: ["http/1.1"] };
    if (rawSocket) opts.socket = rawSocket;
    cb(null, tls.connect(opts));
  };
  if (!uplink) return done(null);
  const req = http.request({
    host: uplink.server, port: uplink.server_port, method: "CONNECT", path: `${host}:${port}`,
    headers: { Host: `${host}:${port}` }, timeout: 10000,
  });
  req.on("connect", (res, socket) => {
    if (res.statusCode !== 200) {
      socket.destroy();
      return cb(new Error(`kurum proxy'si reddetti (HTTP ${res.statusCode})`));
    }
    done(socket);
  });
  req.on("timeout", () => req.destroy(new Error("kurum proxy'si zaman asimi")));
  req.on("error", (e) => cb(e));
  req.end();
}

function chainInfo(socket) {
  const pins = [];
  let issuer = "";
  const seen = new Set();
  let cert = socket.getPeerCertificate(true);
  let depth = 0;
  while (cert && cert.raw && !seen.has(cert.fingerprint256)) {
    seen.add(cert.fingerprint256);
    if (depth === 1) issuer = (cert.subject && (cert.subject.CN || cert.subject.O)) || "";
    if (depth > 0) pins.push(crypto.createHash("sha256").update(cert.raw).digest("hex"));
    cert = cert.issuerCertificate;
    depth += 1;
  }
  return { pins, issuer };
}

function recordNetwork(host, socket) {
  const info = chainInfo(socket);
  const network = {
    host,
    mitm: !socket.authorized,
    error: socket.authorized ? "" : String(socket.authorizationError || ""),
    issuer: info.issuer,
    pins: socket.authorized ? [] : info.pins,
    checkedAt: new Date().toISOString(),
  };
  const store = loadStore();
  store.network = network;
  saveStore(store);
  return network;
}

function probeNetwork(host) {
  return new Promise((resolve) => {
    openTls(host, 443, detectUplink(), (err, socket) => {
      if (err) return resolve(null);
      const timer = setTimeout(() => { socket.destroy(); resolve(null); }, 8000);
      socket.on("secureConnect", () => {
        clearTimeout(timer);
        const n = recordNetwork(host, socket);
        socket.end();
        resolve(n);
      });
      socket.on("error", () => { clearTimeout(timer); resolve(null); });
    });
  });
}

function fetchText(url, timeoutMs = 12000, hops = 0) {
  return new Promise((resolve, reject) => {
    if (hops > 5) return reject(new Error("cok fazla yonlendirme"));
    let u;
    try {
      u = new URL(url);
    } catch (e) {
      return reject(e);
    }
    if (u.protocol !== "https:") return reject(new Error("abonelik linki https:// olmali"));
    const port = Number(u.port) || 443;
    openTls(u.hostname, port, detectUplink(), (err, socket) => {
      if (err) return reject(err);
      const req = http.request({
        host: u.hostname, port, path: `${u.pathname}${u.search}`, method: "GET",
        createConnection: () => socket,
        headers: { Host: u.host, "User-Agent": `AetherClient/${app.getVersion()}`, Accept: "application/json, text/plain, */*", Connection: "close" },
        timeout: timeoutMs,
      }, (res) => {
        recordNetwork(u.hostname, socket);
        const loc = res.headers.location;
        if (res.statusCode >= 300 && res.statusCode < 400 && loc) {
          res.resume();
          return fetchText(new URL(loc, url).href, timeoutMs, hops + 1).then(resolve, reject);
        }
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c) => {
          body += c;
          if (body.length > 2000000) req.destroy(new Error("yanit cok buyuk"));
        });
        res.on("end", () => {
          if (res.statusCode !== 200) return reject(new Error(body.trim().slice(0, 120) || `HTTP ${res.statusCode}`));
          resolve(body);
        });
      });
      req.on("error", reject);
      req.on("timeout", () => req.destroy(new Error("zaman asimi")));
      req.end();
    });
  });
}

// ---------------------------------------------------------------------------
// Abonelik
// ---------------------------------------------------------------------------

function subscriptionCandidates(url) {
  const u = new URL(url);
  const list = [`${u.href}?format=json`];
  for (const mirror of SUB_MIRRORS) {
    if (mirror === u.hostname) continue;
    list.push(`https://${mirror}${u.pathname}?format=json`);
  }
  return list;
}

async function pullSubscription() {
  const store = loadStore();
  if (!store.subscription) throw new Error("Abonelik kodu girilmedi");
  let lastErr = null;
  for (const url of subscriptionCandidates(store.subscription.url)) {
    try {
      const remote = parseSubscription(await fetchText(url));
      const fresh = loadStore();
      fresh.profiles = remote.concat(fresh.profiles.filter((p) => p.source === "local"));
      fresh.remoteAt = new Date().toISOString();
      saveStore(fresh);
      return { profiles: fresh.profiles, remoteAt: fresh.remoteAt, network: fresh.network };
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error("abonelik alinamadi");
}

async function setSubscription(input) {
  const url = normalizeSubscription(input, DEFAULT_SERVER);
  const store = loadStore();
  const previous = store.subscription;
  store.subscription = { url };
  saveStore(store);
  try {
    return await pullSubscription();
  } catch (e) {
    const s = loadStore();
    s.subscription = previous;
    saveStore(s);
    throw e;
  }
}

function addFromText(raw) {
  const text = String(raw || "").trim();
  if (!text) throw new Error("Boş");
  if (/^https?:\/\//i.test(text) || /^(sub\/)?[A-Za-z0-9_-]{8,64}$/.test(text)) {
    return setSubscription(text).then((r) => r.profiles);
  }
  const store = loadStore();
  let profile;
  if (LINK_SCHEMES.some((p) => text.startsWith(p))) {
    const { name, ob } = parseLink(text);
    profile = makeProfile(ob, name, "local");
  } else {
    const ob = proxyOutboundFromConfig(JSON.parse(text));
    if (!ob) throw new Error("sing-box JSON içinde sunucu bulunamadı");
    profile = makeProfile(ob, ob.server, "local");
  }
  store.profiles = store.profiles.filter((p) => p.id !== profile.id).concat(profile);
  saveStore(store);
  return Promise.resolve(store.profiles);
}

function isElevated() {
  if (process.platform === "win32") {
    try {
      execFileSync("net", ["session"], { windowsHide: true, stdio: "ignore", timeout: 4000 });
      return true;
    } catch {
      return false;
    }
  }
  return typeof process.getuid === "function" && process.getuid() === 0;
}

// ---------------------------------------------------------------------------
// Tunel dogrulama
// ---------------------------------------------------------------------------

function probeOne(url) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const req = http.request({
      host: "127.0.0.1", port: LOCAL_PORT, path: url, method: "GET",
      // Host verilmezse Node "127.0.0.1:17890" yazar; Cloudflare/icanhazip bu istegi keser (ECONNRESET).
      headers: { Host: new URL(url).host, Connection: "close", "User-Agent": "Aether" }, timeout: 8000,
    }, (res) => {
      let d = "";
      res.on("data", (c) => { d += c; });
      res.on("end", () => {
        const ip = parseIp(d);
        if (ip) resolve({ ip, ms: Date.now() - started });
        else reject(new Error("ip alinamadi"));
      });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("tunel zaman asimi")); });
    req.end();
  });
}

function probeViaProxy() {
  // Not: http://1.1.1.1/cdn-cgi/trace artik https'e yonlendiriyor (301).
  return probeOne("http://cloudflare.com/cdn-cgi/trace")
    .catch(() => probeOne("http://ipv4.icanhazip.com/"))
    .catch(() => probeOne("http://checkip.amazonaws.com/"));
}

function waitPort(port, ms, proc) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const once = () => {
      if (child !== proc) return reject(new Error("iptal edildi"));
      const s = net.connect({ host: "127.0.0.1", port }, () => {
        s.end();
        resolve();
      });
      s.on("error", () => {
        if (Date.now() - start > ms) reject(new Error("cekirdek portu acilmadi"));
        else setTimeout(once, 180);
      });
    };
    once();
  });
}

async function waitForTunnel(proc) {
  let last = new Error("tunel yok");
  await waitPort(LOCAL_PORT, 8000, proc);
  for (let i = 0; i < 12; i++) {
    if (child !== proc) throw new Error("iptal edildi");
    try {
      return await probeViaProxy();
    } catch (e) {
      last = e;
    }
    await new Promise((r) => setTimeout(r, 300 + i * 150));
  }
  throw last;
}

async function startCore(id, transport) {
  if (child) stopCore();
  const seq = ++connectSeq;
  const store = loadStore();
  const profile = pickProfile(store, id, transport);
  const bin = corePath();
  if (!fs.existsSync(bin)) throw new Error("Çekirdek bulunamadı — GitHub Release paketini kullanın");
  const isTun = Boolean(store.tunMode);
  if (isTun && !isElevated()) {
    const e = new Error(process.platform === "win32"
      ? "TUN modu yönetici yetkisi ister."
      : `TUN modu root ister. Alternatif: sudo setcap cap_net_admin,cap_net_bind_service+ep "${bin}"`);
    e.code = "NEED_ADMIN";
    throw e;
  }

  // Bu agda sunucu sertifikasi dogrulanabiliyor mu? (MEB FATIH gibi SSL denetimi yapan aglarda hayir)
  const sni = (profile.outbound.tls && profile.outbound.tls.server_name) || profile.outbound.server;
  const network = await probeNetwork(sni);
  const insecure = !network || network.mitm;
  if (seq !== connectSeq) throw new Error("iptal edildi");

  const cfg = buildCoreConfig(profile.outbound, { tun: isTun, insecure, uplink: detectUplink(), localPort: LOCAL_PORT });
  const cfgPath = dataPath("active.json");
  writeAtomic(cfgPath, JSON.stringify(cfg, null, 2));

  const proc = spawn(bin, ["run", "-c", cfgPath], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  child = proc;
  activeId = id;
  tunActive = isTun;
  try { fs.writeFileSync(pidPath(), String(proc.pid)); } catch { /* yok */ }
  let errBuf = "";
  const collect = (d) => {
    errBuf += d.toString();
    if (errBuf.length > 4000) errBuf = errBuf.slice(-2000);
  };
  proc.stderr.on("data", collect);
  proc.stdout.on("data", collect);
  proc.on("exit", (code) => {
    if (child !== proc) return;
    child = null;
    activeId = null;
    lastExitIp = "";
    tunActive = false;
    try { fs.unlinkSync(pidPath()); } catch { /* yok */ }
    clearSystemProxy();
    send("status", statusPayload({ lastError: code ? friendlyErr(stripAnsi(errBuf) || `cikis ${code}`) : "" }));
  });

  try {
    const r = await waitForTunnel(proc);
    if (child !== proc) throw new Error("iptal edildi");
    lastExitIp = r.ip;
    lastLatencyMs = r.ms;
    if (!isTun) applySystemProxy();
    const payload = statusPayload({ activeId: profile.id });
    activeId = profile.id;
    send("status", payload);
    return payload;
  } catch (e) {
    if (child !== proc) throw new Error("iptal edildi");
    const raw = stripAnsi(errBuf);
    stopCore();
    throw new Error(raw ? `${friendlyErr(raw)} | ${raw.slice(-240)}` : friendlyErr(e));
  }
}

function stripAnsi(s) {
  return String(s || "").replace(/\u001b\[[0-9;]*[A-Za-z]/g, "").replace(/\s+/g, " ").trim();
}

// ---------------------------------------------------------------------------
// Tarayici (ayri profil ile; acik Chrome --proxy-server'i yok sayar)
// ---------------------------------------------------------------------------

function findBrowser() {
  if (process.platform === "win32") {
    const env = process.env;
    const candidates = [
      path.join(env.PROGRAMFILES || "C:\\Program Files", "Google\\Chrome\\Application\\chrome.exe"),
      path.join(env["PROGRAMFILES(X86)"] || "C:\\Program Files (x86)", "Google\\Chrome\\Application\\chrome.exe"),
      path.join(env.LOCALAPPDATA || "", "Google\\Chrome\\Application\\chrome.exe"),
      path.join(env["PROGRAMFILES(X86)"] || "C:\\Program Files (x86)", "Microsoft\\Edge\\Application\\msedge.exe"),
      path.join(env.PROGRAMFILES || "C:\\Program Files", "Microsoft\\Edge\\Application\\msedge.exe"),
    ];
    return candidates.find((p) => p && fs.existsSync(p)) || null;
  }
  for (const b of ["google-chrome-stable", "google-chrome", "chromium-browser", "chromium", "brave-browser", "microsoft-edge"]) {
    const found = tryExec("which", [b]);
    if (found) return found;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Pencere / tepsi
// ---------------------------------------------------------------------------

function createWindow() {
  const ico = iconFile();
  const opts = {
    width: 420, height: 720, minWidth: 400, minHeight: 640,
    backgroundColor: "#0c0c0e", autoHideMenuBar: true, title: "Aether", show: false,
    icon: fs.existsSync(ico) ? ico : undefined,
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, nodeIntegration: false, sandbox: true },
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
  win.on("close", () => stopCore());
  // Windows oturum kapanisi/yeniden baslatma: proxy kayit defterinde kalmasin.
  win.on("session-end", () => shutdownAll());
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (e) => e.preventDefault());
}

function updateTrayMenu() {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: child ? "Bağlı" : "Bağlı değil", enabled: false },
    { label: "Göster", click: () => { if (win) { win.show(); win.focus(); } } },
    { label: "Bağlantıyı kes", enabled: Boolean(child), click: () => stopCore() },
    { type: "separator" },
    { label: "Çıkış", click: () => { shutdownAll(); app.quit(); } },
  ]));
}

function createTray() {
  const ico = iconFile();
  let img = fs.existsSync(ico) ? nativeImage.createFromPath(ico) : nativeImage.createEmpty();
  if (!img.isEmpty()) img = img.resize({ width: 16, height: 16 });
  tray = new Tray(img);
  tray.setToolTip("Aether");
  tray.on("click", () => { if (win) { win.show(); win.focus(); } });
  updateTrayMenu();
}

function shutdownAll() {
  if (quitting) return;
  quitting = true;
  stopCore();
}

// ---------------------------------------------------------------------------
// Uygulama yasam dongusu
// ---------------------------------------------------------------------------

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
  // Onceki oturum cokmus/kapanmissa sistem proxy'sini geri yukle.
  try { if (fs.existsSync(proxyPrevPath())) clearSystemProxy(); } catch { /* yok */ }
  createWindow();
  createTray();
  const store = loadStore();
  saveStore(store);
  if (store.subscription) {
    pullSubscription()
      .then((r) => send("vlist", r))
      .catch((e) => send("vlist-error", { message: friendlyErr(e) }));
  }
});

app.on("window-all-closed", () => { shutdownAll(); app.quit(); });
app.on("before-quit", shutdownAll);
try { powerMonitor.on("shutdown", shutdownAll); } catch { /* desteklenmiyor */ }
process.on("SIGINT", () => { shutdownAll(); app.quit(); });
process.on("SIGTERM", () => { shutdownAll(); app.quit(); });
process.on("uncaughtException", (e) => {
  console.error(e);
  try { stopCore(); } catch { /* yok */ }
});

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------

ipcMain.handle("state", () => {
  const store = loadStore();
  return Object.assign(statusPayload(), { profiles: store.profiles, locale: store.locale, remoteAt: store.remoteAt });
});
ipcMain.handle("set-locale", (_e, locale) => {
  const store = loadStore();
  store.locale = locale === "en" ? "en" : "tr";
  saveStore(store);
  return store.locale;
});
ipcMain.handle("set-tun", (_e, on) => {
  const store = loadStore();
  store.tunMode = Boolean(on);
  saveStore(store);
  const payload = statusPayload();
  send("status", payload);
  return payload;
});
ipcMain.handle("add-profile", (_e, text) => addFromText(text));
ipcMain.handle("remove-profile", (_e, id) => {
  const store = loadStore();
  if (activeId === id) stopCore();
  store.profiles = store.profiles.filter((p) => p.id !== id);
  saveStore(store);
  return store.profiles;
});
ipcMain.handle("connect", async (_e, id, transport) => {
  try {
    return await startCore(id, transport);
  } catch (e) {
    // IPC hata kodunu tasimaz; mesajin basina ekle.
    throw new Error(e.code === "NEED_ADMIN" ? `NEED_ADMIN:${e.message}` : e.message);
  }
});
ipcMain.handle("disconnect", () => {
  stopCore();
  return statusPayload();
});
ipcMain.handle("launch-browser", () => {
  const exe = findBrowser();
  if (!exe) return { ok: false, error: "Chrome/Edge bulunamadı" };
  const args = [
    `--proxy-server=http://127.0.0.1:${LOCAL_PORT}`,
    `--user-data-dir=${dataPath("browser-profile")}`,
    "--no-first-run",
    "--no-default-browser-check",
    "https://www.google.com",
  ];
  spawn(exe, args, { detached: true, stdio: "ignore", windowsHide: false }).unref();
  return { ok: true, browser: path.basename(exe) };
});
ipcMain.handle("refresh-vlist", () => pullSubscription());
ipcMain.handle("copy", (_e, text) => {
  clipboard.writeText(String(text || ""));
  return true;
});
ipcMain.handle("relaunch-admin", () => {
  if (process.platform !== "win32") return false;
  const args = process.argv.slice(1).map((a) => `'${a.replace(/'/g, "''")}'`).join(",");
  const cmd = `Start-Process -FilePath '${process.execPath.replace(/'/g, "''")}' -Verb RunAs${args ? ` -ArgumentList ${args}` : ""}`;
  // Yeni (yonetici) surec tek-ornek kilidini alabilsin.
  app.releaseSingleInstanceLock();
  try {
    execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", cmd], { windowsHide: true, timeout: 60000 });
  } catch {
    app.requestSingleInstanceLock();
    return false; // kullanici UAC'yi reddetti
  }
  shutdownAll();
  app.quit();
  return true;
});

