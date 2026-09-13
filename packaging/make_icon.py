#!/usr/bin/env python3
import struct, sys, zlib

def chunk(tag, data):
    return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

w = h = 256
rows = []
cx = cy = 127.5
for y in range(h):
    row = bytearray([0])
    for x in range(w):
        d = ((x - cx) ** 2 + (y - cy) ** 2) ** 0.5
        if 88 <= d <= 104 or d < 36:
            row += bytes((212, 215, 222))
        else:
            row += bytes((12, 12, 13))
    rows.append(bytes(row))
sig = bytes([137, 80, 78, 71, 13, 10, 26, 10])
png = (
    sig
    + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
    + chunk(b"IDAT", zlib.compress(b"".join(rows), 9))
    + chunk(b"IEND", b"")
)
open(sys.argv[1], "wb").write(png)
