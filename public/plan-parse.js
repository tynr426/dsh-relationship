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
  // 精确不中时退到字序信号：库里姓名常带前缀/分隔符（「星屿-iqc-周老师」），句中只说「周老师」——
  // 按最长公共片段 + 出现过的姓名分段打分；得分并列视为歧义，宁空不猜人。
  const SEP_RE = /[\s\-_·.、,，/|｜()（）[\]【】]+/g;

  function commonRun(nameC, sC) {
    let best = { len: 0, text: '' };
    let prev = new Array(sC.length + 1).fill(0);
    for (let i = 1; i <= nameC.length; i += 1) {
      const cur = new Array(sC.length + 1).fill(0);
      for (let j = 1; j <= sC.length; j += 1) {
        if (nameC[i - 1] !== sC[j - 1]) continue;
        cur[j] = prev[j - 1] + 1;
        if (cur[j] > best.len) best = { len: cur[j], text: nameC.slice(i - cur[j], i) };
      }
      prev = cur;
    }
    return best;
  }

  // 片段定位回原句（片段里的分隔符可能在原句中被压缩掉，用宽容正则兜底）
  function locateRun(s, text) {
    const at = s.indexOf(text);
    if (at !== -1) return { at, text };
    const pattern = text.split('').map((ch) => ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[\\s\\-_·.、,，/|｜()（）【】\\[\\]]*');
    const m = new RegExp(pattern).exec(s);
    return m ? { at: m.index, text: m[0] } : null;
  }

  function matchContact(s, contacts) {
    let best = null;
    for (const c of contacts) {
      const name = String(c.name || '').trim();
      if (!name) continue;
      const at = s.indexOf(name);
      if (at === -1) continue;
      if (!best || name.length > best.name.length) best = { c, name, at };
    }
    if (best) {
      const start = /(给|为|跟|和|与|陪)$/.test(s.slice(Math.max(0, best.at - 1), best.at)) ? best.at - 1 : best.at;
      return { contact: best.c, text: s.slice(start, best.at + best.name.length) };
    }
    const sC = String(s || '').toLowerCase().replace(SEP_RE, '');
    if (sC.length < 2) return null;
    let fuzzy = null;
    let tie = false;
    for (const c of contacts) {
      const name = String(c.name || '').trim();
      const nameC = name.toLowerCase().replace(SEP_RE, '');
      if (!nameC) continue;
      const run = commonRun(nameC, sC);
      if (run.len < 2) continue;
      const segs = name.split(SEP_RE).map((sg) => sg.toLowerCase());
      // 两字片段太弱（活动词常撞人名局部，如「散步」⊂「散步完成」）：仅当恰为姓名的完整分段才可信
      if (run.len === 2 && !segs.includes(run.text)) continue;
      let score = run.len;
      for (const seg of segs) {
        if (seg.length >= 2 && sC.includes(seg)) score += seg.length;
      }
      if (!fuzzy || score > fuzzy.score) { fuzzy = { c, run, score }; tie = false; }
      else if (score === fuzzy.score) tie = true;
    }
    if (!fuzzy || tie) return null;
    const loc = locateRun(s, fuzzy.run.text);
    if (!loc) return null;
    const start = /(给|为|跟|和|与|陪)$/.test(s.slice(Math.max(0, loc.at - 1), loc.at)) ? loc.at - 1 : loc.at;
    return { contact: fuzzy.c, text: s.slice(start, loc.at + loc.text.length) };
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

  // 「人来往」词：电话、见面、问候这类计划说的是一次接触，不是一件东西——
  // 客套话不当商品词，宁空不猜，交给弹窗的手填与热销榜引导。
  // 与「已送出礼物」确认弹窗同一套词汇（「普通见面、散步等安排请使用已完成」）。
  const NON_PRODUCT_RE = /联系|电话|问候|问好|打招呼|见面|约饭|约个饭|吃饭|散步|跑步|爬山|下棋|喝茶|聊天|聊聊|聚聚|聚一聚|拜访|探望|探病|视频|微信|过生日/;
  const STRIP_LEAD = /^(?:AI\s*)?(?:建议|帮我|准备|挑选|看看|想|打算|送|买|给|找|带|挑)(?:个|一下|一件|一款|些|点)?/;

  /** 从计划想法首句派生京东商品关键词：人来往类客套话返回 ''（走弹窗的手填/热销榜引导） */
  function giftKeyword(input) {
    const head = String(input ?? '').split(/[，,。；;！!？?\n：:]/)[0].trim();
    if (!head || NON_PRODUCT_RE.test(head)) return '';
    let s = head;
    for (let i = 0; i < 2; i++) s = s.replace(STRIP_LEAD, '').trim();
    return (s || head).slice(0, 80);
  }

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

  return { parse, giftKeyword };
});
