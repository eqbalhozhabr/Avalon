# آوالون آنلاین

بازی «مقاومت: آوالون» برای ۵ تا ۱۰ نفر، روی Cloudflare (Pages + Durable Objects)، با میز سه‌بعدیِ پیکسل‌آرت که هر بازیکن آن را از زاویه‌ی صندلی خودش می‌بیند.

## چرا بازیکن‌ها وسط بازی از دست نمی‌روند؟

مشکل بازی‌های مشابه این است که وضعیت بازی به اتصال هر گوشی وابسته است. اینجا برعکس است:

| مشکل | راه‌حل |
|---|---|
| صفحه‌ی گوشی خاموش می‌شود و اتصال قطع می‌شود | از Screen Wake Lock استفاده می‌کنیم تا صفحه اصلاً خاموش نشود |
| بازیکن برمی‌گردد و باید دوباره وارد شود | هویت (`pid`+`token`) در `localStorage` است؛ با باز شدن صفحه خودکار به همان صندلی و همان نقش برمی‌گردد. حتی اگر سیستم‌عامل تب را کشته باشد |
| بعد از برگشت، وضعیت بازی از دست رفته | سرور هر بار یک snapshot کامل می‌فرستد؛ نیازی به replay نیست |
| بازی منتظر یک نفر می‌ماند | بازیکن آفلاین بعد از چند ثانیه (قابل تنظیم) حرکت پیش‌فرض می‌گیرد (رأی «قبول»، کارت «موفقیت»، تیم پیش‌فرض)؛ صفحه‌های نتیجه منتظر آفلاین‌ها نمی‌مانند؛ میزبان هم می‌تواند به‌جای او رأی بدهد؛ اگر آساسین آفلاین شد، یکی از اشرار می‌تواند ترور را انجام دهد |
| سوکت نیمه‌مرده (بعد از خواب گوشی) | heartbeat + watchdog؛ و روی `visibilitychange` / `online` / `pageshow` فوراً اتصال بازسازی می‌شود |
| اعلام آفلاین‌بودن | لحظه‌ای که صفحه hidden می‌شود به سرور خبر می‌دهیم؛ روی میز کاراکتر آن بازیکن «می‌خوابد» (Zzz) |

سرور (Durable Object) تنها مرجع حقیقت است: نقش‌ها، رأی‌های مخفی و کارت‌های ماموریت هرگز به کلاینت‌ها نمی‌رسند مگر اینکه قوانین آشکارشان کنند (`shared/view.js`).

## ساختار

```
proxy/             Worker پروکسی برای luckylion.games/avalon
public/            کلاینت استاتیک (Pages)  — index.html، css، js/table3d.js (رندر میز)، js/app.js، js/net.js
functions/         Pages Functions: فقط /api/rooms و /ws/:code را به Durable Object می‌فرستند
worker/            Worker جدا که کلاس GameRoom (Durable Object) در آن است
shared/game.js     موتور قوانین (خالص، بدون I/O) — قابل تست
shared/view.js     آنچه هر بازیکن مجاز است ببیند
test/              تست‌های واحد قوانین (npm test)
scripts/           تست end-to-end روی WebSocketِ واقعی
```

## اجرای محلی

```bash
npm install
npm test                      # قوانین بازی
npm run dev:worker            # ترمینال ۱: Durable Object روی :8788
npm run dev:pages             # ترمینال ۲: سایت روی http://localhost:8787
node scripts/e2e-worker.mjs http://127.0.0.1:8787   # بازی ۵ نفره + قطع/وصل + autoplay
```

## استقرار روی Cloudflare (پلن رایگان کافی است)

Pages خودش نمی‌تواند Durable Object تعریف کند، پس دو بخش داریم:

1. **Worker (اتاق‌ها):**
   ```bash
   npx wrangler login
   npm run deploy:worker      # Worker با نام avalon-rooms (کلاس GameRoom، SQLite-backed)
   ```
2. **Pages (سایت):** پروژه را به ریپو وصل کن یا `npm run deploy:pages` بزن.
   - Build command: خالی — Output directory: `public`
   - **Binding:** `wrangler.toml` ریشه، `GAME_ROOM` را به Worker بالا وصل می‌کند. اگر Pages آن را نخواند: Dashboard → پروژه‌ی Pages → Settings → Functions → *Durable Object bindings* → Variable name `GAME_ROOM`، Class `GameRoom`، Worker `avalon-rooms` (برای Production و Preview). بعد دوباره Deploy کن.
3. **حالت جایگزین (بدون binding):** آدرس Worker را در `public/config.js` به‌صورت `apiBase: 'https://avalon-rooms.<subdomain>.workers.dev'` بگذار؛ کلاینت مستقیم به Worker وصل می‌شود.
4. **مسیر `luckylion.games/avalon`:** Worker کوچک `proxy/` درخواست‌های `luckylion.games/avalon*` را به Pages می‌رساند (مسیر `/avalon` را برمی‌دارد، WebSocket را عبور می‌دهد، و هدر `noindex` را هم می‌گذارد). کلاینت همه‌ی آدرس‌ها را نسبت به خود صفحه می‌سازد، پس هم در ریشه و هم زیر `/avalon/` کار می‌کند.
   - در `proxy/wrangler.toml` مقدار `ORIGIN` را برابر آدرس `*.pages.dev` پروژه‌ی Pages بگذار.
   - `npm run deploy:proxy`
   - شرط: دامنه‌ی `luckylion.games` باید zone همان اکانت کلودفلر باشد.

## noindex
متا تگ `robots` در `public/index.html`، هدر `X-Robots-Tag` در `public/_headers` (Pages) و در `proxy/index.js` همگی `noindex, nofollow` هستند. عمداً `robots.txt` با Disallow نگذاشتیم، چون خزنده‌ها اگر اجازه‌ی دیدن صفحه را نداشته باشند، noindex را هم نمی‌بینند. وقتی خواستی عمومی شود، این سه مورد را بردار.

> یادداشت: سقف روزانه‌ی پلن رایگان Durable Objects را در داشبورد کلاودفلر ببین؛ بازی ۵–۱۰ نفره در حد چند هزار پیام است و اتاق‌های بیکار hibernate می‌شوند. اتاق‌های رها شده بعد از ۲۴ ساعت پاک می‌شوند.

## قوانین پیاده‌شده

۵ تا ۱۰ بازیکن؛ مرلین، آساسین، خدمتگزار؛ اختیاری: پرسیوال، مورگانا، موردرد، ابرون، بانوی دریاچه. اندازه‌ی ماموریت‌ها طبق جدول رسمی؛ ماموریت ۴ با ۷+ نفر دو کارت شکست می‌خواهد؛ رأی مساوی = رد؛ ۵ رد پشت‌سرهم = برد اشرار؛ ترور مرلین در پایان.

## هنوز انجام نشده / ایده‌ها

- اعلان Push برای «نوبت توست» (الان لرزش + 🔔 در عنوان تب).
- فالبک NoSleep برای iOS قدیمی‌تر از ۱۶.۴ (Wake Lock ندارند).
- تماشاچی، چت صوتی/متنی، صدا، ترجمه‌ی انگلیسی (متن‌ها در `public/js/strings.js` جمع شده‌اند).
