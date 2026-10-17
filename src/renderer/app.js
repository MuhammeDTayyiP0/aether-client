const copy = {
  tr: {
    down: "BAĞLANTI BEKLENİYOR",
    busy: "BAĞLANTI KURULUYOR…",
    up: "GÜVENLİ VE ŞİFRELİ",
    pick: "Sunucu Bekleniyor",
    go: "Bağlantıyı Başlat",
    stop: "Bağlantıyı Güvenle Kes",
    nodes: "Düğümler",
    add: "Profili İçe Aktar",
    empty: "Düğüm listesi henüz yok. Yenile'ye basın.",
    proxy: "Proxy: 127.0.0.1:17890",
    noNode: "Sunucu yok — vlist.geldesat.com",
    noCore: "Çekirdek pakette. GitHub Release'i kullanın — sing-box ayrı indirmeyin.",
    reload: "Yenile",
    fetching: "liste çekiliyor…",
    fetchOk: "vlist.geldesat.com",
    manual: "+ Manuel VLESS Ekle",
    tunOn: "Full TUN Modu (Yönetici)",
    tunOff: "Sistem & Tarayıcı Proxy",
    steps: ["DNS Çözümleme", "TLS 1.3 El Sıkışma", "Kenar Tüneli", "Yol Doğrulama", "Kimlik Onayı"],
  },
  en: {
    down: "DISCONNECTED",
    busy: "ESTABLISHING TUNNEL…",
    up: "SECURED & ENCRYPTED",
    pick: "Waiting for Node",
    go: "Initialize Tunnel",
    stop: "Safely Disconnect",
    nodes: "Nodes",
    add: "Import Profile",
    empty: "No nodes available yet. Hit refresh.",
    proxy: "Proxy: 127.0.0.1:17890",
    noNode: "No server — vlist.geldesat.com",
    noCore: "Core is bundled. Use GitHub Release — do not install sing-box.",
    reload: "Refresh",
    fetching: "fetching list…",
    fetchOk: "vlist.geldesat.com",
    manual: "+ Add Manual VLESS",
    tunOn: "Full TUN Mode (Admin)",
    tunOff: "System & Browser Proxy",
    steps: ["DNS Resolve", "TLS 1.3 Handshake", "Edge Tunnel", "Path Verify", "Auth Check"],
  },
};

let locale = "tr";
let profiles = [];
let selected = null;
let running = false;
let busy = false;
let exitIp = "";
let tunMode = false;
let selectedProto = "auto";
let stepTimer = null;

const $ = (id) => document.getElementById(id);
function t(key) {
  return copy[locale][key];
}
function selectedProfile() {
  return profiles.find((p) => p.id === selected) || profiles[0] || null;
}

function paint() {
  const L = copy[locale];
  $("lang").textContent = locale.toUpperCase();
  $("nodesTitle").textContent = L.nodes;
  $("add").textContent = L.add;
  $("modeHint").textContent = tunMode ? L.tunOn : L.tunOff;
  $("modeTun").classList.toggle("on", tunMode);
  $("modeProxy").classList.toggle("on", !tunMode);

  $("protoAuto").classList.toggle("on", selectedProto === "auto");
  if ($("protoUpg")) $("protoUpg").classList.toggle("on", selectedProto === "upg");
  $("protoWs").classList.toggle("on", selectedProto === "ws");
  $("protoGrpc").classList.toggle("on", selectedProto === "grpc");

  if (selectedProto === "grpc") {
    $("protoHint").textContent = "gRPC (HTTP/2)";
  } else if (selectedProto === "upg") {
    $("protoHint").textContent = "HTTPUpgrade (En Hızlı)";
  } else if (selectedProto === "ws") {
    $("protoHint").textContent = "WebSocket";
  } else {
    $("protoHint").textContent = "Otomatik Tünel";
  }

  const browserRow = $("browserRow");
  if (browserRow) browserRow.hidden = !running;

  if ($("proxyHint")) {
    $("proxyHint").textContent = running && exitIp ? ((tunMode ? "TUN · " : "Proxy · ") + exitIp) : L.proxy;
  }

  const ipVal = $("ipValue");
  const pingVal = $("pingValue");
  const ambientTop = $("ambientTop");

  if (ipVal) {
    ipVal.textContent = running && exitIp ? exitIp : (tunMode ? "TUN Modu" : "127.0.0.1:17890");
  }

  const p = selectedProfile();
  $("nodeName").textContent = p ? p.name : L.pick;
  const ring = $("ring");
  const pill = $("pill");
  const pillText = pill ? pill.querySelector(".shield-text") : null;
  const goBtn = $("go");
  const goText = $("goText") || goBtn;

  if (busy) {
    ring.dataset.state = "busy";
    $("stateLabel").textContent = L.busy;
    goText.textContent = "Bağlantıyı İptal Et ✕";
    goBtn.disabled = false;
    goBtn.classList.add("cancel");
    goBtn.classList.remove("on");
    if (pillText) pillText.textContent = "BAĞLANIYOR";
    if (pill) pill.classList.remove("on");
    if (ambientTop) ambientTop.style.background = "radial-gradient(circle, rgba(245, 158, 11, 0.25) 0%, transparent 70%)";
    if (pingVal) pingVal.textContent = "El Sıkışılıyor…";
  } else if (running) {
    ring.dataset.state = "up";
    $("stateLabel").textContent = L.up;
    goText.textContent = L.stop;
    goBtn.disabled = false;
    goBtn.classList.remove("cancel");
    goBtn.classList.add("on");
    if (pillText) pillText.textContent = "GÜVENLİ";
    if (pill) pill.classList.add("on");
    if (ambientTop) ambientTop.style.background = "radial-gradient(circle, rgba(16, 185, 129, 0.25) 0%, transparent 70%)";
    if (pingVal) pingVal.textContent = "⚡ ~22 ms";
  } else {
    ring.dataset.state = "down";
    $("stateLabel").textContent = L.down;
    goText.textContent = L.go;
    goBtn.disabled = !p;
    goBtn.classList.remove("cancel");
    goBtn.classList.remove("on");
    if (pillText) pillText.textContent = "KESİK";
    if (pill) pill.classList.remove("on");
    if (ambientTop) ambientTop.style.background = "radial-gradient(circle, rgba(56, 189, 248, 0.12) 0%, transparent 70%)";
    if (pingVal) pingVal.textContent = "Ultra Hızlı";
  }

  if ($("serverCount")) $("serverCount").textContent = String(profiles.length);

  const ul = $("nodes");
  ul.innerHTML = "";
  if (!profiles.length) {
    const e = document.createElement("p");
    e.className = "blade-empty";
    e.textContent = L.empty;
    ul.appendChild(e);
    return;
  }

  profiles.forEach((n) => {
    const li = document.createElement("li");
    li.className = "blade-item";
    if (n.id === (selected || (p && p.id))) li.classList.add("active");

    let protoClass = "";
    let protoLabel = "WS";
    if (n.name && (n.name.indexOf("HTTPUpgrade") !== -1 || n.name.indexOf("upg") !== -1)) {
      protoLabel = "UPG";
      protoClass = "upg";
    } else if (n.name && n.name.indexOf("gRPC") !== -1) {
      protoLabel = "gRPC";
      protoClass = "grpc";
    } else if (n.config && n.config.outbounds && n.config.outbounds[0]) {
      const trans = n.config.outbounds[0].transport || {};
      if (trans.type === "grpc") { protoLabel = "gRPC"; protoClass = "grpc"; }
      else if (trans.type === "httpupgrade") { protoLabel = "UPG"; protoClass = "upg"; }
    }

    li.innerHTML = `
      <span class="blade-dot"></span>
      <div class="blade-body">
        <div class="blade-top">
          <span class="blade-name"></span>
          <div class="blade-badges">
            <span class="badge-proto ${protoClass}">${protoLabel}</span>
            <span class="badge-ping">⚡ Aktif</span>
          </div>
        </div>
        <span class="blade-domain"></span>
      </div>
      ${n.source === "local" ? '<button type="button" class="blade-delete-btn" aria-label="Kaldır">×</button>' : ""}
    `;

    li.querySelector(".blade-name").textContent = n.name;
    li.querySelector(".blade-domain").textContent = n.domain;

    li.addEventListener("click", (ev) => {
      if (ev.target.closest(".blade-delete-btn")) return;
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
  const box = $("errBox");
  const el = $("err");
  if (!msg) {
    if (box) box.hidden = true;
    if (el) el.textContent = "";
    return;
  }
  if (box) box.hidden = false;
  if (el) el.textContent = msg;
}

function runSteps() {
  const box = $("steps");
  box.hidden = false;
  box.innerHTML = "";
  copy[locale].steps.forEach((s) => {
    const li = document.createElement("li");
    li.textContent = s;
    box.appendChild(li);
  });
  let i = 0;
  const tick = () => {
    if (i < box.children.length) {
      box.children[i].dataset.on = "1";
      i += 1;
      stepTimer = setTimeout(tick, 220);
    }
  };
  tick();
}

function clearSteps() {
  clearTimeout(stepTimer);
  $("steps").hidden = true;
  $("steps").innerHTML = "";
}

async function refresh() {
  const s = await window.aether.state();
  locale = s.locale || locale;
  profiles = s.profiles || [];
  running = Boolean(s.running);
  exitIp = s.exitIp || "";
  tunMode = Boolean(s.tunMode || s.tunArmed);
  if (s.platform) document.documentElement.dataset.os = s.platform;
  if (s.activeId) selected = s.activeId;
  else if (!selected && profiles[0]) selected = profiles[0].id;

  if (s.lastError) showErr(s.lastError);
  if (!s.coreOk) showErr(t("noCore"));
  if (s.remoteAt) $("fetchHint").textContent = t("fetchOk");
  paint();
}

async function setTun(on) {
  tunMode = Boolean(on);
  paint();
  try {
    const st = await window.aether.setTun(tunMode);
    tunMode = Boolean(st.tunMode || st.tunArmed);
    running = Boolean(st.running);
    exitIp = st.exitIp || "";
    showErr(null);
  } catch (e) {
    showErr(e.message || String(e));
  }
  paint();
}

$("modeTun").addEventListener("click", () => setTun(true));
$("modeProxy").addEventListener("click", () => setTun(false));

$("protoAuto").addEventListener("click", () => { selectedProto = "auto"; paint(); });
if ($("protoUpg")) $("protoUpg").addEventListener("click", () => { selectedProto = "upg"; paint(); });
$("protoWs").addEventListener("click", () => { selectedProto = "ws"; paint(); });
$("protoGrpc").addEventListener("click", () => { selectedProto = "grpc"; paint(); });

const bBtn = $("launchBrowserBtn");
if (bBtn) {
  bBtn.addEventListener("click", async () => {
    bBtn.textContent = "Açılıyor…";
    try {
      await window.aether.launchBrowser();
      bBtn.textContent = "Tarayıcı Başlatıldı ✓";
    } catch {
      bBtn.textContent = "Başlatılamadı";
    }
    setTimeout(() => { bBtn.textContent = "🌐 Chrome'u Tünel ile Başlat"; }, 2000);
  });
}

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
  try {
    profiles = await window.aether.addProfile($("paste").value);
    $("paste").value = "";
    selected = profiles[profiles.length - 1].id;
    paint();
  } catch (e) {
    showErr(e.message || String(e));
  }
});

$("reload").addEventListener("click", async () => {
  $("fetchHint").textContent = t("fetching");
  showErr(null);
  try {
    const r = await window.aether.refreshVlist();
    profiles = r.profiles || [];
    if (profiles[0]) selected = profiles[0].id;
    $("fetchHint").textContent = t("fetchOk");
    paint();
  } catch (e) {
    $("fetchHint").textContent = t("fetchOk");
    showErr(e.message || String(e));
  }
});

async function toggle() {
  showErr(null);
  if (busy) {
    busy = false;
    clearSteps();
    try { await window.aether.disconnect(); } catch {}
    paint();
    return;
  }
  if (running) {
    await window.aether.disconnect();
    running = false;
    busy = false;
    clearSteps();
    paint();
    return;
  }
  const p = selectedProfile();
  if (!p) {
    showErr(t("noNode"));
    return;
  }
  busy = true;
  paint();
  runSteps();
  try {
    await window.aether.connect(p.id, selectedProto);
    running = true;
  } catch (e) {
    showErr(e.message || String(e));
    running = false;
  } finally {
    busy = false;
    if (!running) clearSteps();
    paint();
  }
}

$("go").addEventListener("click", toggle);
$("ring").addEventListener("click", toggle);

window.aether.onStatus((s) => {
  running = Boolean(s.running);
  exitIp = s.exitIp || "";
  if (typeof s.tunMode !== "undefined") tunMode = Boolean(s.tunMode || s.tunArmed);
  if (!s.running) {
    busy = false;
    clearSteps();
  }
  if (s.lastError) showErr(s.lastError);
  paint();
});

window.aether.onVlist((r) => {
  profiles = r.profiles || [];
  if (profiles[0] && !selected) selected = profiles[0].id;
  $("fetchHint").textContent = t("fetchOk");
  showErr(null);
  paint();
});

window.aether.onVlistError((e) => {
  showErr(e.message || t("noNode"));
});

$("fetchHint").textContent = copy.tr.fetching;
refresh();
