// 发布包真机验证：启动器产出的参数 → 真 Chrome 能否在「含空格+中文」路径下开应用窗口并跑通业务
// 参数格式由 test/package.test.js 锁住，这里证明「这串参数在真实浏览器里确实可用」
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const PKG = path.join(ROOT, 'dist', '运营商拆表');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9347;
const fails = [];
const checks = [];
const check = (name, ok, detail) => {
  checks.push(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) fails.push(name);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 1) 用桩浏览器录下启动器真正的命令行，再用同样的参数起真 Chrome
const sandbox = fs.realpathSync(fs.mkdtempSync('/tmp/sms 包 验证-'));
const spaced = path.join(sandbox, '运营商拆表 拷到 别人机器');
fs.cpSync(PKG, spaced, { recursive: true });
const log = path.join(sandbox, 'args.txt');
const stub = path.join(sandbox, 'stub-browser');
fs.writeFileSync(stub, `#!/bin/sh\nprintf '%s\\n' "$@" > "${log}"\n`);
fs.chmodSync(stub, 0o755);
execFileSync(path.join(spaced, 'Mac版-运营商拆表.app/Contents/MacOS/launcher'), [], { env: { ...process.env, SMS_BROWSER: stub }, stdio: 'ignore' });
const launcherArgs = fs.readFileSync(log, 'utf8').split('\n').filter(Boolean);
const appArg = launcherArgs.find((a) => a.startsWith('--app='));
check('启动器给出的是 file:// 本地地址', !!appArg && appArg.startsWith('--app=file://'), appArg);
const appPath = decodeURIComponent(appArg.replace(/^--app=file:\/\//, ''));
check('中文/空格路径被换成全 ASCII 的中转路径（否则 Chrome 会丢掉窗口）', /^[\x20-\x7e]+$/.test(appPath) && !appPath.includes(' '), appPath);
check('中转路径指回的正是这份包里的网页', fs.realpathSync(appPath) === fs.realpathSync(path.join(spaced, 'app/index.html')), appPath);
const udd = launcherArgs.find((a) => a.startsWith('--user-data-dir='));
check('窗口数据写到用户目录而不是包内（包才能放只读盘）', !!udd && !udd.includes(spaced), udd);

const profile = fs.mkdtempSync('/tmp/sms-pkg-profile-');
const args = launcherArgs
  .map((a) => (a.startsWith('--user-data-dir=') ? `--user-data-dir=${profile}` : a))
  .concat(`--remote-debugging-port=${PORT}`, '--headless=new');

const chrome = spawn(CHROME, args, { stdio: 'ignore' });
let ws, seq = 0;
const pending = new Map();
const pageErrors = [];
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++seq;
  pending.set(id, { resolve, reject });
  ws.send(JSON.stringify({ id, method, params }));
  setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error(`${method} 超时`)); } }, 60000);
});
const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(`${r.exceptionDetails.exception?.description || r.exceptionDetails.text}`);
  return r.result.value;
};

try {
  let target = null;
  const end = Date.now() + 30000;
  while (Date.now() < end && !target) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      // 应用模式下仍会留一个 newtab 目标，必须按 url 认准包内那一页
      target = list.find((t) => t.type === 'page' && /^file:/.test(t.url));
    } catch (e) { await sleep(300); }
  }
  check('Chrome 起来了并给出页面目标', !!target, target?.url || '只有 newtab（--app 参数被浏览器忽略了）');
  const url = decodeURIComponent(target.url);
  check('开起来的就是启动器指定的那份网页（不是网络地址）', url === `file://${appPath}`, url);
  check('落地页是 index.html，不是 about:blank 或错误页', /index\.html$/.test(url), url.slice(-30));

  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
    }
    if (m.method === 'Runtime.exceptionThrown') pageErrors.push(JSON.stringify(m.params.exceptionDetails).slice(0, 300));
  });
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Network.enable');
  const netOut = [];
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Network.requestWillBeSent' && !/^(file|data|chrome|chrome-extension|devtools):/.test(m.params.request.url)) {
      netOut.push(`${m.params.request.method} ${m.params.request.url.slice(0, 80)}`);
    }
  });

  // 重载一次，好把「加载期」的请求也计入统计（attach 时首屏已经加载完了）
  await send('Page.reload', { ignoreCache: true });
  await sleep(2000);

  check('包内网页引擎就位', await evaluate(`!!window.XLSX && !!window.CarrierDB && !!__smsApp`),
    await evaluate(`document.title + ' / ' + XLSX.version + ' / ' + CarrierDB.updated`));

  const fi = (await send('Runtime.evaluate', { expression: `document.getElementById('file')` })).result.objectId;
  const load = async (rel, want) => {
    await send('DOM.setFileInputFiles', { files: [path.join(spaced, rel)], objectId: fi });
    await evaluate(`document.getElementById('file').dispatchEvent(new Event('change'))`);
    const stop = Date.now() + 20000;
    while (Date.now() < stop && !(await evaluate(want.cond))) await sleep(200);
    return evaluate(want.get);
  };

  const s1 = await load('示例/示例1-标准名单.xlsx', {
    cond: `__smsApp.state.stats && __smsApp.state.stats.total===26`,
    get: `JSON.stringify({total:__smsApp.state.stats.total, valid:__smsApp.state.stats.valid, sheets:__smsApp.buildSplitWorkbook().SheetNames.length})`,
  });
  check('示例1（标准名单）跑得通：26 行 / 21 有效 / 去重后 8 张 sheet', s1 === '{"total":26,"valid":21,"sheets":8}', s1);

  const s2 = await load('示例/示例2-号码嵌在文本里.xlsx', {
    cond: `__smsApp.state.stats && __smsApp.state.stats.total===9`,
    get: `JSON.stringify({extract:document.getElementById('extract').checked, n:__smsApp.state.stats.extracted, msg:document.getElementById('msg').textContent.slice(0,20)})`,
  });
  check('示例2（号码嵌文本）自动提取 7 个', s2.startsWith('{"extract":true,"n":7'), s2);

  const s3 = await load('示例/示例3-没有号码列.xlsx', {
    cond: `__smsApp.state.lastFile==='示例3-没有号码列.xlsx'`,
    get: `document.getElementById('msg').className + '|' + __smsApp.state.stats.valid`,
  });
  check('示例3（没有号码列）给出黄色提示而不是崩', /warn\|0/.test(s3), s3);

  check('整轮跑测没有发起任何非 file:// 请求', netOut.length === 0, netOut.join(' ⏎ ') || '0 条外部请求');
  check('全程无 JS 未捕获异常', pageErrors.length === 0, pageErrors.join(' ⏎ ') || '无');
} catch (e) {
  fails.push('脚本异常');
  checks.push(`ERROR ${e.message}`);
} finally {
  console.log(checks.join('\n'));
  console.log(`\n未通过：${fails.length ? fails.join('、') : '无'}`);
  chrome.kill('SIGKILL');
  fs.rmSync(sandbox, { recursive: true, force: true });
  fs.rmSync(profile, { recursive: true, force: true });
  process.exit(fails.length ? 1 : 0);
}
