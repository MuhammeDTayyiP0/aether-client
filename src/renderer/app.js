const copy = {
  tr: {
    down: "bağlantı kesik",
    busy: "bağlanıyor…",
    up: "güvenli ve bağlı",
    pick: "sunucu bekleniyor",
    go: "Bağlan",
    stop: "Bağlantıyı Kes",
    nodes: "Sunucular",
    add: "Ekle",
    empty: "Liste henüz yok. Yenile’ye bas.",
    proxy: "127.0.0.1:17890",
    noNode: "Sunucu yok — vlist.geldesat.com",
    noCore: "Çekirdek pakette. GitHub Release’i kullan — sing-box ayrı indirme.",
    reload: "Yenile",
    fetching: "liste alınıyor…",
    fetchOk: "vlist.geldesat.com",
    manual: "Manuel VLESS Ekle",
    tunOn: "Tüm Sistem (Yönetici)",
    tunOff: "Tarayıcı & Sistem Proxy",
    steps: ["DNS Çözme", "TLS El Sıkışma", "Kenar Tüneli", "Yol Doğrulama", "Kimlik Onayı"],
  },
  en: {
    down: "disconnected",
    busy: "connecting…",
    up: "secured & active",
    pick: "waiting for node",
    go: "Connect",
    stop: "Disconnect",
    nodes: "Servers",
    add: "Add",
    empty: "No servers yet. Hit refresh.",
    proxy: "127.0.0.1:17890",
    noNode: "No server — vlist.geldesat.com",
    noCore: "Core is bundled. Use GitHub Release — do not install sing-box.",
    reload: "Refresh",
    fetching: "fetching list…",
    fetchOk: "vlist.geldesat.com",
    manual: "Add VLESS Manually",
    tunOn: "Full System (Admin)",
    tunOff: "Browser & System Proxy",
    steps: ["DNS Resolve", "TLS Handshake", "Edge Tunnel", "Path Verify", "Auth Check"],
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
  $("protoWs").classList.toggle("on", selectedProto === "ws");
  if ($("protoUpg")) $("protoUpg").classList.toggle("on", selectedProto === "upg");
  $("protoGrpc").classList.toggle("on", selectedProto === "grpc");

  if (selectedProto === "grpc") {
    $("protoHint").textContent = "gRPC (HTTP/2 — Mobil Hızlı)";
  } else if (selectedProto === "upg") {
    $("protoHint").textContent = "HTTPUpgrade (MEB & CDN)";
  } else if (selectedProto === "ws") {
    $("protoHint").textContent = "WebSocket (Standart)";
  } else {
    $("protoHint").textContent = "Otomatik";
  }

  const browserRow = $("browserRow");
  if (browserRow) browserRow.hidden = !running;

  $("proxyHint").textContent = running && exitIp ? ((tunMode ? "TUN · " : "Proxy · ") + exitIp) : L.proxy;
  
  const ipChip = $("ipChip");
  const ipVal = $("ipValue");
  if (ipChip && ipVal) {
    if (running && exitIp) {
      ipChip.hidden = false;
      ipVal.textContent = exitIp;
    } else {
      ipChip.hidden = true;
    }
  }

  const p = selectedProfile();
  $("nodeName").textContent = p ? p.name : L.pick;
  const ring = $("ring");
  const pill = $("pill");
  const pillText = pill.querySelector(".pill-text");

  if (busy) {
    ring.dataset.state = "busy";
    $("stateLabel").textContent = L.busy;
    $("go").textContent = "İptal Et ✕";
    $("go").disabled = false;
    $("go").classList.add("cancel");
    $("go").classList.remove("on");
    if (pillText) pillText.textContent = L.busy;
    pill.classList.remove("on");
  } else if (running) {
    ring.dataset.state = "up";
    $("stateLabel").textContent = L.up;
    $("go").textContent = L.stop;
    $("go").disabled = false;
    $("go").classList.remove("cancel");
    $("go").classList.add("on");
    if (pillText) pillText.textContent = L.up;
    pill.classList.add("on");
  } else {
    ring.dataset.state = "down";
    $("stateLabel").textContent = L.down;
    $("go").textContent = L.go;
    $("go").disabled = !p;
    $("go").classList.remove("cancel");
    $("go").classList.remove("on");
    if (pillText) pillText.textContent = L.down;
    pill.classList.remove("on");
  }

  if ($("serverCount")) $("serverCount").textContent = String(profiles.length);

  const ul = $("nodes");
  ul.innerHTML = "";
  if (!profiles.length) {
    const e = document.createElement("p");
    e.className = "empty";
    e.textContent = L.empty;
    ul.appendChild(e);
    return;
  }

  profiles.forEach((n) => {
    const li = document.createElement("li");
    if (n.id === (selected || (p && p.id))) li.classList.add("active");

    let protoTag = "WS";
    if (n.name && (n.name.indexOf("HTTPUpgrade") !== -1 || n.name.indexOf("upg") !== -1)) protoTag = "UPG";
    else if (n.name && n.name.indexOf("gRPC") !== -1) protoTag = "gRPC";
    else if (n.config && n.config.outbounds && n.config.outbounds[0]) {
      const trans = n.config.outbounds[0].transport || {};
      if (trans.type === "grpc") protoTag = "gRPC";
      else if (trans.type === "httpupgrade") protoTag = "UPG";
    }

    li.innerHTML = `
      <span class="dot"></span>
      <div class="meta">
        <div class="meta-top">
          <span class="node-title"></span>
          <div class="meta-tags">
            <span class="proto-tag">${protoTag}</span>
            <span class="ping-tag">⚡ Aktif</span>
          </div>
        </div>
        <span class="node-sub"></span>
      </div>
      ${n.source === "local" ? '<button type="button" class="kill" aria-label="remove">×</button>' : ""}
    `;

    li.querySelector(".node-title").textContent = n.name;
    li.querySelector(".node-sub").textContent = n.domain;

    li.addEventListener("click", (ev) => {
      if (ev.target.closest(".kill")) return;
      selected = n.id;
      paint();
    });

    const kill = li.querySelector(".kill");
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
$("protoWs").addEventListener("click", () => { selectedProto = "ws"; paint(); });
if ($("protoUpg")) $("protoUpg").addEventListener("click", () => { selectedProto = "upg"; paint(); });
$("protoGrpc").addEventListener("click", () => { selectedProto = "grpc"; paint(); });

const bBtn = $("launchBrowserBtn");
if (bBtn) {
  bBtn.addEventListener("click", async () => {
    bBtn.textContent = "Açılıyor…";
    try {
      await window.aether.launchBrowser();
      bBtn.textContent = "Tarayıcı Açıldı ✓";
    } catch {
      bBtn.textContent = "Açılamadı";
    }
    setTimeout(() => { bBtn.textContent = "🚀 Chrome'u VPN ile Başlat"; }, 2000);
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
