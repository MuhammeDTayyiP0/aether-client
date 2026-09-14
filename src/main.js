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
} catch {}

try {
  https.globalAgent.options.rejectUnauthorized = false;
} catch {}

const insecureAgent = new https.Agent({ rejectUnauthorized: false, keepAlive: false });

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

function storePath() { return path.join(app.getPath("userData"), "profiles.json"); }
function pidPath() { return path.join(app.getPath("userData"), "core.pid"); }
function iconFile() {
  const local = path.join(__dirname, "icon.png");
  if (fs.existsSync(local)) return local;
  const packed = path.join(process.resourcesPath || "", "icon.png");
  if (packed && fs.existsSync(packed)) return packed;
  return local;
}
function loadStore() {
  try { return JSON.parse(fs.readFileSync(storePath(), "utf8")); }
  catch { return { profiles: [], locale: "tr" }; }
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
    running: Boolean(child), activeId, core: corePath(), coreOk: fs.existsSync(corePath()),
    vlist: VLIST_URLS[0], platform: process.platform, exitIp: lastExitIp || "",
  }, extra);
}
function friendlyErr(e) {
  const raw = String((e && e.message) || e || "");
  const s = raw.toLowerCase();
  if (s.indexOf("self-signed") !== -1 || s.indexOf("self signed") !== -1 || s.indexOf("certificate") !== -1 || s.indexOf("certifika") !== -1 || s.indexOf("unknown authority") !== -1) {
    return "sertifika atlandi — v1.1.20 kullan";
  }
  if (s.indexOf("zaman") !== -1 || s.indexOf("timeout") !== -1 || s.indexOf("tunel yok") !== -1) {
    return "tunel zaman asimi — 443/WS kapali veya okul proxy lazim. v1.1.20 dene";
  }
  return raw;
}
function killPid(pid) {
  if (!pid) return;
  try {
    if (process.platform === "win32") spawn("taskkill", ["/pid", String(pid), "/f", "/t"], { windowsHide: true, stdio: "ignore" });
    else {
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
  child = null; activeId = null; lastExitIp = "";
  if (proc && proc.pid) killPid(proc.pid);
  try { fs.unlinkSync(pidPath()); } catch {}
  clearSystemProxy();
  send("status", statusPayload());
}
function proxyPrevPath() { return path.join(app.getPath("userData"), "proxy-prev.json"); }
function winReg(args) {
  try { return execFileSync("reg", args, { windowsHide: true, timeout: 4000 }).toString(); }
  catch (e) { return (e.stdout || e.stderr || "").toString(); }
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
    const m = qe.match(/ProxyEnable\s+REG_DWORD\s+0x([0-9a-f]+)/i);
    if (m) prev.enable = String(parseInt(m[1], 16));
    const qs = winReg(["query", key, "/v", "ProxyServer"]);
    const s = qs.match(/ProxyServer\s+REG_SZ\s+(.+)/i);
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
  let s = String(raw).trim().replace(/^[\