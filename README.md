# Aether Client

Electron masaüstü istemcisi (Windows / Linux, Pardus dahil). Çekirdek: sing-box 1.14 (`resources/bin`, CI indirir).

`main`'e push → Release: Windows zip, Linux AppImage / .deb / .tar.gz

## Kullanım

1. [Releases](https://github.com/MuhammeDTayyiP0/aether-client/releases) paketini indirin.
2. Açın → **Abonelik kodunuzu** (panelde kullanıcının "Abonelik" linki veya sadece kodu) girin → **Ekle**.
3. Listeden hat seçip **Bağlan**. Proxy modu sistem proxy'sini `127.0.0.1:17890` yapar; TUN modu tüm trafiği
   tüneller (Windows'ta yönetici, Linux'ta root veya `setcap` ister).

Artık istemcide gömülü anahtar yok; her kullanıcı kendi aboneliğini kullanır. Ana alan adına ulaşılamazsa abonelik
`vlist.geldesat.com` aynasından denenir (`vlist/`).

## Okul ağı (MEB FATİH)

Ağ HTTPS trafiğini kendi sertifikasıyla yeniden imzalıyorsa istemci bunu bağlanmadan önce algılar:

- Bağlantı yine kurulur (sertifika doğrulaması yalnızca bu durumda atlanır), arayüzde **"Ağ denetimi var"** uyarısı çıkar.
  Ağ yöneticisi VLESS/Trojan içeriğini görebilir; **VMess** hatları içeriği ayrıca şifreler.
- Uyarıdaki **okul sertifika parmak izi** panele (Telefon & Okul Ağı) girilirse telefonlardaki v2rayNG de bu ağda çalışır.

Normal ağlarda sertifika tam doğrulanır.

## Geliştirme

```bash
npm ci
npm test
npm start
```

`npm start` için çekirdeği `resources/bin/win/aether-core.exe` (Linux: `resources/bin/linux/aether-core`) olarak koyun.
sing-box sürümünü yükseltirken `.github/workflows/release.yml` içindeki `SING_BOX_VERSION` değerini değiştirin;
CI üretilen config'leri `sing-box check` ile doğrular.
