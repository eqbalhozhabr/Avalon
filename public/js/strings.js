// All user-facing text lives here so the game can be translated by editing one file.

export const ROLE = {
  merlin: {
    name: 'مرلین',
    team: 'good',
    desc: 'همه‌ی اشرار را می‌شناسی (به‌جز موردرد). مخفی بمان؛ اگر آساسین تو را پیدا کند، اشرار برنده می‌شوند.',
  },
  percival: {
    name: 'پرسیوال',
    team: 'good',
    desc: 'مرلین را می‌بینی، اما اگر مورگانا هم در بازی باشد نمی‌دانی کدام یک مرلین است. از مرلین محافظت کن.',
  },
  servant: {
    name: 'خدمتگزار آرتور',
    team: 'good',
    desc: 'تو چیزی نمی‌دانی. با تحلیل رأی‌ها و تیم‌ها، اشرار را پیدا کن و ماموریت‌ها را موفق کن.',
  },
  assassin: {
    name: 'آساسین',
    team: 'evil',
    desc: 'اشرار دیگر را می‌شناسی. اگر خوبان ۳ ماموریت ببرند، یک فرصت داری مرلین را حدس بزنی و بازی را برگردانی.',
  },
  morgana: {
    name: 'مورگانا',
    team: 'evil',
    desc: 'اشرار دیگر را می‌شناسی. خودت را جای مرلین جا بزن: پرسیوال تو و مرلین را مشابه می‌بیند.',
  },
  mordred: {
    name: 'موردرد',
    team: 'evil',
    desc: 'اشرار دیگر را می‌شناسی و مرلین تو را نمی‌بیند.',
  },
  oberon: {
    name: 'ابرون',
    team: 'evil',
    desc: 'شرور هستی اما اشرار دیگر را نمی‌شناسی و آن‌ها هم تو را نمی‌شناسند.',
  },
  minion: {
    name: 'خدمتکار موردرد',
    team: 'evil',
    desc: 'اشرار دیگر را می‌شناسی. ماموریت‌ها را خراب کن، بدون اینکه لو بروی.',
  },
};

export const TEAM = { good: 'خوبان', evil: 'اشرار' };

export const MARK = {
  evil: { text: 'شرور', cls: 'evil' },
  wizard: { text: 'مرلین یا مورگانا', cls: 'wizard' },
  merlin: { text: 'مرلین', cls: 'wizard' },
};

export const WIN_REASON = {
  five_rejects: 'پنج پیشنهاد تیم پشت‌سرهم رد شد',
  three_fails: 'سه ماموریت شکست خورد',
  merlin_killed: 'آساسین مرلین را شناخت',
  merlin_survived: 'آساسین مرلین را پیدا نکرد',
};

export const ERR = {
  not_allowed: 'این کار برای شما مجاز نیست',
  not_leader: 'فقط رهبر می‌تواند تیم انتخاب کند',
  team_full: 'تیم پر است',
  team_size: 'تعداد اعضای تیم درست نیست',
  good_must_succeed: 'خوبان فقط می‌توانند «موفقیت» بدهند',
  bad_target: 'این بازیکن قابل انتخاب نیست',
  not_assassin: 'فقط آساسین می‌تواند ترور کند',
  target_present: 'این بازیکن آنلاین است',
  no_proxy_assassin: 'ترور را نمی‌شود به‌جای دیگری انجام داد',
  player_count: 'برای شروع حداقل ۵ و حداکثر ۱۰ بازیکن لازم است',
  too_many_evil_roles: 'برای این تعداد بازیکن، نقش‌های شرور ویژه زیاد است',
  too_many_good_roles: 'برای این تعداد بازیکن، نقش‌های خوب ویژه زیاد است',
  stale: '',
};

export const FATAL = {
  no_room: ['این اتاق پیدا نشد', 'کد را بررسی کن یا یک اتاق جدید بساز.'],
  bad_token: ['هویت شما در این اتاق معتبر نیست', 'احتمالاً اتاق دوباره ساخته شده است.'],
  game_started: ['بازی شروع شده است', 'بعد از شروع بازی نمی‌شود وارد اتاق شد.'],
  room_full: ['اتاق پر است', 'حداکثر ۱۰ بازیکن.'],
  kicked: ['از اتاق اخراج شدی', ''],
  left: ['از اتاق خارج شدی', ''],
  replaced: ['بازی در تب یا دستگاه دیگری باز شد', 'اینجا قطع شد تا دو نسخه با هم تداخل نکنند.'],
};

const fa = (n) => String(n).replace(/\d/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[d]);
export { fa };

export function feedText(f, name) {
  switch (f.k) {
    case 'vote':
      return `تیم ${name(f.leader)} ${f.approved ? 'تأیید' : 'رد'} شد (${fa(f.yes)} به ${fa(f.no)})`;
    case 'quest':
      return `ماموریت ${fa(f.quest + 1)} ${f.success ? 'موفق شد' : 'شکست خورد'}` + (f.fails ? ` (${fa(f.fails)} کارت شکست)` : '');
    case 'auto': {
      const what = {
        propose: 'یک تیم پیش‌فرض ساخته شد',
        vote: 'رأی «قبول» خودکار ثبت شد',
        card: 'کارت «موفقیت» خودکار بازی شد',
        lady: 'بانوی دریاچه خودکار استفاده شد',
      }[f.what];
      return `${name(f.id)} آفلاین بود؛ ${what}`;
    }
    case 'lady':
      return `${name(f.by)} هویت ${name(f.target)} را دید`;
    case 'assassinate':
      return `${name(f.by)} ${name(f.target)} را ترور کرد${f.hit ? ' و مرلین بود!' : ' ولی مرلین نبود'}`;
    default:
      return '';
  }
}
