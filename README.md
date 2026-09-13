# Aether Client

Electron masaüstü uygulaması. Bağlan / Kes, düğüm ekle (`vless://` veya sing-box JSON), çekirdek olarak sing-box.

`main`'e push → GitHub **Release**:

- Windows `.zip`
- Linux `.AppImage`
- Linux `.deb`
- Linux `.tar.gz` (eski Pardus)

Sunucu: [aether-server](https://github.com/MuhammeDTayyiP0/aether-server)

## Kullanım

1. [Releases](https://github.com/MuhammeDTayyiP0/aether-client/releases) içinden paketini indir
2. Aç → `vless://` veya Aether panel Atölye JSON yapıştır → **Ekle**
3. **Bağlan**
4. Proxy: `127.0.0.1:1080` (tarayıcı SOCKS/HTTP)

Eski Pardus’ta AppImage FUSE istemezse:

```bash
./aether-*-linux-amd64.AppImage --appimage-extract-and-run
```

veya `.tar.gz` / `.deb`.

## Geliştirme

```bash
# linux çekirdek
mkdir -p resources/bin/linux
# sing-box ikilisini aether-core adıyla koy
npm install
npx electron .
```
