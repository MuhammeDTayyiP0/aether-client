"use strict";
// Saf yardimcilar: link ayristirma, abonelik, sing-box (1.12+) yapilandirmasi.
// Electron'a bagli degil; node ile test edilebilir.
const crypto = require("crypto");
const net = require("net");

const LINK_SCHEMES = ["vless://", "trojan://", "vmess://"];

// ---------------------------------------------------------------------------
// Link -> sing-box outbound
// ---------------------------------------------------------------------------

function tlsBlock(sni, net, alpnRaw, fp, enabled) {
  if (!enabled) return undefined;
  const alpn = alpnRaw ? String(alpnRaw).split(",").map((s) => s.trim()).filter(Boolean) : [];
  return {
    enabled: true,
    server_name: sni,
    insecure: false,
    alpn: alpn.length ? alpn : [net === "grpc" ? "h2" : "http/1.1"],
    utls: { enabled: true, fingerprint: fp || "chrome" },
  };
}

function transportBlock(net, host, pathValue, serviceName) {
  if (net === "grpc") return { type: "grpc", service_name: serviceName || "aether-grpc" };
  if (net === "httpupgrade") return { type: "httpupgrade", host, path: pathValue || "/" };
  if (net === "ws") return { type: "ws", path: pathValue || "/", headers: { Host: host } };
  return undefined;
}

function parseUrlLink(link) {
  const u = new URL(link.trim());
  const proto = u.protocol.replace(":", "");
  const cred = decodeURIComponent(u.username);
  const server = u.hostname.replace(/^\[|\]$/g, "");
  const port = Number(u.port || 443);
  const q = u.searchParams;
  const net = (q.get("type") || "tcp").toLowerCase();
  const host = q.get("host") || server;
  const sni = q.get("sni") || q.get("peer") || host;
  const name = decodeURIComponent(u.hash.replace(/^#/, "")) || `${server} (${proto})`;
  const ob = { type: proto, tag: "proxy", server, server_port: port };
  if (proto === "vless") {
    ob.uuid = cred;
    ob.packet_encoding = "xudp";
    if (q.get("flow")) ob.flow = q.get("flow");
  } else {
    ob.password = cred;
  }
  const security = (q.get("security") || (proto === "trojan" ? "tls" : "none")).toLowerCase();
  ob.tls = tlsBlock(sni, net, q.get("alpn"), q.get("fp"), security === "tls");
  ob.transport = transportBlock(net, host, q.get("path"), q.get("serviceName"));
  return { name, ob, meta: { proto, net, server, cred } };
}

// sing-box'in VMess AES-128-GCM uygulamasi Xray 26 sunucusuyla uyumsuz ("unknown security type"),
// auto da AES donanimi olan cihazlarda AES'e duser. Sunucu istemcinin sectigini kabul ettigi icin chacha kullan.
function vmessSecurity(scy) {
  const s = String(scy || "auto").toLowerCase();
  return s === "auto" || s === "aes-128-gcm" ? "chacha20-poly1305" : s;
}

function parseVmess(link) {
  const raw = link.trim().replace(/^vmess:\/\//i, "");
  const d = JSON.parse(Buffer.from(raw, "base64").toString("utf8"));
  const server = d.add;
  const net = String(d.net || "tcp").toLowerCase();
  const host = d.host || server;
  const sni = d.sni || host;
  const ob = {
    type: "vmess", tag: "proxy", server, server_port: Number(d.port || 443),
    uuid: d.id, security: vmessSecurity(d.scy), alter_id: Number(d.aid || 0),
  };
  ob.tls = tlsBlock(sni, net, d.alpn, d.fp, d.tls === "tls");
  ob.transport = transportBlock(net, host, d.path, d.path);
  return { name: d.ps || `${server} (vmess)`, ob, meta: { proto: "vmess", net, server, cred: d.id } };
}

function parseLink(link) {
  const s = String(link || "").trim();
  if (s.startsWith("vmess://")) return parseVmess(s);
  if (s.startsWith("vless://") || s.startsWith("trojan://")) return parseUrlLink(s);
  throw new Error("desteklenmeyen link");
}

function profileId(meta) {
  return `p-${crypto.createHash("sha1").update(`${meta.proto}|${meta.net}|${meta.server}|${meta.cred}`).digest("hex").slice(0, 12)}`;
}

function makeProfile(ob, name, source, id) {
  const meta = {
    proto: ob.type,
    net: (ob.transport && ob.transport.type) || "tcp",
    server: ob.server,
    cred: ob.uuid || ob.password || "",
  };
  return { id: id || profileId(meta), name: name || ob.server, domain: ob.server, outbound: ob, meta, source };
}

const PROXY_TYPES = ["vless", "vmess", "trojan", "shadowsocks", "hysteria2", "tuic"];

function proxyOutboundFromConfig(cfg) {
  const ob = (cfg && Array.isArray(cfg.outbounds) ? cfg.outbounds : []).find((o) => o && PROXY_TYPES.includes(o.type) && o.server);
  if (!ob) return null;
  const copy = JSON.parse(JSON.stringify(ob));
  copy.tag = "proxy";
  delete copy.detour;
  return copy;
}

function normalizeSubscription(input, defaultServer) {
  const t = String(input || "").trim();
  if (/^https?:\/\//i.test(t)) {
    const u = new URL(t);
    u.search = "";
    u.hash = "";
    u.protocol = "https:";
    return u.href;
  }
  const token = t.replace(/^\/?sub\//, "").trim();
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(token)) throw new Error("Geçersiz abonelik kodu");
  return `https://${defaultServer}/sub/${token}`;
}

function parseSubscription(text) {
  let t = String(text || "").trim();
  if (!t) throw new Error("abonelik bos");
  if (!t.startsWith("{") && !t.startsWith("[") && !t.includes("://")) {
    const decoded = Buffer.from(t, "base64").toString("utf8");
    if (decoded.includes("://")) t = decoded.trim();
  }
  let links;
  if (t.startsWith("{") || t.startsWith("[")) {
    const j = JSON.parse(t);
    if (Array.isArray(j.links)) links = j.links;
    else if (Array.isArray(j.nodes)) links = j.nodes.map((n) => n.vless || n.trojan || n.vmess || "");
    else if (Array.isArray(j)) links = j.map((n) => (typeof n === "string" ? n : n.vless || n.trojan || n.vmess || ""));
    else throw new Error("abonelik bicimi taninmadi");
  } else {
    links = t.split(/\r?\n/);
  }
  // Uzak listeden yalnizca link kabul edilir; tam sing-box config'i (inbound vb.) kabul edilmez.
  const profiles = [];
  for (const l of links) {
    const s = String(l || "").trim();
    if (!LINK_SCHEMES.some((p) => s.startsWith(p))) continue;
    try {
      const { name, ob } = parseLink(s);
      const p = makeProfile(ob, name, "remote");
      if (!profiles.some((x) => x.id === p.id)) profiles.push(p);
    } catch (e) {
      console.warn("link atlandi:", e.message);
    }
  }
  if (!profiles.length) throw new Error("abonelikte desteklenen hat yok");
  return profiles;
}

// ---------------------------------------------------------------------------
// sing-box yapilandirmasi (1.12+ bicimi)
// ---------------------------------------------------------------------------

const TRANSPORT_FOR = { upg: "httpupgrade", ws: "ws", grpc: "grpc" };

// Protokol secimi: ayni abonelikteki (ayni sunucu + anahtar) istenen tasiyicili kardes hat.
function pickProfile(store, id, transport) {
  const base = store.profiles.find((p) => p.id === id);
  if (!base) throw new Error("Düğüm yok");
  const want = TRANSPORT_FOR[transport];
  if (!want || base.meta.net === want) return base;
  const sibling = store.profiles.find((p) => p.meta.proto === base.meta.proto && p.meta.server === base.meta.server
    && p.meta.cred === base.meta.cred && p.meta.net === want);
  if (!sibling) throw new Error(`Bu düğüm için ${transport.toUpperCase()} hattı yok; listeden başka bir hat seçin.`);
  return sibling;
}

function buildCoreConfig(outbound, { tun, insecure, uplink, localPort }) {
  const ob = JSON.parse(JSON.stringify(outbound));
  ob.tag = "proxy";
  if (ob.tls) ob.tls.insecure = Boolean(insecure);
  if (uplink) ob.detour = "uplink";
  const outbounds = [ob, { type: "direct", tag: "direct" }];
  if (uplink) outbounds.push({ type: "http", tag: "uplink", server: uplink.server, server_port: uplink.server_port });

  const cfg = {
    log: { level: "warn", timestamp: true },
    dns: {
      servers: [{ type: "local", tag: "local" }],
      strategy: "ipv4_only",
    },
    inbounds: [{ type: "mixed", tag: "mixed-in", listen: "127.0.0.1", listen_port: localPort }],
    outbounds,
    route: {
      rules: [
        { action: "sniff" },
        { ip_is_private: true, outbound: "direct" },
        { domain_suffix: ["gov.tr", "edu.tr"], outbound: "direct" },
      ],
      final: "proxy",
      auto_detect_interface: true,
      default_domain_resolver: "local",
    },
  };
  if (tun) {
    cfg.inbounds.unshift({
      type: "tun", tag: "tun-in", interface_name: "aether-tun",
      address: ["172.19.0.1/30"], auto_route: true, strict_route: true, stack: "mixed",
    });
    cfg.dns = {
      servers: [
        { type: "https", tag: "remote", server: "1.1.1.1", detour: "proxy" },
        { type: "local", tag: "local" },
      ],
      rules: [{ domain_suffix: ["gov.tr", "edu.tr"], server: "local" }],
      final: "remote",
      strategy: "ipv4_only",
    };
    cfg.route.rules.splice(1, 0, { protocol: "dns", action: "hijack-dns" });
  }
  return cfg;
}

function parseIp(text) {
  const t = String(text || "");
  const m = t.match(/^ip=([0-9a-f.:]+)$/im);
  const candidate = m ? m[1] : t.trim().split(/\s+/)[0];
  return net.isIP(candidate) ? candidate : "";
}

module.exports = {
  LINK_SCHEMES,
  buildCoreConfig,
  makeProfile,
  normalizeSubscription,
  parseIp,
  parseLink,
  parseSubscription,
  pickProfile,
  proxyOutboundFromConfig,
};
