Coolify: vlist.geldesat.com
=========================================
Bu servis, Aether masaüstü ve mobil istemcilerinin açılışta sunucuları
otomatik olarak çekmesini sağlayan hafif Nginx dağıtım servisidir.

1. Kurulum (Coolify):
   - Kaynak: GitHub MuhammeDTayyiP0/aether-client
   - Base Directory: /vlist
   - Build Pack: Dockerfile
   - Port: 80
   - Domains: https://vlist.geldesat.com

2. Ortam Değişkenleri (Environment Variables):
   AETHER_NAME=Aether
   AETHER_VLESS_UPG=vless://...paneldeki HTTPUpgrade satırı...
   AETHER_VLESS_GRPC=vless://...paneldeki gRPC satırı...
   AETHER_VLESS_WS=vless://...paneldeki WebSocket satırı...

3. Çalışma Mantığı:
   İstemciler açıldığında ilk iş https://vlist.geldesat.com/list.json adresini sorgular.
   Bu servis yukarıdaki değişkenleri bir JSON dizisi ("nodes") olarak istemciye sunar.
   Ortam değişkeni verilmezse vlist/list.json dosyasındaki varsayılan düğümler sunulur.

4. Cloudflare DNS:
   - CNAME vlist → Coolify sunucu IP veya hostname
   - Proxy: Turuncu Bulut (MEB erişimi için)
   - SSL/TLS: Full (Strict)
