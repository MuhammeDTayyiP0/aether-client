#!/bin/sh
set -eu
HTML=/usr/share/nginx/html

NAME="${AETHER_NAME:-Aether}"

python3 - "$HTML" "$NAME" "${AETHER_VLESS:-}" "${AETHER_VLESS_UPG:-}" "${AETHER_VLESS_GRPC:-}" "${AETHER_VLESS_WS:-}" <<'PY'
import json, sys, pathlib

html_dir = pathlib.Path(sys.argv[1])
name = sys.argv[2]
vless_single = sys.argv[3]
vless_upg = sys.argv[4]
vless_grpc = sys.argv[5]
vless_ws = sys.argv[6]

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
    target = html_dir / "list.json"
    target.write_text(json.dumps({"nodes": nodes}, ensure_ascii=False, indent=2))
    print(f"list.json written with {len(nodes)} node(s).")
PY

exec nginx -g "daemon off;"
