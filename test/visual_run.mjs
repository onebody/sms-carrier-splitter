// 有界面 Chrome 全链路跑测：每步截图 + 断言，下载物再用 openpyxl 回读闭环，最后产出可视化报告
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const PAGE = path.join(ROOT, '号码运营商分类与拆表.html');
const FIX = path.join(ROOT, 'fixtures');
const OUT = path.join(FIX, 'report');
const VIS = process.env.VIS_DIR || null;
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9346;
const SLOWMO = Number(process.env.SLOWMO || 700);

const RENDER_ONLY = !!process.env.RENDER_ONLY;
if (!RENDER_ONLY) {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
}
const DL = fs.mkdtempSync('/tmp/sms-visual-dl-');
const PROFILE = fs.mkdtempSync('/tmp/sms-visual-chrome-');

const steps = [];
let shotSeq = 0;

async function shot(label) {
  const r = await send('Page.captureScreenshot', { format: 'jpeg', quality: 74 });
  const file = `step-${String(++shotSeq).padStart(2, '0')}-${label.replace(/[^\w一-龥-]/g, '')}.jpg`;
  fs.writeFileSync(path.join(OUT, file), Buffer.from(r.data, 'base64'));
  return file;
}

function record(o) {
  steps.push(o);
  const line = `${o.ok ? 'PASS' : o.ok === false ? 'FAIL' : 'INFO'} ${o.no}. ${o.title}`;
  const d = o.detail || o.actual;
  console.log(line + (d ? ` — ${String(d).replace(/\s+/g, ' ').slice(0, 130)}` : ''));
}

async function step(title, action, expect, run, label, post) {
  const t0 = Date.now();
  const res = await run();
  await new Promise((r) => setTimeout(r, SLOWMO));
  const img = await shot(label || title);
  if (post) await post();
  const ok = res.ok === undefined ? true : res.ok;
  record({
    no: steps.length + 1, title, action, expect, ok,
    actual: res.actual, detail: res.detail, note: res.note, img, ms: Date.now() - t0,
  });
  if (ok === false) failures.push(title);
  return res;
}

const failures = [];
let env = {};

function buildReport(meta) {
  execFileSync('python3', [path.join(ROOT, 'test', 'embed_shots.py'), OUT, path.join(OUT, '_embed')], { stdio: 'inherit' });
  const html = renderReport(meta);
  fs.writeFileSync(path.join(OUT, '测试报告.html'), html);
  if (VIS) {
    fs.mkdirSync(VIS, { recursive: true });
    fs.writeFileSync(path.join(VIS, 'sms-e2e-report.html'), html);
  }
  return html;
}

if (process.env.RENDER_ONLY) {
  const meta = JSON.parse(fs.readFileSync(path.join(OUT, 'steps.json'), 'utf8'));
  const dlDir = fs.readdirSync('/tmp').filter((d) => d.startsWith('sms-visual-dl-')).sort()
    .map((d) => `/tmp/${d}`).filter((d) => fs.readdirSync(d).length).pop();
  meta.dl = fs.readdirSync(dlDir).map((n) => ({ n, kb: Math.round(fs.statSync(path.join(dlDir, n)).size / 1024) }));
  const html = buildReport(meta);
  console.log(`重渲染报告：${(html.length / 1024).toFixed(0)} KB（下载目录 ${dlDir}）`);
  process.exit(meta.failures.length ? 1 : 0);
}

const chrome = spawn(CHROME, [
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`, '--no-first-run', '--no-default-browser-check',
  '--disable-features=Translate', `--window-size=1300,920`, `--window-position=60,60`, 'about:blank',
], { stdio: 'ignore' });

let ws, seq = 0;
const pending = new Map();
const jsErrors = [];

function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error(`${method} 超时`)); } }, 90000);
  });
}

async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(`${r.exceptionDetails.exception?.description || r.exceptionDetails.text}`);
  return r.result.value;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let fileInput = null;
async function loadFile(name) {
  await send('DOM.setFileInputFiles', { files: [path.join(FIX, name)], objectId: fileInput });
  await evaluate(`document.getElementById('file').dispatchEvent(new Event('change'))`);
}
async function waitStats(pred) {
  const end = Date.now() + 40000;
  while (Date.now() < end) {
    if (await evaluate(`!!(__smsApp.state.stats && (${pred}))`)) return true;
    await sleep(150);
  }
  return false;
}
const statsJSON = `JSON.parse(JSON.stringify(__smsApp.state.stats))`;

try {
  // 等 Chrome 起来
  const end = Date.now() + 40000;
  let target = null;
  while (Date.now() < end && !target) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      target = list.find((t) => t.type === 'page');
    } catch (e) { await sleep(300); }
  }
  if (!target) throw new Error('Chrome 调试端口未就绪');

  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
    }
    if (m.method === 'Runtime.exceptionThrown') jsErrors.push(JSON.stringify(m.params.exceptionDetails).slice(0, 300));
  });
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 860, deviceScaleFactor: 1, mobile: false });

  await send('Page.navigate', { url: `file://${PAGE}` });
  await sleep(2500);

  const ver = await send('Browser.getVersion');
  Object.assign(env, { chrome: ver.product.split('/')[1] }, await evaluate(`({xlsx:XLSX.version, seg:CarrierDB.updated, w:innerWidth, h:innerHeight})`));

  await step('打开页面（空态）', '直接双击单文件 HTML，无需服务器、无需联网',
    '引擎与号段表版本可见，拖拽区就绪', async () => {
      const t = await evaluate(`({title:document.title, ver:document.getElementById('engVer').textContent, drop:!!document.getElementById('drop')})`);
      return { ok: /SheetJS 0\.20\.3/.test(t.ver) && t.drop, actual: t.ver };
    }, '空态');

  fileInput = (await send('Runtime.evaluate', { expression: `document.getElementById('file')` })).result.objectId;

  await step('载入 26 行样本（含脏数据）', '选择 fixtures/sample.xlsx：四大运营商 + 虚商 + +86/空格/数字单元格 + 重复 + 异常 + 空号',
    '数据行 26 / 有效 21 / 去重 20 / 重复 1 / 异常 4 / 空 1', async () => {
      await loadFile('sample.xlsx');
      const ready = await waitStats(`__smsApp.state.stats.total===26`);
      const s = await evaluate(statsJSON);
      const cards = await evaluate(`document.getElementById('cards').textContent.replace(/\\s+/g,' ')`);
      return { ok: ready && s.total === 26 && s.valid === 21 && s.dup === 1 && s.invalid === 4 && s.empty === 1, actual: cards.trim() };
    }, '载入样本');

  await step('逐行标注与备注', '预览表 ★ 为判定列，右侧两列是新增的「运营商」「备注」；断言取自全部行的数据而非只截屏',
    '虚商写明落地网、重复写明首次行号、异常写明原因', async () => {
      const rows = await evaluate(`__smsApp.state.rows.map(r=>[r.srcRow+1,String(r.raw),r.carrier,r.note].join(' | '))`);
      const need = [/虚拟运营商转售，落地网为联通/, /虚拟运营商转售，落地网为移动/, /重复号码（第\d+行已出现）/, /位数10，非11位/, /首位非1/, /未登记号段/, /空号码/];
      const missing = need.filter((re) => !rows.some((r) => re.test(r)));
      const shown = await evaluate(`document.querySelectorAll('#previewWrap tbody tr').length`);
      return {
        ok: missing.length === 0,
        actual: rows.filter((r) => /虚拟|重复|位数|未登记|首位|空号码/.test(r)).join(' ⏎  '),
        note: `预览渲染 ${shown} 行（上限 20），断言覆盖全部 ${rows.length} 行${missing.length ? `；缺少 ${missing.length} 类备注` : ''}`,
      };
    }, '逐行标注');

  await step('三/四大模式切换', '点「三大（广电并入其他）」单选，再看导出的 sheet 名单',
    '四大 8 张 sheet（含「重复号码」）；三大 7 张（广电并入「其他(含广电)」，标注列仍写中国广电）', async () => {
      const four = await evaluate(`XLSX.utils.book_new && __smsApp.buildSplitWorkbook().SheetNames.join(' / ')`);
      await evaluate(`(()=>{const r=document.getElementById('modeThree');r.checked=true;r.dispatchEvent(new Event('change'))})()`);
      const three = await evaluate(`__smsApp.buildSplitWorkbook().SheetNames.join(' / ')`);
      const note = await evaluate(`document.getElementById('previewNote').textContent`);
      await evaluate(`(()=>{const r=document.getElementById('modeFour');r.checked=true;r.dispatchEvent(new Event('change'))})()`);
      return { ok: four === '全部号码 / 中国移动 / 中国联通 / 中国电信 / 中国广电 / 未知或其他 / 重复号码 / 汇总'
        && three === '全部号码 / 中国移动 / 中国联通 / 中国电信 / 其他(含广电) / 重复号码 / 汇总', actual: `四大：${four}⏎三大：${three}`, detail: note.slice(0, 60) };
    }, '模式切换');

  await step('拆分时去重：开 / 关对照', '点掉「拆分时去重」再点回来，看导出的 sheet 与行数如何变化',
    '开启：各 sheet 只留首次出现行（全部号码 25 行）+ 单列「重复号码」1 行；关闭：回到含重复的 26 行、无该 sheet', async () => {
      const on = await evaluate(`(()=>{const w=__smsApp.buildSplitWorkbook();return {names:w.SheetNames.length, rows:XLSX.utils.sheet_to_json(w.Sheets['全部号码'],{header:1}).length-1, dup:XLSX.utils.sheet_to_json(w.Sheets['重复号码'],{header:1}).length-1}})()`);
      await evaluate(`(()=>{const c=document.getElementById('dedupe');c.checked=false;c.dispatchEvent(new Event('change'))})()`);
      const off = await evaluate(`(()=>{const w=__smsApp.buildSplitWorkbook();return {names:w.SheetNames.length, rows:XLSX.utils.sheet_to_json(w.Sheets['全部号码'],{header:1}).length-1, hasDup:w.SheetNames.includes('重复号码')}})()`);
      const dim = await evaluate(`document.querySelectorAll('#previewWrap tr.dim').length`);
      const note = await evaluate(`document.getElementById('previewNote').textContent`);
      await evaluate(`(()=>{const c=document.getElementById('dedupe');c.checked=true;c.dispatchEvent(new Event('change'))})()`);
      return { ok: on.rows === 25 && on.dup === 1 && on.names === 8 && off.rows === 26 && off.names === 7 && off.hasDup === false,
        actual: `开：${on.names} 张 / 全部号码 ${on.rows} 行 / 重复号码 ${on.dup} 行${on.dup ? `（预览灰显 ${dim} 行）` : ''}⏎关：${off.names} 张 / 全部号码 ${off.rows} 行`,
        detail: note.slice(0, 70) };
    }, '去重开关');

  await step('下单页算钱', '给移动填 0.05、联通填 0.045，电信/广电留空',
    '移动 8×0.05=0.40，联通 6×0.045=0.27，留空组显示「—」，合计 20 条 / 0.67 元', async () => {
      await evaluate(`(()=>{const set=(el,v)=>{el.value=v;el.dispatchEvent(new Event('input'))};
        const rows=[...document.querySelectorAll('#orderWrap tr[data-carrier]')];
        set(rows.find(r=>r.dataset.carrier==='中国移动').querySelector('.price'),'0.05');
        set(rows.find(r=>r.dataset.carrier==='中国联通').querySelector('.price'),'0.045');})()`);
      const view = await evaluate(`[...document.querySelectorAll('#orderWrap tr[data-carrier]')].map(tr=>tr.dataset.carrier+' 条'+tr.querySelector('.qty').value+' 价'+(tr.querySelector('.price').value||'空')+' 额'+tr.querySelector('.amount').textContent).join(' ⏎ ')`);
      const sum = await evaluate(`document.getElementById('sumQty').textContent+' 条 / '+document.getElementById('sumAmt').textContent+' 元'`);
      return { ok: /0\.40/.test(view) && /0\.27/.test(view) && /—/.test(view) && sum === '20 条 / 0.67 元', actual: view, detail: `合计：${sum}` };
    }, '下单页');

  await send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: DL, eventsEnabled: true });

  await step('点「下载拆分结果」', '真实点击按钮，等浏览器落盘',
    '目录里出现 原名_运营商拆分_日期.xlsx', async () => {
      await evaluate(`document.getElementById('btnSplit').click()`);
      const f = await waitForFile(DL, /拆分/, 25000);
      return { ok: !!f, actual: f ? `${f}（${(fs.statSync(path.join(DL, f)).size / 1024).toFixed(0)} KB）` : '未出现文件' };
    }, '下载拆分');

  const splitFile = steps.at(-1).actual?.split('（')[0];

  await step('点「下载下单清单」', '真实点击按钮，等浏览器落盘',
    '目录里出现 原名_运营商下单清单_日期.xlsx', async () => {
      await evaluate(`document.getElementById('btnOrder').click()`);
      const f = await waitForFile(DL, /下单清单/, 25000);
      return { ok: !!f, actual: f ? `${f}（${(fs.statSync(path.join(DL, f)).size / 1024).toFixed(0)} KB）` : '未出现文件' };
    }, '下载清单');

  const orderFile = steps.at(-1).actual?.split('（')[0];

  await step('闭环：用 openpyxl 回读下载文件', '把浏览器下载的字节交给另一个实现读回来核对（不用页面自己的库自证）',
    'sheet 数/行数/号码列类型必须与页面显示一致', async () => {
      const j = JSON.parse(execFileSync('python3', [path.join(ROOT, 'test', 'readback.py'), path.join(DL, splitFile)], { encoding: 'utf8' }));
      const all = j.sheets.find((s) => s.name === '全部号码');
      const types = all.phoneTypes || {};
      fs.writeFileSync(path.join(OUT, 'readback_split.json'), JSON.stringify(j, null, 2));
      const oj = JSON.parse(execFileSync('python3', [path.join(ROOT, 'test', 'readback.py'), path.join(DL, orderFile)], { encoding: 'utf8' }));
      fs.writeFileSync(path.join(OUT, 'readback_order.json'), JSON.stringify(oj, null, 2));
      const ok = j.sheets.length === 8 && all.dataRows === 25 && ((types.s || 0) + (types.str || 0)) === 25 && !types.n
        && oj.sheets[0].name === '下单清单';
      return {
        ok,
        actual: `sheet：${j.sheets.map((s) => `${s.name}(${s.dataRows}行/${s.cols}列)`).join('、')}`,
        detail: `号码列单元格类型分布：${JSON.stringify(types)}｜非文本单元格：${(all.phoneOdd || []).join('、') || '无'}｜回读前 4 个号码：${all.phones.join('、')}`,
        note: `下单清单 ${oj.sheets[0].dataRows} 行`,
      };
    }, '回读校验');

  await step('性能：1 万行样本', '载入 big.xlsx（10000 行，含 1/5 未登记号段），计时纯分类过程',
    '分类计数正确且分类耗时可接受（阈值 4000ms）', async () => {
      await loadFile('big.xlsx');
      const ready = await waitStats(`__smsApp.state.stats.total>=10000`);
      const ms = await evaluate(`(()=>{const t=performance.now();__smsApp.process();return Math.round(performance.now()-t)})()`);
      const s = await evaluate(statsJSON);
      return {
        ok: ready && s.valid === 8000 && s.invalid === 2000 && ms < 4000,
        actual: `分类耗时 ${ms} ms｜有效 ${s.valid}｜异常 ${s.invalid}｜移动 ${s.by['中国移动'].valid} 联通 ${s.by['中国联通'].valid} 电信 ${s.by['中国电信'].valid} 广电 ${s.by['中国广电'].valid}`,
      };
    }, '万行性能');

  await step('无表头工作表', '把 sheet 切到「纯号码」（只有一列裸号码，没有表头）',
    '仍能识别 3 个号码且广电计 1', async () => {
      await loadFile('sample.xlsx');
      await waitStats(`__smsApp.state.stats.total>=26`);
      await evaluate(`(()=>{const s=document.getElementById('sheetSel');s.value='纯号码';s.dispatchEvent(new Event('change'))})()`);
      await sleep(600);
      const s = await evaluate(statsJSON);
      const head = await evaluate(`(()=>({noHeader:document.getElementById('noHeader').checked, col:document.getElementById('colSel').options[document.getElementById('colSel').selectedIndex].textContent}))()`);
      return { ok: s.valid === 3 && s.by['中国广电'].valid === 1 && head.noHeader === true, actual: `有效 ${s.valid}｜自动勾选「没有表头」｜列：${head.col}` };
    }, '无表头');

  await step('号码嵌在文本里：自动提取', '载入 fixtures/embed.xlsx（联系方式是「手机 138…，备用 139…」这类整句文本）',
    '页面自动开启提取，新增「提取号码」列，一格多号拆成多行，原文列不动，座机/身份证不误命中', async () => {
      await loadFile('embed.xlsx');
      const ready = await waitStats(`__smsApp.state.stats.total===9`);
      const s = await evaluate(statsJSON);
      const box = await evaluate(`({checked:document.getElementById('extract').checked, msg:document.getElementById('msg').textContent})`);
      const rows = await evaluate(`__smsApp.state.rows.map(r=>r.srcRow+1+':'+(r.digits||'-')+':'+r.carrier).join(' ')`);
      const head = await evaluate(`XLSX.utils.sheet_to_json(__smsApp.buildSplitWorkbook().Sheets['全部号码'],{header:1})[0].join('/')`);
      const cells = await evaluate(`[...document.querySelectorAll('#previewWrap tbody tr')].slice(0,4).map(tr=>[...tr.children].slice(0,4).map(td=>td.textContent).join(' | ')).join(' ⏎ ')`);
      return {
        ok: ready && box.checked && s.extracted === 7 && s.valid === 7 && s.total === 9 && s.dup === 1 && s.invalid === 2
          && head === '姓名/联系方式/提取号码/城市/运营商/备注' && !/110101199003078888|0755-12345678/.test(rows),
        actual: `自动勾选提取=${box.checked}｜提取 ${s.extracted} 个｜拆成 ${s.total} 行｜重复 ${s.dup}｜未命中 ${s.invalid}（座机+身份证）⏎${rows}`,
        detail: `${box.msg.slice(0, 80)} ⏎ ${cells}`,
      };
    }, '文本提取', async () => { await loadFile('sample.xlsx'); await waitStats(`__smsApp.state.stats.total===26`); });

  await step('GBK 编码 CSV', '载入国内系统常见的 GBK 编码 CSV',
    '中文表头不乱码，且页面明示所用编码', async () => {
      await loadFile('sample_gbk.csv');
      const ready = await waitStats(`__smsApp.state.lastFile==='sample_gbk.csv'`);
      const head = await evaluate(`__smsApp.state.header[0]`);
      const m = await evaluate(`document.getElementById('msg').textContent`);
      const s = await evaluate(statsJSON);
      return { ok: ready && head === '姓名' && /GBK\/GB18030/.test(m) && s.valid === 12, actual: `表头=${head}｜${m.slice(0, 46)}` };
    }, 'GBK-CSV');

  await step('负例：整表没有号码列', '载入 no_phone.xlsx（订单号/金额/日期）',
    '给出黄色提示而不是静默出 0 结果', async () => {
      await loadFile('no_phone.xlsx');
      await waitStats(`__smsApp.state.stats.total>0`);
      const m = await evaluate(`({cls:document.getElementById('msg').className, text:document.getElementById('msg').textContent})`);
      const s = await evaluate(statsJSON);
      return { ok: /warn/.test(m.cls) && s.valid === 0, actual: `${m.cls.includes('warn') ? '黄色警告' : '非警告'}：${m.text.slice(0, 60)}` };
    }, '无号码列');

  await step('负例：扩展名骗人', '载入 broken.xlsx（其实是纯文本）',
    '红色错误提示，页面不崩、后续仍可继续用', async () => {
      await loadFile('broken.xlsx');
      await sleep(1200);
      const m = await evaluate(`({cls:document.getElementById('msg').className, text:document.getElementById('msg').textContent})`);
      await loadFile('sample.xlsx');
      const back = await waitStats(`__smsApp.state.stats.total===26`);
      return { ok: /err/.test(m.cls) && back, actual: `${m.text.slice(0, 60)}｜恢复载入样本：${back ? '成功' : '失败'}` };
    }, '损坏文件');

  await step('打印视图', '把媒体类型切成 print，看下单页单独成版',
    '只保留下单清单，隐藏拖拽区/预览/按钮', async () => {
      await evaluate(`(()=>{const r=document.getElementById('modeFour');r.checked=true;r.dispatchEvent(new Event('change'))})()`);
      await send('Emulation.setEmulatedMedia', { media: 'print' });
      await sleep(300);
      const vis = await evaluate(`({drop:getComputedStyle(document.getElementById('drop')).display, prev:getComputedStyle(document.getElementById('previewSection')).display, order:getComputedStyle(document.getElementById('orderWrap')).display})`);
      return { ok: vis.drop === 'none' && vis.prev === 'none' && vis.order !== 'none', actual: `拖拽区=${vis.drop} 预览=${vis.prev} 下单表=${vis.order}` };
    }, '打印', async () => { await send('Emulation.setEmulatedMedia', { media: '' }); });

  await step('收尾：JS 异常与残留', '统计整轮跑测里页面抛出的未捕获异常',
    '0 条未捕获异常', async () => ({ ok: jsErrors.length === 0, actual: jsErrors.length ? jsErrors.join(' ⏎ ') : '无异常' }), '收尾');

  // 同一份产物再跑三层非可视化断言，让一张报告覆盖整条链路
  const t0 = Date.now();
  const run = (cmd, args) => { try { return execFileSync(cmd, args, { cwd: ROOT, encoding: 'utf8' }); } catch (e) { return String(e.stdout || '') + '<<CRASH>>' + e.message; } };
  const u = run('node', ['--test', 'test/segment.test.js']);
  const e = run('node', ['test/e2e.mjs']);
  const v = run('python3', ['test/verify_output.py']);
  const count = (s) => [ (s.match(/^ok |^PASS /gm) || []).length, (s.match(/^not ok |^FAIL /gm) || []).length ];
  const [u1, u0] = [Number((u.match(/# pass (\d+)/) || [, 0])[1]), Number((u.match(/# fail (\d+)/) || [, 0])[1])];
  const [e1, e0] = count(e);
  const [v1, v0] = count(v);
  record({
    no: steps.length + 1, title: '回归层：单测 / 无界面 e2e / 产物字节校验',
    action: '本轮同一份构建产物，再跑三层非可视化断言（第三层用 openpyxl 读字节，不用页面自己的库自证）',
    expect: '三层全绿，0 项失败',
    ok: u0 === 0 && e0 === 0 && v0 === 0 && +u1 > 0 && e1 > 0 && v1 > 0,
    actual: `号段单测 ${u1} 通过 / ${u0} 失败 ⏎ 无界面 e2e ${e1} 通过 / ${e0} 失败 ⏎ openpyxl 产物校验 ${v1} 通过 / ${v0} 失败`,
    img: null, ms: Date.now() - t0,
  });
  if (u0 || e0 || v0) failures.push('回归层');
} catch (e) {
  console.error(e.stack);
  record({ no: steps.length + 1, title: '脚本异常', ok: false, actual: e.message });
  failures.push('脚本异常');
  try { await shot('异常'); } catch (err) { /* 忽略 */ }
} finally {
  const meta = { ranAt: new Date().toLocaleString(), env, steps, failures, dl: fs.readdirSync(DL).map((n) => ({ n, kb: Math.round(fs.statSync(path.join(DL, n)).size / 1024) })) };
  fs.writeFileSync(path.join(OUT, 'steps.json'), JSON.stringify(meta, null, 2));
  buildReport(meta);
  console.log(`\n报告：${path.join(OUT, '测试报告.html')}｜步骤 ${steps.length}｜未通过 ${failures.length ? failures.join('、') : '无'}`);
  chrome.kill('SIGKILL');
  process.exit(failures.length ? 1 : 0);
}

async function waitForFile(dir, re, timeout) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const f = fs.readdirSync(dir).filter((n) => re.test(n) && n.endsWith('.xlsx'));
    if (f.length) return f[0];
    await sleep(300);
  }
  return null;
}

function renderReport(meta) {
  const img = (name) => {
    const small = path.join(OUT, '_embed', name);
    return fs.readFileSync(fs.existsSync(small) ? small : path.join(OUT, name)).toString('base64');
  };
  const esc = (s) => String(s ?? '').replace(/[&<>]/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[m])).replace(/⏎/g, '<br>');
  const cards = meta.steps.map((s) => `
  <article class="step ${s.ok === false ? 'bad' : 'good'}">
    <header><span class="no">${s.no}</span><h3>${esc(s.title)}</h3><span class="verdict">${s.ok === false ? '未通过' : '通过'}</span><span class="ms">${s.ms} ms</span></header>
    <p class="act">${esc(s.action)}</p>
    <p class="exp"><b>预期</b> ${esc(s.expect)}</p>
    <p class="real"><b>实测</b> ${esc(s.actual)}${s.note ? `<br><span class="nt">${esc(s.note)}</span>` : ''}${s.detail ? `<br><span class="nt">${esc(s.detail)}</span>` : ''}</p>
    ${s.img ? `<figure><img src="data:image/jpeg;base64,${img(s.img)}" alt="${esc(s.title)} 截图" loading="lazy"></figure>` : ''}
  </article>`).join('');

  return `<style>
  :root{--bg:#0f1419;--fg:#e6edf3;--mut:#8b98a5;--line:#22303c;--card:#161b22;--ok:#3fb950;--bad:#f85149;--accent:#4a90d9}
  @media (prefers-color-scheme: light){:root{--bg:#f6f8fa;--fg:#1f2328;--mut:#59636e;--line:#d8dee4;--card:#fff}}
  *{box-sizing:border-box}
  .rep{background:var(--bg);color:var(--fg);font:14px/1.62 -apple-system,"PingFang SC",sans-serif;padding:22px;max-width:1240px;margin:0 auto}
  .rep h1{font-size:21px;margin:0 0 6px}
  .rep h2{font-size:15px;margin:26px 0 12px;padding-left:9px;border-left:3px solid var(--accent)}
  .meta{color:var(--mut);font-size:12px;margin-bottom:16px}
  .bar{display:flex;gap:10px;flex-wrap:wrap;margin:14px 0}
  .pill{background:var(--card);border:1px solid var(--line);border-radius:999px;padding:5px 14px;font-size:13px}
  .pill b{font-size:17px}
  .pill.ok{border-color:var(--ok)} .pill.no{border-color:var(--bad)}
  .steps{display:grid;grid-template-columns:repeat(auto-fill,minmax(380px,1fr));gap:16px}
  .step{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px 16px;border-left-width:4px}
  .step.good{border-left-color:var(--ok)} .step.bad{border-left-color:var(--bad)}
  .step header{display:flex;align-items:center;gap:9px;margin-bottom:8px}
  .step h3{font-size:14.5px;margin:0;flex:1}
  .no{background:var(--accent);color:#fff;border-radius:7px;padding:1px 8px;font-size:12px;font-weight:600}
  .verdict{font-size:12px;color:var(--ok)} .bad .verdict{color:var(--bad)}
  .ms{font-size:11px;color:var(--mut)}
  .step p{margin:6px 0;font-size:12.8px}
  .act{color:var(--mut)}
  .exp b,.real b{color:var(--mut);font-weight:600;margin-right:5px}
  .real{font-family:ui-monospace,Menlo,monospace;font-size:12.2px;word-break:break-all}
  .nt{color:var(--mut)}
  figure{margin:10px 0 0;padding:0}
  figure img{width:100%;border:1px solid var(--line);border-radius:8px;display:block}
  table.t{width:100%;border-collapse:collapse;font-size:12.5px}
  table.t th,table.t td{border:1px solid var(--line);padding:6px 9px;text-align:left}
  table.t th{background:var(--card)}
  .foot{color:var(--mut);font-size:12px;margin-top:24px;border-top:1px solid var(--line);padding-top:12px}
  code{background:var(--card);padding:1px 6px;border-radius:5px;border:1px solid var(--line)}
  </style>
  <div class="rep">
    <h1>手机号运营商分类器 · 全链路浏览器测试报告</h1>
    <p class="meta">运行时间 ${esc(meta.ranAt)} ｜ Chrome ${esc(meta.env?.chrome || meta.env?.ua || '')} ｜ 视口 ${meta.env?.w}×${meta.env?.h} ｜ SheetJS ${meta.env?.xlsx} ｜ 号段表 ${meta.env?.seg} ｜ 有界面窗口逐步操作，每步截图</p>
    <div class="bar">
      <span class="pill">步骤 <b>${meta.steps.length}</b></span>
      <span class="pill ok">通过 <b>${meta.steps.filter((s) => s.ok !== false).length}</b></span>
      <span class="pill ${meta.failures.length ? 'no' : 'ok'}">未通过 <b>${meta.failures.length}</b></span>
      <span class="pill">截图 <b>${meta.steps.filter((s) => s.img).length}</b> 张</span>
      <span class="pill">浏览器落盘 <b>${meta.dl.length}</b> 个文件</span>
    </div>
    <h2>逐步结果</h2>
    <div class="steps">${cards}</div>
    <h2>下载产物（浏览器真实写入磁盘）</h2>
    <table class="t"><tr><th>文件</th><th>大小</th></tr>${meta.dl.map((f) => `<tr><td>${esc(f.n || f)}</td><td>${f.kb ?? '—'} KB</td></tr>`).join('')}</table>
    <p class="foot">复现：<code>python3 test/make_sample.py</code> 生成夹具 → <code>node test/visual_run.mjs</code>（会弹出真实 Chrome 窗口）。
    非可视化断言层：<code>node --test test/segment.test.js</code>、<code>node test/e2e.mjs</code>、<code>python3 test/verify_output.py</code>。
    已知边界：号段表为 3/4 位前缀级，携号转网号码无法识别；140 号段归属各来源不一致，按「未登记」处理不猜测。</p>
  </div>`;
}
