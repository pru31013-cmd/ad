# 🃏 Blackjack Mini App

Bot yok. Telegram Mini App + Express + WebSocket.

## Mimari

```
Telegram
  └── Mini App (index.html)
        │
        ├─ fetch POST /api/bet        ← oyun aksiyonları (REST)
        │    header: x-telegram-init-data   ← kim olduğunu kanıtlar
        │
        └─ WebSocket ws://server      ← anlık güncellemeler
             query: ?initData=...

server.js (Express + ws)
  ├── verifyInitData()    ← HMAC-SHA256 ile Telegram imzasını doğrular
  ├── REST endpoints      ← /api/tables, /api/bet, /api/hit, ...
  ├── WebSocket           ← pushTableState() her oyuncuya özel state gönderir
  └── Game Logic          ← tüm oyun sunucuda, client sadece UI

blackjack.db (SQLite)
  ├── users
  ├── tables
  ├── players
  ├── hands
  └── player_hands
```

## Neden Bot Yok?

Mini App WebSocket ile açık olduğu sürece anlık güncellemeler alır.
"Sıra sende" bildirimi WebSocket üzerinden gelir, DM gerekmez.
Bot sadece DM bildirimi için gerekir — bunu istemiyorsan bot kurmana gerek yok.

## Kurulum

```bash
npm install
cp .env.example .env
# .env dosyasına BOT_TOKEN yaz (sadece initData doğrulaması için)
npm start
```

## Mini App'i Telegram'a Bağlama

1. @BotFather → /newbot → token al
2. @BotFather → /newapp → URL olarak sunucu adresini ver (ngrok veya VPS)
3. Kullanıcılar bota yazarlar → /start → Mini App butonu açılır

Veya herhangi bir mesajda inline buton ekleyebilirsin:
```json
{
  "text": "🃏 Oyna",
  "web_app": { "url": "https://senin-sunucu.com" }
}
```

## Dev Modunda Test

`NODE_ENV=development` olduğunda tarayıcıdan açsan bile çalışır.
`x-dev-user-id` header'ı ile sahte kullanıcı simüle edilir.

```bash
# Birden fazla kullanıcı simüle etmek için farklı tarayıcı/profil aç
# ve farklı DEV_USER_ID değeri ile aç:
# index.html içinde const DEV_USER_ID = '12345'; satırını değiştir
```

## WebSocket Mesaj Tipleri

| Type | Yön | Açıklama |
|------|-----|----------|
| `CONNECTED` | Server→Client | Bağlantı kuruldu |
| `STATE_UPDATE` | Server→Client | Oyun durumu güncellendi (kişiselleştirilmiş) |
| `HAND_RESULT` | Server→Client | El bitti, kartlar açıldı |
| `NOTIFY` | Server→Client | Bildirim toast'u |
| `ASK_CONTINUE` | Server→Client | Devam/çıkış sorusu |
| `KICKED` | Server→Client | Chip bitti, atıldın |
| `GAME_ENDED` | Server→Client | Oyun bitti |

## Blöf Mekaniği

`STATE_UPDATE` içinde:
- Kendi kartların: `myCards` (tam değer)
- Rakiplerin: `cardCount` (sadece kaç kart)
- `myBusted`: sadece sana gönderilir, başkalarına gönderilmez
