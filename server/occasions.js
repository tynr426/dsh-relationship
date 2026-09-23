// 场合键归一与展示标签：json（store.js）与 API 派生层（routes.js）共用。
// 场合是开放标签（AI 可自由写），这里只把已知词归一——英文枚举与中文节日名视为同一场合，
// 让去重（store.giftOccasions）和证据匹配（/api/attention 同场合历史）跨语言命中。
export const OCCASION_CN = {
  birthday: '生日', spring_festival: '春节', mid_autumn: '中秋', dragon_boat: '端午',
  new_year: '元旦', national_day: '国庆', christmas: '圣诞', valentine: '情人节',
  teacher_day: '教师节', mother_day: '母亲节', father_day: '父亲节', women_day: '妇女节',
  thank_you: '答谢', visit: '拜访', custom: '自定义',
};

const KEY_ALIAS = {
  '春节': 'spring_festival', '过年': 'spring_festival',
  '中秋': 'mid_autumn', '月饼节': 'mid_autumn',
  '端午': 'dragon_boat', '龙舟节': 'dragon_boat',
  '生日': 'birthday',
  '元旦': 'new_year', '国庆': 'national_day',
  '圣诞': 'christmas', '情人节': 'valentine',
  '教师节': 'teacher_day', '母亲节': 'mother_day', '父亲节': 'father_day',
  '妇女节': 'women_day', '三八节': 'women_day',
  '答谢': 'thank_you', '拜访': 'visit',
};

/** 场合归一键：小写、空白转下划线、中文节日名映射英文枚举——中秋/中秋节/mid_autumn 同键。
 *  先查全串（「教师节」整体是别名；去「节」会把「春节」错断成「春」），再去「节」兜底（「中秋节」→中秋）。 */
export function occasionKey(v) {
  const s = String(v ?? '').trim().toLowerCase().replace(/\s+/g, '_');
  if (!s) return '';
  if (Object.hasOwn(KEY_ALIAS, s)) return KEY_ALIAS[s];
  if (s.endsWith('节') && Object.hasOwn(KEY_ALIAS, s.slice(0, -1))) return KEY_ALIAS[s.slice(0, -1)];
  return s;
}

/** 展示标签：已知枚举给中文，未知原样返回。 */
export function occasionLabel(v) {
  const s = String(v ?? '').trim();
  const key = occasionKey(s);
  return Object.hasOwn(OCCASION_CN, key) ? OCCASION_CN[key] : s;
}

// ---------- 节日锚点表（JSON 版 store.js 与 rust 桥 store-rust.js 共用一份，防双实现漂移） ----------
// 农历节日公历对照（预置表，2028 起需扩展；每年校对一次）
const LUNAR_DATES = {
  2026: { spring_festival: '02-17', dragon_boat: '06-19', mid_autumn: '09-25' },
  2027: { spring_festival: '02-06', dragon_boat: '06-09', mid_autumn: '09-15' },
};
// 第 n 个星期日（n 从 1 起）：母亲节 = 5 月第 2 个周日，父亲节 = 6 月第 3 个周日
function nthSunday(year, month, n) {
  const d = new Date(year, month - 1, 1);
  d.setDate(1 + ((7 - d.getDay()) % 7) + (n - 1) * 7);
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
const byKey = (re) => (c) => (c.tags || []).some((t) => re.test(t)) || re.test(c.relation || '') || re.test(c.name || '');
// role 节日仅匹配相关联系人，不进入全员时间轴。
export const FIXED_HOLIDAYS = (() => {
  const mk = (occasion, label, md, match, role = false) => ({ occasion, label, md, match, role });
  return [
    mk('spring_festival', '春节', (y) => LUNAR_DATES[y]?.spring_festival, () => true),
    mk('mid_autumn', '中秋', (y) => LUNAR_DATES[y]?.mid_autumn, () => true),
    mk('dragon_boat', '端午', (y) => LUNAR_DATES[y]?.dragon_boat, () => true),
    mk('new_year', '元旦', '01-01', () => true),
    mk('national_day', '国庆', '10-01', () => true),
    mk('christmas', '圣诞节', '12-25', () => true),
    mk('valentine', '情人节', '02-14', () => true),
    mk('teacher_day', '教师节', '09-10', byKey(/老师|教师/), true),
    mk('mother_day', '母亲节', (y) => nthSunday(y, 5, 2), byKey(/妈|母亲|mom/i), true),
    mk('father_day', '父亲节', (y) => nthSunday(y, 6, 3), byKey(/爸|父亲|dad/i), true),
  ];
})();

export function deriveOccasions(contacts, plans, days = 30) {
  const windowDays = Number(days);
  if (!Number.isFinite(windowDays) || windowDays < 0) return [];
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const end = new Date(today);
  end.setDate(end.getDate() + windowDays);
  const dateString = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const dayDiff = (d) => Math.round((d - today) / 86_400_000);
  const contactsById = new Map(contacts.map((c) => [c.id, c]));
  const items = [];
  const seen = new Set();
  const push = (item, at) => {
    const inDays = dayDiff(at);
    if (!Number.isFinite(inDays) || inDays < 0 || inDays > windowDays) return;
    const date = dateString(at);
    const key = JSON.stringify([item.contactId, occasionKey(item.occasion), date]);
    if (seen.has(key)) return;
    seen.add(key);
    items.push({ ...item, date, inDays });
  };
  // 真实生日与节日先入集合，避免同键计划替换时间锚点。
  for (const c of contacts) {
    const birthday = /^(?:(?:每年|\d{4})-)?(\d{2})-(\d{2})$/.exec(String(c.birthday || ''));
    if (birthday) {
      const month = Number(birthday[1]);
      const day = Number(birthday[2]);
      if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
        for (const year of [today.getFullYear(), today.getFullYear() + 1]) {
          const at = new Date(year, month - 1, day);
          if (at < today) continue;
          push({ contactId: c.id, name: c.name, occasion: 'birthday', label: occasionLabel('birthday'), source: 'birthday' }, at);
          break;
        }
      }
    }
    for (const h of FIXED_HOLIDAYS) {
      if (!h.match(c)) continue;
      for (let year = today.getFullYear(); year <= end.getFullYear(); year++) {
        const md = typeof h.md === 'function' ? h.md(year) : h.md;
        if (!md) continue;
        const [month, day] = md.split('-').map(Number);
        push({ contactId: c.id, name: c.name, occasion: h.occasion, label: h.label, source: 'holiday' }, new Date(year, month - 1, day));
      }
    }
  }
  for (const p of plans) {
    const c = contactsById.get(p.contactId);
    if (!c || ['sent', 'done'].includes(p.status) || !/^\d{4}-\d{2}-\d{2}$/.test(p.occasionDate || '')) continue;
    const [year, month, day] = p.occasionDate.split('-').map(Number);
    const at = new Date(year, month - 1, day);
    if (dateString(at) !== p.occasionDate) continue;
    push({ contactId: c.id, name: c.name, occasion: occasionKey(p.occasion) || 'custom', label: occasionLabel(p.occasion) || '自定义', source: 'plan', planId: p.id, idea: p.idea, status: p.status }, at);
  }
  return items.sort((a, b) => a.inDays - b.inDays);
}

// 最近的节日（纯时间轴，不带联系人维度）：首页副标背景音 + 机会提示行用。
// 只含全员节日——角色节日对没有对应联系人的用户是噪音，且有人匹配时自然有 per-contact 行。
export function upcomingHolidays(days = 14) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const out = [];
  for (const h of FIXED_HOLIDAYS) {
    if (h.role) continue;
    for (const year of [today.getFullYear(), today.getFullYear() + 1]) {
      const md = typeof h.md === 'function' ? h.md(year) : h.md;
      if (!md) continue;
      const diff = Math.round((new Date(year, Number(md.slice(0, 2)) - 1, Number(md.slice(3, 5))) - today) / 86_400_000);
      if (diff >= 0 && diff <= days) { out.push({ occasion: h.occasion, label: h.label, date: `${year}-${md}`, inDays: diff }); break; }
    }
  }
  return out.sort((a, b) => a.inDays - b.inDays);
}
