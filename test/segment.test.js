const { test } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../src/segment.js');

// 期望值逐条对照工信部核发公告/《手机号码》词条口径手写，不从号段表反推
const CASES = [
  ['13800138000', '中国移动'], ['13900139000', '中国移动'], ['13700137000', '中国移动'],
  ['15000150000', '中国移动'], ['15900159000', '中国移动'], ['17800178000', '中国移动'],
  ['18200182000', '中国移动'], ['18800188000', '中国移动'], ['19800198000', '中国移动'],
  ['19700197000', '中国移动'], ['19500195000', '中国移动'], ['17200172000', '中国移动'],

  ['13000130000', '中国联通'], ['13200132000', '中国联通'], ['15500155000', '中国联通'],
  ['15600156000', '中国联通'], ['18600186000', '中国联通'], ['16600166000', '中国联通'],
  ['19600196000', '中国联通'], ['17600176000', '中国联通'],

  ['13300133000', '中国电信'], ['15300153000', '中国电信'], ['18000180000', '中国电信'],
  ['18900189000', '中国电信'], ['17700177000', '中国电信'], ['19900199000', '中国电信'],
  ['19100191000', '中国电信'], ['19300193000', '中国电信'], ['19000190000', '中国电信'],

  ['19200192000', '中国广电'], ['19212345678', '中国广电'],

  ['17000000000', '中国电信'], ['17050000000', '中国移动'], ['17040000000', '中国联通'],
  ['16200000000', '中国电信'], ['16500000000', '中国移动'], ['16700000000', '中国联通'],
  ['17100000000', '中国联通'],

  ['14700147000', '中国移动'], ['14500145000', '中国联通'], ['14900149000', '中国电信'],
  ['14600146000', '中国联通'], ['14800148000', '中国移动'],
];

test('四大运营商归属逐号段核对', () => {
  for (const [num, want] of CASES) {
    const got = db.classify(num);
    assert.equal(got.carrier, want, `${num} 应归 ${want}，实得 ${got.carrier}`);
    assert.equal(got.valid, true, `${num} 应判有效`);
  }
});

test('134 拆分：1340-1348 归移动，1349 归卫星', () => {
  for (const seg of ['1340', '1345', '1348']) assert.equal(db.classify(seg + '0000000').carrier, '中国移动', seg);
  const sat = db.classify('13490000000');
  assert.equal(sat.valid, false);
  assert.equal(sat.carrier, '未知或其他');
  assert.match(sat.note, /卫星/);
});

test('174 卫星/应急不进入四大分组', () => {
  for (const seg of ['1740', '1745', '1749']) {
    const r = db.classify(seg + '0000000');
    assert.equal(r.valid, false, seg);
    assert.equal(r.carrier, '未知或其他', seg);
  }
});

test('未登记号段不猜归属', () => {
  for (const seg of ['154', '160', '194', '140', '179']) {
    const num = seg + '0'.repeat(11 - seg.length);
    assert.equal(num.length, 11, seg);
    const r = db.classify(num);
    assert.equal(r.valid, false, num);
    assert.equal(r.carrier, '未知或其他', num);
    assert.match(r.note, /未登记/, num);
  }
});

test('规范化：+86 / 0086 / 86前缀 / 空格 / 连字符 / 前导0', () => {
  const want = '中国移动';
  for (const raw of ['+8613800138000', '008613800138000', '8613800138000', ' 138 0013 8000 ', '138-0013-8000', '013800138000', '13800138000.0']) {
    assert.equal(db.classify(raw).carrier, want, JSON.stringify(raw));
  }
});

test('数值单元格与科学计数法', () => {
  assert.equal(db.classify(13800138000).carrier, '中国移动');
  assert.equal(db.classify(1.3800138001e10).carrier, '中国移动');
  assert.equal(db.classify('1.3900139E+10').carrier, '中国移动');
});

test('非法号码逐条给原因', () => {
  const bad = [['1380013800', '位数'], ['138001380001', '位数'], ['23800138000', '首位'], ['', '空号码'], [null, '空号码'], [undefined, '空号码'], ['138abc1234', '非数字'], ['0755-1234567', '首位'], ['075512345678', '首位']];
  for (const [raw, hint] of bad) {
    const r = db.classify(raw);
    assert.equal(r.valid, false, JSON.stringify(raw));
    assert.match(r.note, new RegExp(hint), JSON.stringify(raw));
  }
});

test('虚商标注落地网但不改变分组', () => {
  const r = db.classify('17040000000');
  assert.equal(r.carrier, '中国联通');
  assert.equal(r.virtual, true);
  assert.equal(db.classify('13800138000').virtual, false);
  assert.equal(db.classify('13800138000').base, true);
});

test('制表符/全角空格/带汉字后缀', () => {
  assert.equal(db.classify('　138　0013　8000　').carrier, '中国移动');
  assert.equal(db.classify('13800138000\t').carrier, '中国移动');
  const tail = db.classify('13800138000转123');
  assert.equal(tail.valid, false);
  assert.match(tail.note, /非数字/);
});

// 提取：期望值手写。契约 = 返回「归一化后的 11 位数字」数组，左到右，非法号段照样返回（由 classify 判异常）
test('提取：中文文本里的多个号码', () => {
  assert.deepEqual(db.extract('张伟 13800138000，李娜 13912345678'), ['13800138000', '13912345678']);
});

test('提取：+86/0086 与 3-4-4 分组写法归一化为 11 位', () => {
  assert.deepEqual(db.extract('电话 +86 138-0013-8000 或 008613912345678'), ['13800138000', '13912345678']);
});

test('提取：号码后跟汉字也算（整格 classify 会判非数字）', () => {
  assert.deepEqual(db.extract('13800138000转123'), ['13800138000']);
});

test('提取：不吃长数字串，避免身份证/订单号误命中', () => {
  assert.deepEqual(db.extract('订单号 138001380001234'), []);
  assert.deepEqual(db.extract('身份证 110101199003078888'), []);
});

test('提取：座机与固话分机不算手机', () => {
  assert.deepEqual(db.extract('座机 0755-12345678，分机 8012'), []);
});

test('提取：未登记号段照样交出来给 classify 判', () => {
  assert.deepEqual(db.extract('联系 15400000000'), ['15400000000']);
  assert.equal(db.classify('15400000000').valid, false);
});

test('提取：同格重复号码不代劳去重', () => {
  assert.deepEqual(db.extract('13800138000 / 13800138000'), ['13800138000', '13800138000']);
});

test('提取：整格就是号码时等价于一条', () => {
  assert.deepEqual(db.extract(' 13800138000 '), ['13800138000']);
  assert.deepEqual(db.extract(''), []);
  assert.deepEqual(db.extract(null), []);
});
