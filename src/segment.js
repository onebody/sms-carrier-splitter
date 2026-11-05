// 号段表：来源为工信部号段核发公告 + 《手机号码》《公众移动通信网网号》词条
// 140 号段各来源归属不一致，未确认前一律不猜，落「未知或其他」
const CarrierDB = (() => {
  const CM = '中国移动';
  const CU = '中国联通';
  const CT = '中国电信';
  const CB = '中国广电';
  const OTHER = '未知或其他';
  const BASE = [CM, CU, CT, CB];

  const P3 = {};
  const N3 = {};
  const P4 = {};
  const N4 = {};

  const assign = (carrier, prefixes, note) => {
    for (const p of prefixes) {
      if (p.length === 3) P3[p] = carrier;
      else P4[p] = carrier;
      const store = p.length === 3 ? N3 : N4;
      if (note) store[p] = note;
    }
  };

  assign(CM, ['134', '135', '136', '137', '138', '139', '150', '151', '152', '157', '158', '159', '172', '178', '182', '183', '184', '187', '188', '195', '197', '198']);
  assign(CU, ['130', '131', '132', '155', '156', '166', '175', '176', '185', '186', '196']);
  assign(CT, ['133', '153', '173', '177', '180', '181', '189', '190', '191', '193', '199']);
  assign(CB, ['192']);

  assign(CM, ['147'], '上网卡（数据）号段');
  assign(CM, ['148'], '物联网专用号段');
  assign(CM, ['144'], '物联网专用号段');
  assign(CU, ['145'], '上网卡（数据）号段');
  assign(CU, ['146'], '物联网专用号段');
  assign(CT, ['149'], '上网卡（数据）号段');
  assign(CT, ['141'], '物联网专用号段');

  assign(CM, ['165', '1703', '1705', '1706'], '虚拟运营商转售，落地网为移动');
  assign(CU, ['167', '171', '1704', '1707', '1708', '1709'], '虚拟运营商转售，落地网为联通');
  assign(CT, ['162', '1700', '1701', '1702'], '虚拟运营商转售，落地网为电信');

  assign(OTHER, ['1349'], '卫星通信号段');
  assign(OTHER, ['1740', '1741', '1742', '1743', '1744', '1745'], '卫星移动通信号段');
  assign(OTHER, ['1746', '1747', '1748', '1749'], '应急通信号段');

  function normalize(raw) {
    if (raw === null || raw === undefined) return { ok: false, digits: '', reason: '空号码' };
    let s = typeof raw === 'number' ? String(raw) : String(raw);
    s = s.trim();
    if (!s) return { ok: false, digits: '', reason: '空号码' };

    if (/[eE]/.test(s) && /^[+-]?\d+(\.\d+)?[eE]\+?\d+$/.test(s)) {
      const n = Number(s);
      if (Number.isFinite(n)) s = n.toFixed(0);
    }
    s = s.replace(/\.0+$/, '');
    s = s.replace(/[\s\u00a0\u3000]/g, '');
    if (/^[0-9.\-+（）()]+$/.test(s)) s = s.replace(/[^\d]/g, '');

    if (s.startsWith('0086')) s = s.slice(4);
    else if (s.startsWith('86') && s.length === 13) s = s.slice(2);
    while (s.length > 11 && s.startsWith('0')) s = s.slice(1);

    if (!/^\d+$/.test(s)) return { ok: false, digits: s, reason: '含非数字字符' };
    if (s.length !== 11) return { ok: false, digits: s, reason: `位数${s.length}，非11位` };
    if (s[0] !== '1') return { ok: false, digits: s, reason: '首位非1，非手机号码' };
    if (!'3456789'.includes(s[1])) return { ok: false, digits: s, reason: '非公众移动网号段' };
    return { ok: true, digits: s, reason: '' };
  }

  function classify(raw) {
    const n = normalize(raw);
    if (!n.ok) return { valid: false, carrier: OTHER, digits: '', segment: n.digits.slice(0, 4), note: n.reason, base: false };

    const p4 = n.digits.slice(0, 4);
    const p3 = n.digits.slice(0, 3);
    let carrier = P4[p4] || P3[p3] || null;
    let note = N4[p4] || N3[p3] || '';

    if (!carrier) return { valid: false, carrier: OTHER, digits: '', segment: p3, note: '未登记号段', base: false };
    if (carrier === OTHER) return { valid: false, carrier: OTHER, digits: '', segment: p4, note: note || '非普通移动号码', base: false };

    const virtual = note.includes('虚拟运营商');
    return { valid: true, carrier, digits: n.digits, segment: p4 in P4 ? p4 : p3, note, base: !virtual, virtual };
  }

  // 内嵌号码提取：前后不接数字，避免身份证/订单号里的 11 位片段被误命中
  const PHONE_RE = /(?<!\d)(?:\+?86|0086)?[\s-]?1[3-9]\d[-\s]?\d{4}[-\s]?\d{4}(?!\d)/g;

  function extract(text) {
    if (text === null || text === undefined) return [];
    const out = [];
    for (const m of String(text).matchAll(PHONE_RE)) {
      const n = normalize(m[0]);
      out.push(n.ok ? n.digits : m[0].replace(/[^\d]/g, ''));
    }
    return out;
  }

  return { CM, CU, CT, CB, OTHER, BASE, classify, normalize, extract, P3, P4, source: '工信部号段核发公告 + 《手机号码》词条', updated: '2026-11' };
})();

if (typeof globalThis !== 'undefined') globalThis.CarrierDB = CarrierDB;
if (typeof module !== 'undefined' && module.exports) module.exports = CarrierDB;
