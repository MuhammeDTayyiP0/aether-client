#!/bin/sh
set -eu
HTML=/usr/share/nginx/html
NAME="${AETHER_NAME:-Aether}"
SERVER_DOMAIN="${AETHER_SERVER:-vpn.geldesat.com}"

python3 - "$HTML" "$NAME" "$SERVER_DOMAIN" "${AETHER_VLESS:-}" "${AETHER_VLESS_UPG:-}" "${AETHER_VLESS_GRPC:-}" "${AETHER_VLESS_WS:-}" <<'PY'
import json, sys, pathlib, urllib.request

html_dir = pathlib.Path(sys.argv[1])
name = sys.argv[2]
server_domain = sys.argv[3]
vless_single = sys.argv[4]
vless_upg = sys.argv[5]
vless_grpc = sys.argv[6]
vless_ws = sys.argv[7]

target = html_dir / "list.json"
fetched = False

# Otomatik canlı sunucu API sorgusu (vpn.geldesat.com)
for url in [f"https://{server_domain}/list.json", f"https://{server_domain}/sub/admin?format=json"]:
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "Aether-vlist-Sync/1.0"})
        with urllib.request.urlopen(req, timeout=4) as resp:
            if resp.status == 200:
                data = json.loads(resp.read().decode("utf-8"))
                if "nodes" in data and data["nodes"]:
                    target.write_text(json.dumps(data, ensure_ascii=False, indent=2))
                    print(f"vlist: Synced {len(data['nodes'])} dynamic nodes from {url}")
                    fetched = True
                    break
    except Exception as e:
        print(f"vlist: Note - could not pre-fetch from {url}: {e}")

if not fetched:
    nodes = []
    if vless_upg:
        nodes.append({"name": f"{name} (HTTPUpgrade - MEB & CDN En Hızlı)", "vless": vless_upg})
    if vless_ws:
        nodes.append({"name": f"{name} (WebSocket - Akıllı Tahta & Mobil)", "vless": vless_ws})
    if vless_grpc:
        nodes.append({"name": f"{name} (gRPC - Düşük Gecikme)", "vless": vless_grpc})
    if not nodes and vless_single:
        nodes.append({"name": name, "vless": vless_single})
    if nodes:
        target.write_text(json.dumps({"nodes": nodes}, ensure_ascii=False, indent=2))
        print(f"vlist: list.json written with {len(nodes)} static node(s).")
PY

exec nginx -g "daemon off;"
