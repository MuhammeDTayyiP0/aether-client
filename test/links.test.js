// node test/links.test.js — link ayristirma ve sing-box config uretimi testleri
const assert = require("assert");
const L = require("../src/links");

const UUID = "56c95c41-4193-46ad-9f33-494cbd6a688e";
const D = "vpn.example.com";
const vmess = (o) => `vmess://${Buffer.from(JSON.stringify(o)).toString("base64")}`;
const LINKS = [
  `vless://${UUID}@${D}:443?encryption=none&type=httpupgrade&host=${D}&path=%2Fp-upg&security=tls&sni=${D}&fp=chrome&alpn=http%2F1.1#A%20%C2%B7%20VLESS%20UPG`,
  `vless://${UUID}@${D}:443?encryption=none&type=ws&host=${D}&path=%2Fp&security=tls&sni=${D}&fp=chrome&alpn=http%2F1.1#VLESS%20WS`,
  `trojan://${UUID}@${D}:443?type=ws&host=${D}&path=%2Fp-trws&security=tls&sni=${D}&fp=chrome&alpn=http%2F1.1#Trojan%20WS`,
  `trojan://${UUID}@${D}:443?type=grpc&serviceName=svc-trpc&mode=gun&security=tls&sni=${D}&alpn=h2&pcs=ab#Trojan%20gRPC`,
  vmess({ v: "2", ps: "VMess UPG", add: D, port: "443", id: UUID, aid: "0", scy: "auto", net: "httpupgrade", type: "none", host: D, path: "/p-vmup", tls: "tls", sni: D, alpn: "http/1.1", fp: "chrome" }),
  vmess({ v: "2", ps: "VMess gRPC", add: D, port: "443", id: UUID, aid: "0", scy: "chacha20-poly1305", net: "grpc", type: "gun", host: D, path: "svc-vmpc", tls: "tls", sni: D }),
  `vless://${UUID}@${D}:443?encryption=none&type=xhttp&host=${D}&path=%2Fp-xh&mode=packet-up&security=tls&sni=${D}&fp=chrome&alpn=h2%2Chttp%2F1.1&pcs=ab#VLESS%20XHTTP`,
  "ss://YWVzLTEyOC1nY206eA@h:443#atlanmali",
];

let failed = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`ok   ${name}`);
  } catch (e) {
    failed += 1;
    console.log(`FAIL ${name}\n     ${e.message}`);
  }
}

const b64 = Buffer.from(LINKS.join("\n")).toString("base64");
const profiles = L.parseSubscription(b64);

test("base64 abonelik: desteklenmeyen link atlanir", () => assert.strictEqual(profiles.length, 7));
test("json abonelik (links) ayni sonucu verir", () => {
  const j = L.parseSubscription(JSON.stringify({ links: LINKS }));
  assert.deepStrictEqual(j.map((p) => p.id), profiles.map((p) => p.id));
});
test("uzak tam sing-box config'i kabul edilmez", () => {
  const evil = { nodes: [{ config: { inbounds: [{ type: "mixed", listen: "0.0.0.0" }], outbounds: [{ type: "direct" }] } }] };
  assert.throws(() => L.parseSubscription(JSON.stringify(evil)));
});
test("yol yuzde kodlamasi bir kez cozulur", () => {
  const [p] = L.parseSubscription(`vless://${UUID}@h.com:443?type=ws&security=tls&path=%2Fa%25b#n`);
  assert.strictEqual(p.outbound.transport.path, "/a%b");
});
test("vmess auto/aes -> chacha20-poly1305 (sing-box AES Xray 26 ile uyumsuz)", () => {
  const vm = profiles.filter((p) => p.meta.proto === "vmess");
  assert.ok(vm.every((p) => p.outbound.security === "chacha20-poly1305"));
});
test("alpn: ws/upg http/1.1, grpc h2", () => {
  const byNet = Object.fromEntries(profiles.map((p) => [`${p.meta.proto}/${p.meta.net}`, p.outbound.tls.alpn.join()]));
  assert.strictEqual(byNet["vless/httpupgrade"], "http/1.1");
  assert.strictEqual(byNet["trojan/grpc"], "h2");
  assert.strictEqual(byNet["vmess/grpc"], "h2");
});
test("kardes hat secimi (UPG -> WS / gRPC)", () => {
  const store = { profiles };
  const upg = profiles.find((p) => p.meta.proto === "vless" && p.meta.net === "httpupgrade");
  assert.strictEqual(L.pickProfile(store, upg.id, "ws").outbound.transport.path, "/p");
  assert.strictEqual(L.pickProfile(store, upg.id, "auto").id, upg.id);
  assert.throws(() => L.pickProfile(store, upg.id, "grpc"), /gRPC|GRPC/);
});
test("abonelik kodu normallestirme", () => {
  assert.strictEqual(L.normalizeSubscription("sub/1_Du84Bvh5-TaW_UmlCzeg", D), `https://${D}/sub/1_Du84Bvh5-TaW_UmlCzeg`);
  assert.strictEqual(L.normalizeSubscription(`http://${D}/sub/abcdefgh?format=json#x`, "x"), `https://${D}/sub/abcdefgh`);
  assert.throws(() => L.normalizeSubscription("admin", D));
});
test("ip ayristirma (cloudflare trace / duz metin / IPv6)", () => {
  assert.strictEqual(L.parseIp("fl=1\nh=x\nip=88.1.2.3\nts=1"), "88.1.2.3");
  assert.strictEqual(L.parseIp("188.119.8.194\n"), "188.119.8.194");
  assert.strictEqual(L.parseIp("2a02:ff0::1"), "2a02:ff0::1");
  assert.strictEqual(L.parseIp("<html>"), "");
});
test("config: proxy modu, dogrulama acik", () => {
  const cfg = L.buildCoreConfig(profiles[0].outbound, { tun: false, insecure: false, uplink: null, localPort: 17890 });
  assert.strictEqual(cfg.outbounds[0].tls.insecure, false);
  assert.strictEqual(cfg.inbounds.length, 1);
  assert.strictEqual(cfg.inbounds[0].listen, "127.0.0.1");
  assert.ok(cfg.route.auto_detect_interface);
  assert.ok(!JSON.stringify(cfg).includes("\"sniff\":true"), "eski inbound sniff alani olmamali");
});
test("config: TUN + ag denetimi + kurum proxy'si", () => {
  const up = { server: "10.0.0.1", server_port: 8080 };
  const cfg = L.buildCoreConfig(profiles[2].outbound, { tun: true, insecure: true, uplink: up, localPort: 17890 });
  assert.strictEqual(cfg.inbounds[0].type, "tun");
  assert.strictEqual(cfg.outbounds[0].tls.insecure, true);
  assert.strictEqual(cfg.outbounds[0].detour, "uplink");
  assert.ok(cfg.route.rules.some((r) => r.action === "hijack-dns"));
  assert.ok(!cfg.dns.servers.some((s) => s.detour === "direct"), "bos direct detour sing-box'ta hata verir");
});

const xh = profiles.find((p) => p.meta.net === "xhttp");
test("xhttp linki Xray gerektirir", () => {
  assert.ok(L.needsXray(xh.outbound));
  assert.ok(!L.needsXray(profiles[0].outbound));
  assert.deepStrictEqual(xh.outbound.tls.alpn, ["h2", "http/1.1"]);
  assert.strictEqual(xh.outbound.transport.mode, "packet-up");
});
test("xray config: okul agi pinleri ve kurum proxy'si", () => {
  const x = L.buildXrayConfig(xh.outbound, { pins: ["aa", "bb"], uplink: { server: "10.0.0.1", server_port: 8080 }, socksPort: 17891 });
  const st = x.outbounds[0].streamSettings;
  assert.strictEqual(st.network, "xhttp");
  assert.strictEqual(st.xhttpSettings.path, "/p-xh");
  assert.strictEqual(st.tlsSettings.pinnedPeerCertSha256, "aa,bb");
  assert.ok(!("allowInsecure" in st.tlsSettings), "Xray 26 allowInsecure'u reddeder");
  assert.strictEqual(st.sockopt.dialerProxy, "uplink");
  assert.strictEqual(x.inbounds[0].port, 17891);
});
test("xray config: normal agda pin yok (tam dogrulama)", () => {
  const x = L.buildXrayConfig(xh.outbound, { pins: [], uplink: null, socksPort: 17891 });
  assert.ok(!("pinnedPeerCertSha256" in x.outbounds[0].streamSettings.tlsSettings));
});
test("sing-box: xhttp hattinda socks -> Xray, TUN'da Xray sureci dogrudan", () => {
  const cfg = L.buildCoreConfig(xh.outbound, { tun: true, insecure: true, uplink: { server: "10.0.0.1", server_port: 8080 }, localPort: 17890, xrayPort: 17891, xrayProcess: "aether-xray.exe" });
  assert.deepStrictEqual(cfg.outbounds[0], { type: "socks", tag: "proxy", server: "127.0.0.1", server_port: 17891, version: "5" });
  assert.ok(!cfg.outbounds.some((o) => o.tag === "uplink"), "kurum proxy'si Xray tarafinda");
  const iProc = cfg.route.rules.findIndex((r) => r.process_name);
  const iDns = cfg.route.rules.findIndex((r) => r.action === "hijack-dns");
  assert.ok(iProc > 0 && iProc < iDns, "Xray DNS'i hijack'ten once dogrudan cikmali");
});
test("kardes hat secimi: XH", () => {
  const upg = profiles.find((p) => p.meta.proto === "vless" && p.meta.net === "httpupgrade");
  assert.strictEqual(L.pickProfile({ profiles }, upg.id, "xh").meta.net, "xhttp");
});

if (failed) {
  console.log(`\n${failed} test basarisiz`);
  process.exit(1);
}
console.log("\ntum testler gecti");
