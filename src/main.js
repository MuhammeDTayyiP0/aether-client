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
const net = require("net");
const { spawn, execFileSync } = require("child_process");

const LOCAL_PORT = 17890;

try {
  app.commandLine.appendSwitch("ignore-certificate-errors");
  app.commandLine.appendSwitch("allow-insecure-localhost");
} catch {
  /* ignore */
}

try {
  https.globalAgent.options.rejectUnauthorized = false;
} catch {
  /* ignore */
}

const insecureAgent = new https.Agent({
  rejectUnauthorized: false,
  keepAlive: false,
});

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

function statusPayload(extra) {
  extra = extra || {};
  return Object.assign({
    running: Boolean(child),
    activeId,
    core: corePath(),
    coreOk: fs.existsSync(corePath()),
    vlist: VLIST_URLS[0],
    platform: process.platform,
    exitIp: lastExitIp || "",
  }, extra);
}

function friendlyErr(e) {
  const raw = String((e && e.message) || e || "");
  const s = raw.toLowerCase();
  if (
    s.indexOf("self-signed") !== -1 ||
    s.indexOf("self signed") !== -1 ||
    s.indexOf("certificate") !== -1 ||
    s.indexOf("certifika") !== -1 ||
    s.indexOf("unknown authority") !== -1
  ) {
    return "sertifika atlandi — v1.1.20+ kullan, Yenile ye bas";
  }
  if (s.indexOf("detour") !== -1 || s.indexOf("empty direct") !== -1) {
    return "cekirdek ayari duzeltildi — v1.1.20 yukle";
  }
  if (s.indexOf("zaman") !== -1 || s.indexOf("timeout") !== -1 || s.indexOf("tunel yok") !== -1) {
    return "tunel zaman asimi — 443/WS kapali veya okul proxy. Yeni surumu dene";
  }
  return raw;
}

function killPid(pid) {
  if (!pid) return;
  try {
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(pid), "/f", "/t"], { windowsHide: true, stdio: "ignore" });
    } else {
      try { process.kill(pid, "SIGTERM"); } catch {}
      setTimeout(function () { try { process.kill(pid, "SIGKILL"); } catch {} }, 800);
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
    winReg(["add", key, "/v", "ProxyServer", "/t", "REG_SZ", "/d", "127.0.0.1:" + LOCAL_PORT, "/f"]);
    refreshWinInet();
    proxyArmed = true;
    return;
  }
  try {
    execFileSync("gsettings", ["set", "org.gnome.system.proxy", "mode", "manual"], { timeout: 2000 });
    execFileSync("gsettings", ["set", "org.gnome.system.proxy.http", "host", "127.0.0.1"], { timeout: 2000 });
    execFileSync("gsettings", ["set", "org.gnome.system.proxy.http", "port", String(LOCAL_PORT)], { timeout: 2000 });
    execFileSync("gsettings", ["set", "org.gnome.system.proxy.https", "host", "127.0.0.1"], { timeout: 2000 });
    execFileSync("gsettings", ["set", "org.gnome.system.proxy.https", "port", String(LOCAL_PORT)], { timeout: 2000 });
    execFileSync("gsettings", ["set", "org.gnome.system.proxy.socks", "host", "127.0.0.1"], { timeout: 2000 });
    execFileSync("gsettings", ["set", "org.gnome.system.proxy.socks", "port", String(LOCAL_PORT)], { timeout: 2000 });
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

function isIpv4(s) {
  const p = String(s || "").trim().split(/\s+/)[0];
  const a = p.split(".");
  if (a.length !== 4) return "";
  for (let i = 0; i < 4; i++) {
    const n = Number(a[i]);
    if (!Number.isInteger(n) || n < 0 || n > 255) return "";
  }
  return p;
}

function parseProxyHostPort(raw) {
  if (!raw) return null;
  let s = String(raw).trim().replace(/^["']|["']$/g, "");
  if (!s || s.indexOf("127.0.0.1") !== -1 || s.indexOf("localhost") !== -1) return null;
  try {
    if (s.indexOf("://") === -1) s = "http://" + s;
    const u = new URL(s);
    if (!u.hostname || u.hostname === "127.0.0.1" || u.hostname === "localhost") return null;
    return { server: u.hostname, server_port: Number(u.port || 8080) };
  } catch {
    return null;
  }
}

function detectUplink() {
  const env =
    process.env.https_proxy ||
    process.env.HTTPS_PROXY ||
    process.env.http_proxy ||
    process.env.HTTP_PROXY ||
    process.env.all_proxy ||
    process.env.ALL_PROXY;
  const fromEnv = parseProxyHostPort(env);
  if (fromEnv) return fromEnv;
  if (process.platform === "win32") {
    const key = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings";
    const qs = winReg(["query", key, "/v", "ProxyServer"]);
    const m = qs.match(/ProxyServer\\s+REG_SZ\\s+(.+)/i);
    if (m) {
      const raw = m[1].trim();
      const httpsP = raw.match(/https=([^;]+)/i);
      const httpP = raw.match(/http=([^;]+)/i);
      return parseProxyHostPort((httpsP && httpsP[1]) || (httpP && httpP[1]) || raw);
    }
    return null;
  }
  try {
    const mode = execFileSync("gsettings", ["get", "org.gnome.system.proxy", "mode"], { timeout: 1500 }).toString();
    if (mode.indexOf("manual") !== -1 || mode.indexOf("auto") !== -1) {
      const host = execFileSync("gsettings", ["get", "org.gnome.system.proxy.https", "host"], { timeout: 1500 })
        .toString()
        .replace(/['"\s]/g, "");
      const port = execFileSync("gsettings", ["get", "org.gnome.system.proxy.https", "port"], { timeout: 1500 })
        .toString()
        .replace(/[^0-9]/g, "");
      const found = parseProxyHostPort(host + ":" + (port || "8080"));
      if (found) return found;
    }
  } catch {
    /* no gnome */
  }
  return null;
}

function probeOne(hostPath) {
  return new Promise(function (resolve, reject) {
    const req = http.request({
      host: "127.0.0.1",
      port: LOCAL_PORT,
      path: hostPath,
      method: "GET",
      headers: { Connection: "close", "User-Agent": "Aether" },
      timeout: 8000,
    }, function (res) {
      let d = "";
      res.on("data", function (c) { d += c; });
      res.on("end", function () {
        const ip = isIpv4(d);
        if (ip) resolve(ip);
        else reject(new Error("ip alinamadi"));
      });
    });
    req.on("error", reject);
    req.on("timeout", function () { req.destroy(); reject(new Error("tunel zaman asimi")); });
    req.end();
  });
}

function probeSocks() {
  return new Promise(function (resolve, reject) {
    const sock = net.connect({ host: "127.0.0.1", port: LOCAL_PORT }, function () {
      sock.write(Buffer.from([0x05, 0x01, 0x00]));
    });
    sock.setTimeout(8000);
    let step = 0;
    let buf = Buffer.alloc(0);
    const fail = function (e) {
      try { sock.destroy(); } catch {}
      reject(e);
    };
    sock.on("data", function (d) {
      buf = Buffer.concat([buf, d]);
      if (step === 0 && buf.length >= 2) {
        if (buf[0] !== 5 || buf[1] !== 0) return fail(new Error("socks"));
        buf = buf.slice(2);
        step = 1;
        const host = Buffer.from("api.ipify.org");
        const req = Buffer.alloc(7 + host.length);
        req[0] = 5; req[1] = 1; req[2] = 0; req[3] = 3; req[4] = host.length;
        host.copy(req, 5);
        req.writeUInt16BE(80, 5 + host.length);
        sock.write(req);
      } else if (step === 1 && buf.length >= 10) {
        if (buf[1] !== 0) return fail(new Error("socks " + buf[1]));
        step = 2;
        sock.write("GET / HTTP/1.1\r\nHost: api.ipify.org\r\nConnection: close\r\n\r\n");
        buf = Buffer.alloc(0);
      } else if (step === 2) {
        const ip = isIpv4(buf.toString("utf8").replace(/^[\s\S]*?\r\n\r\n/, ""));
        if (ip) {
          try { sock.destroy(); } catch {}
          resolve(ip);
        }
      }
    });
    sock.on("end", function () {
      if (step === 2) {
        const ip = isIpv4(buf.toString("utf8").replace(/^[\s\S]*?\r\n\r\n/, ""));
        if (ip) return resolve(ip);
      }
      reject(new Error("ip alinamadi"));
    });
    sock.on("error", reject);
    sock.on("timeout", function () { fail(new Error("tunel zaman asimi")); });
  });
}

function probeViaProxy() {
  return probeOne("http://api.ipify.org/")
    .catch(function () { return probeOne("http://ipv4.icanhazip.com/"); })
    .catch(function () { return probeSocks(); });
}

function waitPort(port, ms) {
  return new Promise(function (resolve, reject) {
    const start = Date.now();
    const once = function () {
      const s = net.connect({ host: "127.0.0.1", port: port }, function () {
        try { s.end(); } catch {}
        resolve();
      });
      s.on("error", function () {
        if (Date.now() - start > ms) reject(new Error("cekirdek port acilmadi"));
        else setTimeout(once, 180);
      });
    };
    once();
  });
}

async function waitForTunnel() {
  let last = new Error("tunel yok");
  try { await waitPort(LOCAL_PORT, 8000); } catch (e) { throw e; }
  for (let i = 0; i < 16; i++) {
    await new Promise(function (r) { setTimeout(r, 300 + i * 150); });
    if (!child) throw new Error("cekirdek durdu");
    try { return await probeViaProxy(); } catch (e) { last = e; }
  }
  throw last;
}

function fetchText(url, timeoutMs, hops) {
  if (!timeoutMs) timeoutMs = 12000;
  if (!hops) hops = 0;
  return new Promise(function (resolve, reject) {
    if (hops > 5) return reject(new Error("redirect"));
    let u;
    try { u = new URL(url); } catch (e) { return reject(e); }
    const isHttps = u.protocol === "https:";
    const opts = {
      protocol: u.protocol, hostname: u.hostname, servername: u.hostname,
      port: Number(u.port) || (isHttps ? 443 : 80),
      path: (u.pathname || "/") + u.search, method: "GET",
      headers: { "User-Agent": "AetherClient/1.2", Accept: "application/json, text/plain, */*", Host: u.host, Connection: "close" },
      timeout: timeoutMs, rejectUnauthorized: false,
    };
    if (isHttps) opts.agent = insecureAgent;
    const lib = isHttps ? https : http;
    const req = lib.request(opts, function (res) {
      const loc = res.headers.location;
      if (res.statusCode >= 300 && res.statusCode < 400 && loc) {
        res.resume();
        const next = loc.indexOf("http") === 0 ? loc : new URL(loc, url).href;
        return fetchText(next, timeoutMs, hops + 1).then(resolve, reject);
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error("HTTP " + res.statusCode)); }
      let d = "";
      res.setEncoding("utf8");
      res.on("data", function (c) { d += c; if (d.length > 2000000) { req.destroy(); reject(new Error("liste cok buyuk")); } });
      res.on("end", function () { resolve(d); });
    });
    req.on("error", reject);
    req.on("timeout", function () { req.destroy(); reject(new Error("zaman asimi")); });
    req.end();
  });
}

function stripAnsi(s) {
  return String(s || "").replace(/\u001b\[[0-9;]*[A-Za-z]/g, "").replace(/\s+/g, " ").trim();
}

function hardenTls(tlsObj, sni) {
  const next = Object.assign({}, tlsObj || { enabled: true });
  next.enabled = true;
  next.insecure = true;
  if (sni) next.server_name = sni;
  else if (!next.server_name) next.server_name = "vpn.geldesat.com";
  delete next.utls;
  delete next.alpn;
  delete next.disable_sni;
  return next;
}

function migrateConfig(cfg) {
  if (!cfg || typeof cfg !== "object") return cfg;
  const next = JSON.parse(JSON.stringify(cfg));
  next.log = { level: "warn", timestamp: true };
  next.dns = {
    servers: [{ type: "local", tag: "local" }],
    final: "local",
    strategy: "ipv4_only",
  };
  if (Array.isArray(next.outbounds)) {
    next.outbounds = next.outbounds
      .filter(function (o) { return o && o.type !== "block" && o.type !== "dns" && o.type !== "direct"; })
      .map(function (o) {
        const patched = Object.assign({}, o);
        delete patched.domain_resolver;
        if (patched.type === "vless") {
          patched.tls = hardenTls(patched.tls, (patched.tls && patched.tls.server_name) || patched.server);
          if (!patched.network) patched.network = "tcp";
        } else if (patched.tls) {
          patched.tls = hardenTls(patched.tls, (patched.tls && patched.tls.server_name) || patched.server);
        }
        return patched;
      });
  }
  next.route = { final: "proxy", default_domain_resolver: "local" };
  if (!Array.isArray(next.inbounds) || !next.inbounds.length) {
    next.inbounds = [{ type: "mixed", tag: "mixed-in", listen: "127.0.0.1", listen_port: LOCAL_PORT }];
  }
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
    name: name,
    domain: host,
    config: migrateConfig({
      inbounds: [{ type: "mixed", tag: "mixed-in", listen: "127.0.0.1", listen_port: LOCAL_PORT }],
      outbounds: [{
        type: "vless", tag: "proxy", server: host, server_port: port, uuid: uuid,
        packet_encoding: "xudp",
        tls: hardenTls({ enabled: true }, sni),
        transport: { type: "ws", path: wsPath, headers: { Host: wsHost } },
      }],
    }),
  };
}

function domainFromConfig(cfg) {
  const o = (cfg.outbounds || []).find(function (x) { return x.server; });
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
  if (t.indexOf("vless://") === 0) {
    return t.split(/\r?\n/).map(function (l) { return l.trim(); }).filter(function (l) { return l.indexOf("vless://") === 0 && l.indexOf("#") !== 0; });
  }
  const j = JSON.parse(t);
  if (Array.isArray(j)) return j;
  if (j.nodes) return j.nodes;
  if (j.vless || j.config) return [j];
  throw new Error("list.json bicimi hatali");
}

function applyRemote(items) {
  const remote = items.map(function (it, i) { return itemToProfile(it, i); });
  if (!remote.length) throw new Error("dugum yok");
  const store = loadStore();
  const local = (store.profiles || []).filter(function (p) { return p.source === "local"; });
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
  for (let i = 0; i < VLIST_URLS.length; i++) {
    try {
      const text = await fetchText(VLIST_URLS[i]);
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
  if (text.indexOf("vless://") === 0) {
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
  const profile = store.profiles.find(function (p) { return p.id === id; });
  if (!profile) throw new Error("Dugum yok");
  const bin = corePath();
  if (!fs.existsSync(bin)) throw new Error("Cekirdek yok — GitHub Release paketini kullan");
  const cfgPath = path.join(app.getPath("userData"), "active.json");
  const cfg = migrateConfig(profile.config);
  if (Array.isArray(cfg.inbounds)) {
    cfg.inbounds = cfg.inbounds.map(function (ib) {
      if (!ib || ib.type !== "mixed") return ib;
      return Object.assign({}, ib, { listen: "127.0.0.1", listen_port: LOCAL_PORT });
    });
  }
  const uplink = detectUplink();
  if (uplink && Array.isArray(cfg.outbounds)) {
    cfg.outbounds = cfg.outbounds.map(function (o) {
      if (o && o.type === "vless") return Object.assign({}, o, { detour: "uplink" });
      return o;
    });
    cfg.outbounds.push({ type: "http", tag: "uplink", server: uplink.server, server_port: uplink.server_port });
  }
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
  const proc = spawn(bin, ["run", "-c", cfgPath], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true, detached: false });
  child = proc;
  activeId = id;
  try { fs.writeFileSync(pidPath(), String(proc.pid)); } catch {}
  let errBuf = "";
  proc.stderr.on("data", function (d) { errBuf += d.toString(); if (errBuf.length > 4000) errBuf = errBuf.slice(-2000); });
  proc.on("exit", function (code) {
    if (child === proc) {
      child = null; activeId = null; lastExitIp = "";
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
    const raw = stripAnsi(errBuf);
    const msg = friendlyErr(raw || e.message || "tunel kurulamadi");
    stopCore();
    throw new Error(raw ? (msg + " | " + raw.slice(-240)) : msg);
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
  win.once("ready-to-show", function () { win.show(); });
  win.on("close", function () { stopCore(); });
}

function createTray() {
  const ico = iconFile();
  let img = fs.existsSync(ico) ? nativeImage.createFromPath(ico) : nativeImage.createEmpty();
  if (!img.isEmpty()) img = img.resize({ width: 16, height: 16 });
  tray = new Tray(img);
  const menu = function () {
    return Menu.buildFromTemplate([
      { label: child ? "Bagli" : "Kesik", enabled: false },
      { label: "Goster", click: function () { if (win) { win.show(); win.focus(); } } },
      { label: "Kes", click: function () { stopCore(); } },
      { type: "separator" },
      { label: "Cik", click: function () { quitting = true; stopCore(); app.quit(); } },
    ]);
  };
  tray.setToolTip("Aether");
  tray.setContextMenu(menu());
  tray.on("click", function () { if (win) { win.show(); win.focus(); } });
  setInterval(function () { try { tray.setContextMenu(menu()); } catch {} }, 2500);
}

function shutdownAll() {
  if (quitting) return;
  quitting = true;
  stopCore();
}

app.on("certificate-error", function (event, _wc, _url, _error, _cert, callback) {
  event.preventDefault();
  callback(true);
});

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", function () {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    }
  });
}

app.whenReady().then(function () {
  killStale();
  try { if (fs.existsSync(proxyPrevPath())) clearSystemProxy(); } catch {}
  createWindow();
  createTray();
  pullVlist().then(function (r) { send("vlist", r); }).catch(function (e) { send("vlist-error", { message: friendlyErr(e) }); });
});

app.on("window-all-closed", function () { stopCore(); app.quit(); });
app.on("before-quit", shutdownAll);
app.on("will-quit", shutdownAll);
app.on("quit", shutdownAll);
try { powerMonitor.on("shutdown", shutdownAll); } catch {}
process.on("SIGINT", function () { shutdownAll(); app.quit(); });
process.on("SIGTERM", function () { shutdownAll(); app.quit(); });
process.on("exit", function () { if (child && child.pid) killPid(child.pid); });

ipcMain.handle("state", function () {
  const store = loadStore();
  return Object.assign(statusPayload(), { profiles: store.profiles, locale: store.locale || "tr", remoteAt: store.remoteAt || null });
});
ipcMain.handle("set-locale", function (_e, locale) {
  const store = loadStore();
  store.locale = locale === "en" ? "en" : "tr";
  saveStore(store);
  return store.locale;
});
ipcMain.handle("add-profile", function (_e, text) { return addFromText(text); });
ipcMain.handle("remove-profile", function (_e, id) {
  const store = loadStore();
  if (activeId === id) stopCore();
  store.profiles = store.profiles.filter(function (p) { return p.id !== id; });
  saveStore(store);
  return store.profiles;
});
ipcMain.handle("connect", function (_e, id) { return startCore(id); });
ipcMain.handle("disconnect", function () { stopCore(); return statusPayload(); });
ipcMain.handle("refresh-vlist", function () { return pullVlist(); });
