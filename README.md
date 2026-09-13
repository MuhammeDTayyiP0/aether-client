# Aether Client (core)

Bu repo **istemci**. Cihazda çalışır (Windows / Linux / eski Pardus). Resmi sing-box statik ikilisini paketler. UUID ve alan adı **gömülmez**.

Sunucu için: [aether-server](https://github.com/MuhammeDTayyiP0/aether-server)

## Paket üret

GitHub → Actions → **Aether core packages** → Run workflow

Çıkanlar:

| Dosya | Nerede |
| --- | --- |
| `aether-core-windows-amd64.zip` | Windows |
| `aether-core-linux-amd64.tar.gz` | Eski Pardus / Debian 10+ (tercih et) |
| `aether-core_1.0.0_amd64.deb` | Debian/Ubuntu |

AppImage FUSE ister; kilitli tahtalarda **tarball** kullan.

## Cihazda config

Aether panel → Atölye → **sing-box.json** (TUN'suz, 1080) veya **sing-box-tun.json** (yönetici gerekir).

- Linux: `~/.config/aether/config.json`
- Windows: `%APPDATA%\Aether\config.json`

```bash
mkdir -p ~/.config/aether
# JSON'u kaydet
./bin/aether
```

TUN yoksa tarayıcı proxy: `127.0.0.1:1080`

`config.json` bu repoya **commit edilmez**.
