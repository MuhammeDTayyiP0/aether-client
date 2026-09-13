# Aether Client

`main`'e her push **otomatik Release** basar:

| Dosya | Kullan |
| --- | --- |
| `aether-windows-amd64.zip` | Windows |
| `aether-linux-amd64.tar.gz` | Eski Pardus / Debian 10+ (tercih) |
| `aether_1.0.N_amd64.deb` | Debian / Ubuntu / Pardus |
| `Aether-x86_64.AppImage` | AppImage (FUSE yoksa `--appimage-extract-and-run`) |

Sunucu: [aether-server](https://github.com/MuhammeDTayyiP0/aether-server)

## Nasıl

1. Bu repoya push (veya Actions → Release → Run workflow)
2. [Releases](https://github.com/MuhammeDTayyiP0/aether-client/releases) sayfasından indir
3. Aether panel → Atölye → `sing-box.json` kaydet:
   - Linux: `~/.config/aether/config.json`
   - Windows: `%APPDATA%\Aether\config.json`
4. Çalıştır: `aether.cmd` / `./bin/aether` / `aether`

`config.json` git'e **girmez**.
