vlist.geldesat.com — abonelik aynasi
====================================

Bu servis artik ortak bir dugum listesi (list.json) yayinlamaz. Eski list.json herkesin
kullandigi tek bir anahtari dagitiyordu; kaldirildi.

Gorevi: https://vlist.geldesat.com/sub/<kod> isteklerini ana sunucuya
(AETHER_SERVER, varsayilan vpn.geldesat.com) iletmek. Aether istemcisi ana alan adina
ulasamazsa aboneligini buradan dener. Diger tum yollar kamufle sayfayi dondurur.

Coolify:
  - Kaynak: GitHub aether-client, Base Directory: /vlist, Build Pack: Dockerfile, Port: 80
  - Domain: https://vlist.geldesat.com
  - (istege bagli) Ortam degiskeni: AETHER_SERVER=vpn.geldesat.com

Cloudflare: turuncu bulut, SSL/TLS Full (Strict).
