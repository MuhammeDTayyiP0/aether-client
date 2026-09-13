const copy = {
  tr: {
    down: "bağlanmamış",
    busy: "bağlanıyor",
    up: "oturum açık",
    pick: "sunucu bekleniyor",
    go: "Bağlan",
    stop: "Kes",
    nodes: "Sunucular",
    add: "Ekle",
    empty: "Liste henüz yok. Yenile’ye bas.",
    proxy: "127.0.0.1:1080",
    noNode: "Sunucu yok — vlist.geldesat.com",
    noCore: "Çekirdek pakette. GitHub Release’i kullan — sing-box ayrı indirme.",
    reload: "Yenile",
    fetching: "liste alınıyor…",
    fetchOk: "vlist.geldesat.com",
    manual: "Manuel ekle",
    steps: ["DNS", "TLS", "Kenar", "Yol", "Kimlik"],
  },
  en: {
    down: "disconnected",
    busy: "connecting",
    up: "session up",
    pick: "waiting for node",
    go: "Connect",
    stop: "Disconnect",
    nodes: "Servers",
    add: "Add",
    empty: "No list yet. Hit refresh.",
    proxy: "127.0.0.1:1080",
    noNode: "No server — vlist.geldesat.com",
    noCore: "Core is bundled. Use a GitHub Release — don’t install sing-box.",
    reload: "Refresh",
    fetching: "fetching list…",
    fetchOk: "vlist.geldesat.com",
    manual: "Add manually",
    steps: ["DNS", "TLS", "Edge", "Path", "Identity"],
  },
};

let locale = "tr";
let profiles = [];
let selected = null;
let running = false;
let busy = false;
let exitIp = "";

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
  $("reload").textContent = L.reload;
  $("manualToggle").textContent = L.manual;
  $("proxyHint").textContent = running && exitIp ? "çıkış " + exitIp : L.proxy;
  const p = selectedProfile();
  $("nodeName").textContent = p ? p.name : L.pick;
  const ring = $("ring");
  const pill = $("pill");
  if (busy) {
    ring.dataset.state = "busy";
    $("stateLabel").textContent = L.busy;
    $("go").textContent = L.busy;
    $("go").disabled = true;
    $("go").classList.remove("on");
    pill.textContent = L.busy;
    pill.classList.remove("on");
  } else if (running) {
    ring.dataset.state = "up";
    $("stateLabel").textContent = L.up;
    $("go").textContent = L.stop;
    $("go").disabled = false;
    $("go").classList.add("on");
    pill.textContent = L.up;
    pill.classList.add("on");
  } else {
    ring.dataset.state = "down";
    $("stateLabel").textContent = L.down;
    $("go").textContent = L.go;
    $("go").disabled = !p;
    $("go").classList.remove("on");
    pill.textContent = L.down;
    pill.classList.remove("on");
  }
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
    li.innerHTML =
      '<span class="dot"></span><span class="meta"><b></b><span></span></span>' +
      (n.source === "local" ? '<button type="button" class="kill" aria-label="remove">×</button>' : "");
    li.querySelector("b").textContent = n.name;
    li.querySelector("span span").textContent = n.domain;
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
      stepTimer = setTimeout(tick, 240);
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
  if (s.platform) document.documentElement.dataset.os = s.platform;
  if (s.activeId) selected = s.activeId;
  else if (!selected && profiles[0]) selected = profiles[0].id;
  if (s.lastError) {
    $("err").hidden = false;
    $("err").textContent = s.lastError;
  }
  if (!s.coreOk) {
    $("err").hidden = false;
    $("err").textContent = t("noCore");
  }
  if (s.remoteAt) $("fetchHint").textContent = t("fetchOk");
  paint();
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
  $("err").hidden = true;
  try {
    profiles = await window.aether.addProfile($("paste").value);
    $("paste").value = "";
    selected = profiles[profiles.length - 1].id;
    paint();
  } catch (e) {
    $("err").hidden = false;
    $("err").textContent = e.message || String(e);
  }
});
$("reload").addEventListener("click", async () => {
  $("fetchHint").textContent = t("fetching");
  $("err").hidden = true;
  try {
    const r = await window.aether.refreshVlist();
    profiles = r.profiles || [];
    if (profiles[0]) selected = profiles[0].id;
    $("fetchHint").textContent = t("fetchOk");
    paint();
  } catch (e) {
    $("fetchHint").textContent = t("fetchOk");
    $("err").hidden = false;
    $("err").textContent = e.message || String(e);
  }
});

async function toggle() {
  $("err").hidden = true;
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
    $("err").hidden = false;
    $("err").textContent = t("noNode");
    return;
  }
  busy = true;
  paint();
  runSteps();
  try {
    await window.aether.connect(p.id);
    running = true;
  } catch (e) {
    $("err").hidden = false;
    $("err").textContent = e.message || String(e);
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
  if (!s.running) {
    busy = false;
    clearSteps();
  }
  if (s.lastError) {
    $("err").hidden = false;
    $("err").textContent = s.lastError;
  }
  paint();
});
window.aether.onVlist((r) => {
  profiles = r.profiles || [];
  if (profiles[0] && !selected) selected = profiles[0].id;
  $("fetchHint").textContent = t("fetchOk");
  $("err").hidden = true;
  paint();
});
window.aether.onVlistError((e) => {
  $("err").hidden = false;
  $("err").textContent = e.message || t("noNode");
});

$("fetchHint").textContent = copy.tr.fetching;
refresh();
