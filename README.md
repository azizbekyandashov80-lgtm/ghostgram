# GhostGram — Telegram uslubidagi To'liq Veb-Messenjer

**GhostGram** — FastAPI, WebSocket, SQLite va IndexedDB asosida qurilgan to'liq ishlaydigan veb-messenjer. Unda Nicegram / AyuGram uslubidagi maxsus funksiyalar o'rnatilgan.

## Asosiy imkoniyatlar

1. **Ghost rejimi (Nicegram / AyuGram uslubi):**
   - O'qilganlikni yashirish (`✓✓` yubormasdan xabarlarni o'qish).
   - Onlayn holatni yashirish (boshqalarga ko'rinmasdan chatda ishlash).
   - Yozayotganini yashirish (Ghost faol bo'lganda yozish jarayonini yubormaslik).
2. **Anti-Delete va Lokal Xotira (IndexedDB Vault):**
   - Qabul qilingan barcha xabarlar va fayllar (rasm, video, audio, hujjatlar) foydalanuvchi qurilmasi xotirasida (IndexedDB) avtomatik keshlanadi.
   - Qarshi tomon xabar yoki faylni serverdan "Hamma uchun o'chirish" qilganda ham, u chatda **"O'chirilgan • Lokal xotirada saqlangan"** belgisi bilan qoladi va faylni qurilmaga yuklab olish mumkin bo'ladi.
   - Alohida **Lokal Xotira (🗄️)** oynasida o'chirilgan barcha xabar va fayllarni ko'rish va yuklab olish mumkin.
3. **Jonli Yozish Ko'rinishi (Live Typing Stream):**
   - Narigi foydalanuvchi xabar yozayotgan paytda (hali "Yuborish" tugmasini bosmasdan turib!) yozilayotgan va o'chirilayotgan matn WebSocket orqali real vaqtda qabul qiluvchining ekranida jonli ko'rinadi.
4. **To'liq messenjer funksiyalari:**
   - Ro'yxatdan o'tish va kirish (`username` + parol).
   - Shaxsiy chatlar, guruhlar yaratish va `@username` orqali qidirish.
   - Fayl/rasm yuborish (25 MB gacha), javob berish (Reply), tahrirlash, o'chirish, chat ichida qidiruv, Dark/Light tema va PWA (mobil ekranga qo'shish).

## Lokal ishga tushirish

```bash
pip install -r requirements.txt
uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload
```

Brauzerda oching: `http://localhost:8000`

> **Sinab ko'rish uchun:** Ikki xil brauzer (yoki oddiy + Incognito oyna) ochib, ikkita akkauntdan ro'yxatdan o'ting (`@user1` va `@user2`), bir-biringizni qidirib chat oching va:
> 1. Bir oynada matn yozing (yubormasdan) — ikkinchi oynada harfma-harf jonli chiqadi.
> 2. Rasm yoki fayl yuboring, keyin o'chirib tashlang — ikkinchi oynada u lokal xotiradan saqlanib qoladi.
> 3. Yuqoridagi **👻 Ghost** tugmasini yoqib ko'ring.

## Railway'ga joylash (Deploy)

Loyiha ichida `Procfile` va `railway.json` tayyor:
1. Loyihani GitHub repozitoriyga yuklang.
2. Railway.app → **New Project → Deploy from GitHub repo** ni tanlang.
3. Environment Variable sifatida `GHOSTGRAM_SECRET_KEY` (istalgan uzun maxfiy kalit) qo'shing.
4. Railway avtomatik ravishda `uvicorn app.main:app --host 0.0.0.0 --port $PORT` orqali ishga tushiradi.
