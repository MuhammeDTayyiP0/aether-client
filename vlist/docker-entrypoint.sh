#!/bin/sh
set -eu
HTML=/usr/share/nginx/html

if [ -n "${AETHER_VLESS:-}" ]; then
  NAME="${AETHER_NAME:-Aether}"
  # Escape for JSON string
  VLESS=$(printf '%s' "$AETHER_VLESS" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read())[1:-1])' 2>/dev/null || printf '%s' "$AETHER_VLESS")
  NESC=$(printf '%s' "$NAME" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read())[1:-1])' 2>/dev/null || printf '%s' "$NAME")
  printf '{"nodes":[{"name":"%s","vless":"%s"}]}\n' "$NESC" "$VLESS" > "$HTML/list.json"
  echo "list.json written from AETHER_VLESS"
fi

exec nginx -g "daemon off;"
