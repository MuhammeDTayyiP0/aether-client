const copy = {
  tr: {
    down: "BAĞLI DEĞİL",
    pill: { down: "KAPALI", busy: "…", up: "AÇIK" },
    busy: "BAĞLANIYOR…",
    up: "BAĞLI",
    upMitm: "BAĞLI · AĞ DENETİMİ VAR",
    pick: "Düğüm seçilmedi",
    go: "Bağlan",
    stop: "Bağlantıyı kes",
    cancel: "İptal",
    nodes: "Düğümler",
    add: "Ekle",
    empty: "Henüz düğüm yok. Aşağıya abonelik kodunuzu girin.",
    needSub: "Abonelik kodunuzu girin (yöneticiden alınır).",
    proxy: "Proxy: 127.0.0.1:17890",
    noNode: "Önce listeden bir düğüm seçin.",
    noCore: "Çekirdek bulunamadı. GitHub Release paketini kullanın.",
    fetching: "liste alınıyor…",
    tunOn: "TUN: tüm trafik (yönetici)",
    tunOff: "Sistem proxy'si",
    netOk: "Normal",
    netMitm: "Denetleniyor",
    mitm: (issuer) => `Bu ağ HTTPS trafiğini denetliyor (sertifika: ${issuer || "bilinmiyor"}). Bağlantı çalışır, ancak ağ yöneticisi VLESS/Trojan hatlarının içeriğini görebilir; VMess hatları içeriği ayrıca şifreler. Telefonlar için bu parmak izini panele (Telefon & Okul Ağı) girin:`,
    browser: "Tarayıcıyı tünel ile aç",
    proto: { auto: "Seçili hat", upg: "HTTPUpgrade", ws: "WebSocket", grpc: "gRPC (HTTP/2)" },
  },
  en: {
    down: "DISCONNECTED",
    pill: { down: "OFF", busy: "…", up: "ON" },
    busy: "CONNECTING…",
    up: "CONNECTED",
    upMitm: "CONNECTED · NETWORK INSPECTED",
    pick: "No node selected",
    go: "Connect",
    stop: "Disconnect",
    cancel: "Cancel",
    nodes: "Nodes",
    add: "Add",
    empty: "No nodes yet. Enter your subscription code below.",
    needSub: "Enter your subscription code (from your admin).",
    proxy: "Proxy: 127.0.0.1:17890",
    noNode: "Select a node first.",
    noCore: "Core not found. Use the GitHub Release package.",
    fetching: "fetching list…",
    tunOn: "TUN: all traffic (admin)",
    tunOff: "System proxy",
    netOk: "Normal",
    netMitm: "Inspected",
    mitm: (issuer) => `This network inspects HTTPS (certificate: ${issuer || "unknown"}). The tunnel works, but the network admin can read VLESS/Trojan contents; VMess lines add their own encryption. For phones, enter this fingerprint in the panel:`,
    browser: "Open browser through tunnel",
    proto: { auto: "Selected line", upg: "HTTPUpgrade", ws: "WebSocket", grpc: "gRPC (HTTP/2)" },
  },
};

let locale = "tr";
let profiles = [];
let selected = null;
let running = false;
let busy = false;
let exitIp = "";
let latencyMs = 0;
let tunMode = false;
let selectedProto = "auto";
let network = null;
let subscription = "";

const $ = (id) => document.getElementById(id);
const L = () => copy[locale];

function selectedProfile() {
  return profiles.find((p) => p.id === selected) || profiles[0] || null;
}

function protoLabel(p) {
  const net = (p.meta && p.meta.net) || "";
  if (net === "grpc") return ["gRPC", "grpc"];
  if (net === "httpupgrade") return ["UPG", "upg"];
  if (net === "ws") return ["WS", ""];
  return [net.toUpperCase() || "TCP", ""];
}

function paint() {
  const T = L();
  $("lang").textContent = locale.toUpperCase();
  $("nodesTitle").textContent = T.nodes;
  $("add").textContent = T.add;
  $("modeHint").textContent = tunMode ? T.tunOn : T.tunOff;
  $("modeTun").classList.toggle("on", tunMode);
  $("modeProxy").classList.toggle("on", !tunMode);
  for (const key of ["auto", "upg", "ws", "grpc"]) {
    $(`proto${key[0].toUpperCase()}${key.slice(1)}`).classList.toggle("on", selectedProto === key);
  }
  $("protoHint").textContent = T.proto[selectedProto];
  $("browserRow").hidden = !running || tunMode;
  $("launchBrowserText").textContent = T.browser;

  const mitm = Boolean(network && network.mitm);
  $("proxyHint").textContent = running && exitIp ? `${tunMode ? "TUN" : "Proxy"} · ${exitIp}` : T.proxy;
  $("ipValue").textContent = running && exitIp ? exitIp : "—";
  $("pingValue").textContent = running && latencyMs ? `${latencyMs} ms` : "—";
  $("netValue").textContent = network ? (mitm ? T.netMitm : T.netOk) : "—";

  const notice = $("netNotice");
  const pins = (network && network.pins) || [];
  notice.hidden = !mitm;
  if (mitm) {
    $("netNoticeText").textContent = T.mitm(network.issuer);
    $("netPins").textContent = pins.join("\n");
    $("copyPins").hidden = !pins.length;
  }

  const p = selectedProfile();
  $("nodeName").textContent = p ? p.name : T.pick;
  const ring = $("ring");
  const pill = $("pill");
  const pillText = pill.querySelector(".shield-text");
  const goBtn = $("go");
  const goText = $("goText");

  if (busy) {
    ring.dataset.state = "busy";
    $("stateLabel").textContent = T.busy;
    goText.textContent = T.cancel;
    goBtn.disabled = false;
    goBtn.classList.add("cancel");
    goBtn.classList.remove("on");
    pillText.textContent = T.pill.busy;
    pill.classList.remove("on");
  } else if (running) {
    ring.dataset.state = "up";
    $("stateLabel").textContent = mitm ? T.upMitm : T.up;
    goText.textContent = T.stop;
    goBtn.disabled = false;
    goBtn.classList.remove("cancel");
    goBtn.classList.add("on");
    pillText.textContent = T.pill.up;
    pill.classList.add("on");
  } else {
    ring.dataset.state = "down";
    $("stateLabel").textContent = T.down;
    goText.textContent = T.go;
    goBtn.disabled = !p;
    goBtn.classList.remove("cancel", "on");
    pillText.textContent = T.pill.down;
    pill.classList.remove("on");
  }

  $("serverCount").textContent = String(profiles.length);
  $("fetchHint").textContent = subscription;
  $("manualTitle").textContent = subscription ? "+ Abonelik kodu veya profil ekle" : `+ ${T.needSub}`;
  if (!subscription && !profiles.length) $("manual").hidden = false;

  const ul = $("nodes");
  ul.innerHTML = "";
  if (!profiles.length) {
    const e = document.createElement("p");
    e.className = "blade-empty";
    e.textContent = T.empty;
    ul.appendChild(e);
    return;
  }

  profiles.forEach((n) => {
    const li = document.createElement("li");
    li.className = "blade-item";
    if (n.id === (selected || (p && p.id))) li.classList.add("active");
    const [label, cls] = protoLabel(n);
    li.innerHTML = `
      <span class="blade-dot"></span>
      <div class="blade-body">
        <div class="blade-top">
          <span class="blade-name"></span>
          <div class="blade-badges">
            <span class="badge-proto"></span>
          </div>
        </div>
        <span class="blade-domain"></span>
      </div>
      ${n.source === "local" ? '<button type="button" class="blade-delete-btn" aria-label="Kaldır">×</button>' : ""}
    `;
    li.querySelector(".blade-name").textContent = n.name;
    li.querySelector(".blade-domain").textContent = `${(n.meta && n.meta.proto) || ""} · ${n.domain}`;
    const badge = li.querySelector(".badge-proto");
    badge.textContent = label;
    if (cls) badge.classList.add(cls);

    li.addEventListener("click", (ev) => {
      if (ev.target.closest(".blade-delete-btn") || busy) return;
      selected = n.id;
      paint();
    });
    const kill = li.querySelector(".blade-delete-btn");
    if (kill) {
      kill.addEventListener("click", async (ev) => {
        ev.stopPropagation();
        profiles = await window.aether.removeProfile(n.id);
        if (selected === n.id) selected = profiles[0] ? profiles[0].id : null;
        paint();
      });
    }
    ul.appendChild(li);
  });
}

function showErr(msg) {
  const raw = String(msg || "");
  const needAdmin = raw.includes("NEED_ADMIN:");
  const text = raw.replace(/^Error invoking remote method '[^']+': (Error: )?/, "").replace("NEED_ADMIN:", "");
  $("errBox").hidden = !text;
  $("err").textContent = text;
  $("elevateBtn").hidden = !(needAdmin && document.documentElement.dataset.os === "win32");
}

function applyState(s) {
  running = Boolean(s.running);
  exitIp = s.exitIp || "";
  latencyMs = s.latencyMs || 0;
  if (typeof s.tunMode !== "undefined") tunMode = Boolean(s.tunMode);
  if (s.network !== undefined) network = s.network;
  if (s.subscription !== undefined) subscription = s.subscription;
  if (s.activeId) selected = s.activeId;
}

async function refresh() {
  const s = await window.aether.state();
  locale = s.locale || locale;
  profiles = s.profiles || [];
  applyState(s);
  if (s.platform) document.documentElement.dataset.os = s.platform;
  $("versionTag").textContent = s.version ? `v${s.version}` : "";
  if (!selected && profiles[0]) selected = profiles[0].id;
  if (!s.coreOk) showErr(L().noCore);
  paint();
}

async function setTun(on) {
  if (busy) return;
  try {
    applyState(await window.aether.setTun(Boolean(on)));
    showErr(null);
  } catch (e) {
    showErr(e.message || String(e));
  }
  paint();
}

$("modeTun").addEventListener("click", () => setTun(true));
$("modeProxy").addEventListener("click", () => setTun(false));

for (const key of ["auto", "upg", "ws", "grpc"]) {
  $(`proto${key[0].toUpperCase()}${key.slice(1)}`).addEventListener("click", () => {
    selectedProto = key;
    paint();
  });
}

$("launchBrowserBtn").addEventListener("click", async () => {
  const label = $("launchBrowserText");
  try {
    const r = await window.aether.launchBrowser();
    label.textContent = r.ok ? `${r.browser} açıldı ✓` : r.error || "Açılamadı";
  } catch {
    label.textContent = "Açılamadı";
  }
  setTimeout(paint, 2000);
});

$("copyPins").addEventListener("click", async () => {
  await window.aether.copy(((network && network.pins) || []).join("\n"));
  $("copyPins").textContent = "Kopyalandı ✓";
  setTimeout(() => ($("copyPins").textContent = "Parmak izini kopyala"), 1600);
});

$("elevateBtn").addEventListener("click", async () => {
  const ok = await window.aether.relaunchAdmin();
  if (!ok) showErr("Yönetici izni verilmedi.");
});

$("lang").addEventListener("click", async () => {
  locale = locale === "tr" ? "en" : "tr";
  await window.aether.setLocale(locale);
  paint();
});

$("manualToggle").addEventListener("click", () => {
  $("manual").hidden = !$("manual").hidden;
});

$("add").addEventListener("click", async () => {
  showErr(null);
  const btn = $("add");
  btn.disabled = true;
  $("fetchHint").textContent = L().fetching;
  try {
    profiles = await window.aether.addProfile($("paste").value);
    $("paste").value = "";
    $("manual").hidden = true;
    const s = await window.aether.state();
    applyState(s);
    if (!profiles.some((x) => x.id === selected)) selected = profiles[0] ? profiles[0].id : null;
  } catch (e) {
    showErr(e.message || String(e));
  } finally {
    btn.disabled = false;
    paint();
  }
});

$("reload").addEventListener("click", async () => {
  if (!subscription) {
    $("manual").hidden = false;
    return showErr(L().needSub);
  }
  $("fetchHint").textContent = L().fetching;
  showErr(null);
  try {
    const r = await window.aether.refreshVlist();
    profiles = r.profiles || [];
    if (r.network !== undefined) network = r.network;
    if (!profiles.some((x) => x.id === selected)) selected = profiles[0] ? profiles[0].id : null;
  } catch (e) {
    showErr(e.message || String(e));
  }
  paint();
});

async function toggle() {
  showErr(null);
  if (busy || running) {
    busy = false;
    try { applyState(await window.aether.disconnect()); } catch { /* zaten kapali */ }
    running = false;
    paint();
    return;
  }
  const p = selectedProfile();
  if (!p) return showErr(L().noNode);
  busy = true;
  paint();
  try {
    applyState(await window.aether.connect(p.id, selectedProto));
  } catch (e) {
    // Kullanici iptal ettiyse hata gosterme
    if (!String(e.message || "").includes("iptal edildi")) showErr(e.message || String(e));
    running = false;
  } finally {
    busy = false;
    const s = await window.aether.state();
    applyState(s);
    paint();
  }
}

$("go").addEventListener("click", toggle);
$("ring").addEventListener("click", toggle);

window.aether.onStatus((s) => {
  applyState(s);
  if (s.lastError) showErr(s.lastError);
  paint();
});

window.aether.onVlist((r) => {
  profiles = r.profiles || [];
  if (r.network !== undefined) network = r.network;
  if (!profiles.some((x) => x.id === selected)) selected = profiles[0] ? profiles[0].id : null;
  showErr(null);
  paint();
});

window.aether.onVlistError((e) => {
  showErr(e.message);
});

refresh();
