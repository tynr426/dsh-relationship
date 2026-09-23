// 一句话建计划：纯规则解析（零 AI、零网络、毫秒级、离线可用）。
// 「打算下周三约小李吃饭」→ 联系人 小李 / 日期 下周三 / 想法 约吃饭。
// 解析只做「帮你把话说进表格」，最后一眼与保存键仍在用户手里。
// 浏览器挂 window.PlanParse（index.html 在 app.js 前引入）；Node 侧 module.exports 供单测。
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.PlanParse = api;
})(globalThis, function () {
  'use strict';

  const pad = (n) => String(n).padStart(2, '0');
  const fmt = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const dayStart = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const plusDays = (d, n) => { const x = dayStart(d); x.setDate(x.getDate() + n); return x; };
  // 周一为一周之始：本周三 = 本周一 + 2
  const startOfWeek = (d) => { const x = dayStart(d); x.setDate(x.getDate() - (x.getDay() + 6) % 7); return x; };
  const WD = { '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '日': 7, '天': 7 };

  // 场合词 → 归一键，与 server/occasions.js KEY_ALIAS 对齐（长词在前，防「中秋节」被「中秋」截胡）
  const OCCASIONS = [
    ['教师节', 'teacher_day'], ['母亲节', 'mother_day'], ['父亲节', 'father_day'],
    ['情人节', 'valentine'], ['妇女节', 'women_day'], ['圣诞节', 'christmas'],
    ['中秋节', 'mid_autumn'], ['端午节', 'dragon_boat'], ['三八节', 'women_day'],
    ['中秋', 'mid_autumn'], ['端午', 'dragon_boat'], ['春节', 'spring_festival'],
    ['过年', 'spring_festival'], ['元旦', 'new_year'], ['国庆', 'national_day'],
    ['圣诞', 'christmas'], ['生日', 'birthday'], ['答谢', 'thank_you'], ['拜访', 'visit'],
  ];

  const validDate = (y, mo, d) => {
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    const at = new Date(y, mo - 1, d);
    return at.getMonth() === mo - 1 && at.getDate() === d ? at : null;
  };
  // 无年份的 M月D日 / MM-DD：今年已过则顺延明年（计划是向前的意图）
  const mdDate = (today, mo, d, text) => {
    let at = validDate(today.getFullYear(), mo, d);
    if (!at) return null;
    if (at < today) at = validDate(today.getFullYear() + 1, mo, d);
    return at ? { text, date: at } : null;
  };

  // 日期规则按序试匹配，命中即消费；「下周」这类模糊词故意不消费——宁可日期留空让用户补，不编造精度
  function matchDate(s, today) {
    let m;
    if ((m = /(\d{4})[-/年.](\d{1,2})[-/月.](\d{1,2})[日号]?/.exec(s))) {
      const at = validDate(Number(m[1]), Number(m[2]), Number(m[3]));
      if (at) return { text: m[0], date: at };
    }
    if ((m = /(\d{1,2})月(\d{1,2})[日号]/.exec(s))) { const r = mdDate(today, Number(m[1]), Number(m[2]), m[0]); if (r) return r; }
    if ((m = /(?:^|\D)(\d{1,2})[-/](\d{1,2})(?!\d)/.exec(s))) { const r = mdDate(today, Number(m[1]), Number(m[2]), m[0]); if (r) return r; }
    if (s.includes('大后天')) return { text: '大后天', date: plusDays(today, 3) };
    if (s.includes('后天')) return { text: '后天', date: plusDays(today, 2) };
    if (s.includes('明天')) return { text: '明天', date: plusDays(today, 1) };
    if ((m = /(\d{1,3})\s*天[后後]/.exec(s))) return { text: m[0], date: plusDays(today, Number(m[1])) };
    if ((m = /今天|今晚/.exec(s))) return { text: m[0], date: plusDays(today, 0) };
    const week = startOfWeek(today);
    if ((m = /下下?周([一二三四五六日天])/.exec(s))) {
      const base = m[0].startsWith('下下') ? 14 : 7;
      return { text: m[0], date: plusDays(week, base + WD[m[1]] - 1) };
    }
    if ((m = /[本这]周([一二三四五六日天])/.exec(s))) return { text: m[0], date: plusDays(week, WD[m[1]] - 1) };
    if ((m = /下周末/.exec(s))) return { text: m[0], date: plusDays(week, 12) };
    if ((m = /[这本]?周末/.exec(s))) {
      const sat = plusDays(week, 5);
      return { text: m[0], date: sat < today ? plusDays(sat, 7) : sat };
    }
    if ((m = /周([一二三四五六日天])/.exec(s))) {
      let d = plusDays(week, WD[m[1]] - 1);
      if (d < today) d = plusDays(d, 7);
      return { text: m[0], date: d };
    }
    return null;
  }

  // 联系人：最长名字优先的包含匹配；吃掉名字前紧邻的介词（「给王老师送贺卡」→「送贺卡」）
  function matchContact(s, contacts) {
    let best = null;
    for (const c of contacts) {
      const name = String(c.name || '').trim();
      if (!name) continue;
      const at = s.indexOf(name);
      if (at === -1) continue;
      if (!best || name.length > best.name.length) best = { c, name, at };
    }
    if (!best) return null;
    const start = /(给|为|跟|和|与|陪)$/.test(s.slice(Math.max(0, best.at - 1), best.at)) ? best.at - 1 : best.at;
    return { contact: best.c, text: s.slice(start, best.at + best.name.length) };
  }

  // 场合：整词命中才消费，后缀「前/之前/当天/前后」一并吃掉（「教师节前看望」→ occasion=teacher_day，残句「看望」）
  function matchOccasion(s) {
    for (const [word, key] of OCCASIONS) {
      const at = s.indexOf(word);
      if (at === -1) continue;
      const suffix = /^(之前|前后|当天|前)/.exec(s.slice(at + word.length));
      return { key, text: word + (suffix ? suffix[0] : '') };
    }
    return null;
  }

  // 残句里只剩纯连接动词时给个可读默认；「聚一下/见面/看望」这类有信息量的原样保留
  const BARE_INTENTS = ['', '联系', '联系一下', '问候', '问候一下', '问好', '打招呼', '过', '过一下', '约'];

  /**
   * @param {string} input 一句话，如「打算下周三约小李吃饭」
   * @param {{contacts?: Array<{id: string, name: string}>, today?: Date}} opts
   * @returns {{contactId: string, contactName: string, occasion: string, date: string, idea: string}}
   */
  function parse(input, opts = {}) {
    const raw = String(input ?? '').trim();
    const out = { contactId: '', contactName: '', occasion: '', date: '', idea: '' };
    if (!raw) return out;
    const contacts = Array.isArray(opts.contacts) ? opts.contacts : [];
    const today = dayStart(opts.today instanceof Date ? opts.today : new Date());

    let s = raw;
    const occ = matchOccasion(s);
    if (occ) { out.occasion = occ.key; s = s.replace(occ.text, ''); }
    const dt = matchDate(s, today);
    if (dt) { out.date = fmt(dt.date); s = s.replace(dt.text, ''); }
    const ct = matchContact(s, contacts);
    if (ct) { out.contactId = ct.contact.id; out.contactName = ct.contact.name; s = s.replace(ct.text, ''); }

    let idea = s.replace(/^[，。、！!：:\s]+/, '').replace(/[，。、！!：:\s]+$/, '');
    for (let i = 0; i < 2; i++) idea = idea.replace(/^(打算|计划|准备|想要|想|要)[:，,。!！\s]*/, '');
    idea = idea.replace(/\s+/g, ' ').trim();
    if (out.contactId && BARE_INTENTS.includes(idea)) idea = '联系一下';
    out.idea = idea || raw;
    return out;
  }

  return { parse };
});
