#!/bin/sh
set -eu
HTML=/usr/share/nginx/html

NAME="${AETHER_NAME:-Aether}"

python3 - "$HTML" "$NAME" "${AETHER_VLESS:-}" "${AETHER_VLESS_GRPC:-}" "${AETHER_VLESS_WS:-}" <<'PY'
import json, sys, pathlib

html_dir = pathlib.Path(sys.argv[1])
name = sys.argv[2]
vless_single = sys.argv[3]
vless_grpc = sys.argv[4]
vless_ws = sys.argv[5]

nodes = []

if vless_grpc and vless_ws:
    nodes.append({"name": f"{name} (gRPC - En Hızlı)", "vless": vless_grpc})
    nodes.append({"name": f"{name} (WebSocket - Standart)", "vless": vless_ws})
elif vless_grpc:
    nodes.append({"name": f"{name} (gRPC - En Hızlı)", "vless": vless_grpc})
elif vless_ws:
    nodes.append({"name": f"{name} (WebSocket)", "vless": vless_ws})
elif vless_single:
    nodes.append({"name": name, "vless": vless_single})

if nodes:
    target = html_dir / "list.json"
    target.write_text(json.dumps({"nodes": nodes}, ensure_ascii=False, indent=2))
    print(f"list.json written with {len(nodes)} node(s).")
PY

exec nginx -g "daemon off;"
