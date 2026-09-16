#!/usr/bin/env python3
import zipfile
from pathlib import Path
import sys
zpath = Path(sys.argv[1] if len(sys.argv) > 1 else "wintun.zip")
dest = Path(sys.argv[2] if len(sys.argv) > 2 else "resources/bin/win/wintun.dll")
with zipfile.ZipFile(zpath) as z:
    name = next((n for n in z.namelist() if n.replace("\\", "/").endswith("amd64/wintun.dll")), None)
    if not name:
        raise SystemExit("wintun.dll not found: " + ", ".join(z.namelist()[:30]))
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_bytes(z.read(name))
    print("wintun", name, dest.stat().st_size)
