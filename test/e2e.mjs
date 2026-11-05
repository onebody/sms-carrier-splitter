// CDP 驱动 headless Chrome：加载单文件页面 → 塞入真实 xlsx → 断言页面状态 → 导出产物字节
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const PAGE = path.join(ROOT, '号码运营商分类与拆表.html');
const SAMPLE = path.join(ROOT, 'fixtures', 'sample.xlsx');
const OUTDIR = path.join(ROOT, 'fixtures', 'out');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9345;
const DL = fs.mkdtempSync('/tmp/sms-dl-');

fs.rmSync(OUTDIR, { recursive: true, force: true });
fs.mkdirSync(OUTDIR, { recursive: true });

const fails = [];
const checks = [];
function check(name, ok, detail) {
  checks.push(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) fails.push(name);
}

async function waitForTarget(timeout = 30000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find((t) => t.type === 'page');
      if (page) return page;
    } catch (e) { /* chrome 还没起来 */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error('Chrome 调试端口未就绪');
}

const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`, '--no-first-run', '--no-default-browser-check',
  `--user-data-dir=${fs.mkdtempSync('/tmp/sms-chrome-')}`, '--allow-file-access-from-files', 'about:blank',
], { stdio: 'ignore' });

let ws, seq = 0;
const pending = new Map();
const pageErrors = [];

function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error(`${method} 超时`)); } }, 60000);
  });
}

async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(`${expression} → ${r.exceptionDetails.exception?.description || r.exceptionDetails.text}`);
  return r.result.value;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  const target = await waitForTarget();
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
    }
    if (m.method === 'Runtime.exceptionThrown') pageErrors.push(JSON.stringify(m.params.exceptionDetails).slice(0, 400));
    if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') pageErrors.push(m.params.entry.text.slice(0, 300));
  });
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await send('Runtime.enable');
  await send('Log.enable');
  await send('Page.enable');
  await send('Network.enable');

  await send('Page.navigate', { url: `file://${PAGE}` });
  await sleep(2500);

  check('页面加载且引擎就位', await evaluate(`!!window.XLSX && !!window.CarrierDB && !!window.__smsApp`),
    await evaluate(`XLSX.version + '/' + CarrierDB.updated`));

  // 1) 载入真实文件
  const fileHandle = await send('Runtime.evaluate', { expression: `document.getElementById('file')` });
  await send('DOM.setFileInputFiles', { files: [SAMPLE], objectId: fileHandle.result.objectId });
  await evaluate(`document.getElementById('file').dispatchEvent(new Event('change'))`);

  const end = Date.now() + 20000;
  while (Date.now() < end && !(await evaluate(`!!(__smsApp.state && __smsApp.state.stats)`))) await sleep(200);
  check('样本文件解析完成', await evaluate(`!!__smsApp.state.stats`));

  const stats = await evaluate(`JSON.parse(JSON.stringify(__smsApp.state.stats))`);
  const exp = JSON.parse(fs.readFileSync(path.join(ROOT, 'fixtures', 'expected.json'), 'utf8'));
  check('选中列=手机号列', stats && await evaluate(`__smsApp.state.col`) === 1, `col=${await evaluate('__smsApp.state.col')}`);
  check('数据行数（全空行已跳过）', stats.total === exp.total, `${stats.total} vs ${exp.total}`);
  check('有效号码数', stats.valid === exp.valid, `${stats.valid} vs ${exp.valid}`);
  check('重复识别', stats.dup === exp.dup, `${stats.dup} vs ${exp.dup}`);
  check('异常号码数', stats.invalid === exp.invalid, `${stats.invalid} vs ${exp.invalid}`);
  check('空号码数', stats.empty === exp.empty, `${stats.empty} vs ${exp.empty}`);
  for (const c of Object.keys(exp.by)) {
    check(`分组 ${c}`, stats.by[c].valid === exp.by[c].valid && stats.by[c].unique === exp.by[c].unique && stats.by[c].dup === exp.by[c].dup,
      `valid=${stats.by[c].valid}/${exp.by[c].valid} unique=${stats.by[c].unique}/${exp.by[c].unique} dup=${stats.by[c].dup}/${exp.by[c].dup}`);
  }
  check('虚商转售计数', stats.by['中国移动'].virtual === 1 && stats.by['中国联通'].virtual === 1,
    `移动${stats.by['中国移动'].virtual} 联通${stats.by['中国联通'].virtual}`);
  check('未登记号段被点名', Object.keys(stats.unknown).includes('154'), JSON.stringify(stats.unknown));

  // 1b) 新增开关的默认值：去重默认开（下单本就按去重计），提取默认关（不改默认行为）
  const toggles = await evaluate(`({dedupe:document.getElementById('dedupe').checked, extract:document.getElementById('extract').checked})`);
  check('去重默认开、提取默认关', toggles.dedupe === true && toggles.extract === false, JSON.stringify(toggles));

  // 2) 下单页金额
  await evaluate(`(()=>{const set=(el,v)=>{el.value=v;el.dispatchEvent(new Event('input'))};
    const rows=[...document.querySelectorAll('#orderWrap tr[data-carrier]')];
    const cm=rows.find(r=>r.dataset.carrier==='中国移动'); const cu=rows.find(r=>r.dataset.carrier==='中国联通');
    set(cm.querySelector('.price'),'0.05'); set(cu.querySelector('.price'),'0.045');})()`);
  const sum = await evaluate(`({qty:document.getElementById('sumQty').textContent, amt:document.getElementById('sumAmt').textContent})`);
  check('下单合计条数', sum.qty === (exp.by['中国移动'].unique + exp.by['中国联通'].unique + exp.by['中国电信'].unique + exp.by['中国广电'].unique).toLocaleString(), JSON.stringify(sum));
  check('下单合计金额 0.67', sum.amt === '0.67', JSON.stringify(sum));

  // 3) 导出四大模式的字节，交给 openpyxl 独立验数
  const b64four = await evaluate(`XLSX.write(__smsApp.buildSplitWorkbook(),{bookType:'xlsx',type:'base64'})`);
  fs.writeFileSync(path.join(OUTDIR, 'four.xlsx'), Buffer.from(b64four, 'base64'));
  await evaluate(`document.getElementById('modeThree').checked=true`);
  const b64three = await evaluate(`XLSX.write(__smsApp.buildSplitWorkbook(),{bookType:'xlsx',type:'base64'})`);
  fs.writeFileSync(path.join(OUTDIR, 'three.xlsx'), Buffer.from(b64three, 'base64'));
  check('两种模式都产出字节', b64four.length > 5000 && b64three.length > 5000, `${b64four.length}/${b64three.length}`);
  await evaluate(`(()=>{const r=document.getElementById('modeFour');r.checked=true;r.dispatchEvent(new Event('change'))})()`);

  // 3a2) 关掉去重：sheet 名单回到不含「重复号码」，并另存一份字节给 openpyxl 对照
  const namesDedup = await evaluate(`__smsApp.buildSplitWorkbook().SheetNames.join('|')`);
  check('去重开时多出「重复号码」sheet', namesDedup === exp.sheets_four_dedup.join('|'), namesDedup);
  await evaluate(`(()=>{const c=document.getElementById('dedupe');c.checked=false;c.dispatchEvent(new Event('change'))})()`);
  const namesNoDedup = await evaluate(`__smsApp.buildSplitWorkbook().SheetNames.join('|')`);
  check('去重关时回到原 7 张 sheet', namesNoDedup === exp.expected_sheets_four.join('|'), namesNoDedup);
  const b64nodup = await evaluate(`XLSX.write(__smsApp.buildSplitWorkbook(),{bookType:'xlsx',type:'base64'})`);
  fs.writeFileSync(path.join(OUTDIR, 'nodup.xlsx'), Buffer.from(b64nodup, 'base64'));
  await evaluate(`(()=>{const c=document.getElementById('dedupe');c.checked=true;c.dispatchEvent(new Event('change'))})()`);

  // 3b) 关掉「归一化」后号码列必须原样保留
  await evaluate(`(()=>{const c=document.getElementById('normNum');c.checked=false;c.dispatchEvent(new Event('change'))})()`);
  const capRaw = await evaluate(`document.getElementById('previewNote').textContent`);
  check('关归一化时文案改为保持原样', /导出保持原样/.test(capRaw), capRaw.slice(0, 70));
  const b64raw = await evaluate(`XLSX.write(__smsApp.buildSplitWorkbook(),{bookType:'xlsx',type:'base64'})`);
  fs.writeFileSync(path.join(OUTDIR, 'raw.xlsx'), Buffer.from(b64raw, 'base64'));
  await evaluate(`(()=>{const c=document.getElementById('normNum');c.checked=true;c.dispatchEvent(new Event('change'))})()`);
  check('原样模式也产出字节', b64raw.length > 5000, String(b64raw.length));

  // 4) 无表头 sheet 的路径
  await evaluate(`(()=>{const s=document.getElementById('sheetSel');s.value='纯号码';s.dispatchEvent(new Event('change'))})()`);
  await sleep(500);
  const s2 = await evaluate(`JSON.parse(JSON.stringify(__smsApp.state.stats))`);
  check('无表头表也能识别号码', s2.valid === 3 && s2.by['中国广电'].valid === 1, JSON.stringify({ valid: s2.valid, cb: s2.by['中国广电'].valid }));

  // 5) 真实点击「下载拆分结果」（回到四大模式）
  // 5) 模式开关联动预览，再回到四大模式
  const cap = (id) => `(function(){const r=document.getElementById('${id}');r.checked=true;r.dispatchEvent(new Event('change'));return document.getElementById('previewNote').textContent})()`;
  const three = await evaluate(cap('modeThree'));
  check('切三大时预览文案联动', /三大运营商/.test(three), three.slice(0, 44));
  const four = await evaluate(cap('modeFour'));
  check('切回四大时预览文案联动', /四大运营商/.test(four), four.slice(0, 44));

  await evaluate(`(()=>{const s=document.getElementById('sheetSel');s.value='客户名单';s.dispatchEvent(new Event('change'))})()`);
  await sleep(400);
  await send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: DL, eventsEnabled: true });
  await evaluate(`document.getElementById('btnSplit').click()`);
  const dlEnd = Date.now() + 20000;
  let downloaded = null;
  while (Date.now() < dlEnd) {
    const f = fs.readdirSync(DL).filter((n) => n.endsWith('.xlsx'));
    if (f.length) { downloaded = f[0]; break; }
    await sleep(300);
  }
  check('点击下载按钮真的产出文件', !!downloaded, downloaded || path.basename(DL));
  if (downloaded) fs.copyFileSync(path.join(DL, downloaded), path.join(OUTDIR, 'click.xlsx'));

  // 6) 再点「下载下单清单」，验证价格与金额真的进了文件
  await send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: DL, eventsEnabled: true });
  await evaluate(`document.getElementById('btnOrder').click()`);
  const oEnd = Date.now() + 20000;
  let orderFile = null;
  while (Date.now() < oEnd) {
    const f = fs.readdirSync(DL).filter((n) => n.includes('下单清单') && n.endsWith('.xlsx'));
    if (f.length) { orderFile = f[0]; break; }
    await sleep(300);
  }
  check('下单清单真的产出文件', !!orderFile, orderFile || path.basename(DL));
  if (orderFile) fs.copyFileSync(path.join(DL, orderFile), path.join(OUTDIR, 'order.xlsx'));

  fs.writeFileSync(path.join(OUTDIR, 'order_args.json'), JSON.stringify({ exp, DL }, null, 2));

  // 7) 截图留证（此时页面为样本文件 + 已填单价）
  await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true })
    .then((r) => fs.writeFileSync(path.join(OUTDIR, 'page.png'), Buffer.from(r.data, 'base64')));
  check('截图已留证', fs.existsSync(path.join(OUTDIR, 'page.png')));

  // 8) GBK 编码 CSV（国内系统导出常见）
  await send('DOM.setFileInputFiles', { files: [path.join(ROOT, 'fixtures', 'sample_gbk.csv')], objectId: fileHandle.result.objectId });
  await evaluate(`document.getElementById('file').dispatchEvent(new Event('change'))`);
  const gEnd = Date.now() + 20000;
  while (Date.now() < gEnd && !(await evaluate(`__smsApp.state.lastFile === 'sample_gbk.csv' && __smsApp.state.stats && __smsApp.state.stats.total === 12`))) await sleep(200);
  const gbk = await evaluate(`({head:__smsApp.state.header[0], s:JSON.parse(JSON.stringify(__smsApp.state.stats))})`);
  check('GBK CSV 表头不乱码', gbk.head === '姓名', JSON.stringify(gbk.head));
  check('页面明示所用编码', /GBK\/GB18030/.test(await evaluate(`document.getElementById('msg').textContent`)),
    await evaluate(`document.getElementById('msg').textContent`));
  check('GBK CSV 分类计数', ['中国移动', '中国联通', '中国电信'].every((c) => gbk.s.by[c].valid === 4) && gbk.s.by['中国广电'].valid === 0,
    JSON.stringify(Object.fromEntries(Object.entries(gbk.s.by).map(([k, v]) => [k, v.valid]))));

  // 9) 号码嵌在文本里：自动提取 → 一格多号拆多行 → 配合去重导出
  await send('DOM.setFileInputFiles', { files: [path.join(ROOT, 'fixtures', 'embed.xlsx')], objectId: fileHandle.result.objectId });
  await evaluate(`document.getElementById('file').dispatchEvent(new Event('change'))`);
  const ee = exp.embed;
  const eEnd = Date.now() + 20000;
  while (Date.now() < eEnd && !(await evaluate(`__smsApp.state.lastFile === 'embed.xlsx' && __smsApp.state.stats && __smsApp.state.stats.total === ${ee.total}`))) await sleep(200);
  const es = await evaluate(`JSON.parse(JSON.stringify(__smsApp.state.stats))`);
  check('内嵌号码触发自动提取', await evaluate(`document.getElementById('extract').checked`) === true,
    `checked=${await evaluate(`document.getElementById('extract').checked`)}`);
  check('一格多号拆成多行', es.total === ee.total && es.valid === ee.valid, `total=${es.total}/${ee.total} valid=${es.valid}/${ee.valid}`);
  check('提取出来的号码条数', es.extracted === ee.extracted, `extracted=${es.extracted}/${ee.extracted}`);
  check('提取后重复与异常计数', es.dup === ee.dup && es.invalid === ee.invalid, `dup=${es.dup}/${ee.dup} invalid=${es.invalid}/${ee.invalid}`);
  check('提取后逐运营商计数', Object.keys(ee.by).every((c) => es.by[c].valid === ee.by[c].valid && es.by[c].unique === ee.by[c].unique && es.by[c].dup === ee.by[c].dup),
    JSON.stringify(Object.fromEntries(Object.entries(es.by).map(([k, v]) => [k, `${v.valid}/${v.unique}/${v.dup}`]))));
  const ehead = await evaluate(`XLSX.utils.sheet_to_json(__smsApp.buildSplitWorkbook().Sheets['全部号码'],{header:1})[0]`);
  check('「提取号码」列插在号码列右侧', ehead[1] === '联系方式' && ehead[2] === '提取号码', JSON.stringify(ehead));
  const b64embed = await evaluate(`XLSX.write(__smsApp.buildSplitWorkbook(),{bookType:'xlsx',type:'base64'})`);
  fs.writeFileSync(path.join(OUTDIR, 'embed_split.xlsx'), Buffer.from(b64embed, 'base64'));
  check('提取+去重导出字节', b64embed.length > 3000, String(b64embed.length));

  check('页面运行无 JS 异常', pageErrors.length === 0, pageErrors.join(' | ') || '无');
} catch (e) {
  fails.push('脚本异常');
  checks.push(`ERROR ${e.message}`);
} finally {
  console.log(checks.join('\n'));
  console.log(`\n未通过：${fails.length ? fails.join('、') : '无'}`);
  chrome.kill('SIGKILL');
  process.exit(fails.length ? 1 : 0);
}
