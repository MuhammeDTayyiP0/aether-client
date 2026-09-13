const copy = {
  tr: {
    down: "bağlanmamış",
    busy: "bağlanıyor",
    up: "oturum açık",
    pick: "düğüm seç",
    go: "Bağlan",
    stop: "Kes",
    nodes: "Düğümler",
    add: "Ekle",
    empty: "Atölye’den JSON veya vless:// yapıştır.",
    proxy: "SOCKS/HTTP 127.0.0.1:1080",
    noNode: "Önce düğüm ekle",
    noCore: "Çekirdek yok. GitHub Release paketini kullan.",
    steps: ["DNS", "TLS 1.3", "Cloudflare kenarı", "WebSocket", "Kimlik"],
  },
  en: {
    down: "disconnected",
    busy: "connecting",
    up: "session up",
    pick: "pick a node",
    go: "Connect",
    stop: "Disconnect",
    nodes: "Nodes",
    add: "Add",
    empty: "Paste Lab JSON or vless://",
    proxy: "SOCKS/HTTP 127.0.0.1:1080",
    noNode: "Add a node first",
    noCore: "Core missing. Install a GitHub Release build.",
    steps: ["DNS", "TLS 1.3", "Cloudflare edge", "WebSocket", "Identity"],
  },
};

let locale = "tr";
let profiles = [];
let selected = null;
let running = false;
let busy = false;
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
  $("paste").placeholder = L.empty;
  $("proxyHint").textContent = L.proxy;

  const p = selectedProfile();
  $("nodeName").textContent = p ? p.name : L.pick;

  const ring = $("ring");
  if (busy) {
    ring.dataset.state = "busy";
    $("stateLabel").textContent = L.busy;
    $("go").textContent = L.busy;
    $("go").disabled = true;
    $("go").classList.remove("on");
  } else if (running) {
    ring.dataset.state = "up";
    $("stateLabel").textContent = L.up;
    $("go").textContent = L.stop;
    $("go").disabled = false;
    $("go").classList.add("on");
  } else {
    ring.dataset.state = "down";
    $("stateLabel").textContent = L.down;
    $("go").textContent = L.go;
    $("go").disabled = !p;
    $("go").classList.remove("on");
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
    li.innerHTML = `<span class="dot"></span><span class="meta"><b></b><span></span></span><button type="button" class="kill" aria-label="remove">×</button>`;
    li.querySelector("b").textContent = n.name;
    li.querySelector("span span").textContent = n.domain;
    li.addEventListener("click", (ev) => {
      if (ev.target.closest(".kill")) return;
      selected = n.id;
      paint();
    });
    li.querySelector(".kill").addEventListener("click", async (ev) => {
      ev.stopPropagation();
      profiles = await window.aether.removeProfile(n.id);
      if (selected === n.id) selected = profiles[0] ? profiles[0].id : null;
      paint();
    });
    ul.appendChild(li);
  });
}

function runSteps() {
  const box = $("steps");
  box.hidden = false;
  box.innerHTML = "";
  const labels = copy[locale].steps;
  labels.forEach((s) => {
    const li = document.createElement("li");
    li.textContent = s;
    box.appendChild(li);
  });
  let i = 0;
  const tick = () => {
    if (i < box.children.length) {
      box.children[i].dataset.on = "1";
      i += 1;
      stepTimer = setTimeout(tick, 280);
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
  paint();
}

$("lang").addEventListener("click", async () => {
  locale = locale === "tr" ? "en" : "tr";
  await window.aether.setLocale(locale);
  paint();
});

$("add").addEventListener("click", async () => {
  const text = $("paste").value;
  $("err").hidden = true;
  try {
    profiles = await window.aether.addProfile(text);
    $("paste").value = "";
    selected = profiles[profiles.length - 1].id;
    paint();
  } catch (e) {
    $("err").hidden = false;
    $("err").textContent = e.message || String(e);
  }
});

$("go").addEventListener("click", async () => {
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
});

window.aether.onStatus((s) => {
  running = Boolean(s.running);
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

refresh();
