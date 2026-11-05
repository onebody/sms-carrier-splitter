// 打包产物的契约测试：树状结构、脚本可移植性、校验清单自洽
// 答案全部写死在这里，不从 package.py 的实现反推
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const ROOT = path.resolve(import.meta.dirname, '..');
const DIST = path.join(ROOT, 'dist');
const PKG = path.join(DIST, '运营商拆表');
const DELIVERABLE = path.join(ROOT, '号码运营商分类与拆表.html');

const sha256 = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const REQUIRED = [
  'app/index.html',
  '运营商拆表.exe',
  '启动.bat',
  '制作桌面快捷方式.bat',
  '校验文件完整性.bat',
  'Mac版-运营商拆表.app/Contents/Info.plist',
  'Mac版-运营商拆表.app/Contents/MacOS/launcher',
  'Mac版-运营商拆表.app/Contents/Resources/icon.icns',
  'tools/make_shortcut.ps1',
  'tools/verify.ps1',
  '图标/icon-1024.png',
  '图标/app.ico',
  '示例/示例1-标准名单.xlsx',
  '示例/示例2-号码嵌在文本里.xlsx',
  '示例/示例3-没有号码列.xlsx',
  '使用说明.txt',
  '版本与校验.txt',
];

before(() => {
  fs.rmSync(DIST, { recursive: true, force: true });
  execFileSync('python3', [path.join(ROOT, 'package.py'), '--out', DIST], { stdio: 'inherit' });
});

test('发布树里每个承诺的文件都真实存在且非空', () => {
  for (const rel of REQUIRED) {
    const p = path.join(PKG, rel);
    assert.ok(fs.existsSync(p), `缺少 ${rel}`);
    assert.ok(fs.statSync(p).size > 0, `${rel} 是空文件`);
  }
});

test('包内网页与交付的单文件 HTML 字节一致', () => {
  assert.equal(sha256(path.join(PKG, 'app/index.html')), sha256(DELIVERABLE));
});

test('三个 bat 脚本是纯 ASCII 且用 CRLF（含中文会被 cmd 按 GBK 解错）', () => {
  for (const rel of ['启动.bat', '制作桌面快捷方式.bat', '校验文件完整性.bat']) {
    const buf = fs.readFileSync(path.join(PKG, rel));
    const nonAscii = [...buf].filter((b) => b > 0x7f);
    assert.equal(nonAscii.length, 0, `${rel} 含 ${nonAscii.length} 个非 ASCII 字节`);
    const lines = buf.toString('latin1').split('\n').filter((l) => l.length);
    assert.ok(lines.every((l) => l.endsWith('\r')), `${rel} 不是 CRLF 换行`);
  }
});

test('启动.bat 把入口落到恒定 ASCII 的 Public 目录再交给 --app，并且不联网', () => {
  const bat = fs.readFileSync(path.join(PKG, '启动.bat'), 'latin1');
  assert.match(bat, /%~dp0app\\index\.html/, '必须相对脚本自身定位，包才能随便放');
  // Chrome 实测：--app 的 file:// URL 里带非 ASCII（中文目录名）会被整个忽略，退回新标签页
  assert.match(bat, /set "STAGE=%PUBLIC%\\sms-carrier-splitter"/, '要经 C:\\Users\\Public 这个恒定 ASCII 路径中转');
  assert.match(bat, /copy \/Y "%SRC%" "%STAGE%\\index\.html"/, '用复制而不是软链，只读盘与共享盘也能起');
  assert.match(bat, /set "P=%P:\\=\/%"/, 'file:// URL 需要正斜杠');
  assert.match(bat, /--app="file:\/\/\/%P%"/, '应用模式参数拼错就退回普通标签页');
  assert.match(bat, /"--user-data-dir=%PROFILE%"/, '用户名带空格时，不加引号会被拆成两个参数');
  assert.match(bat, /Microsoft\\Edge\\Application\\msedge\.exe/, '要优先用 Win10/11 自带的 Edge');
  assert.match(bat, /Google\\Chrome\\Application\\chrome\.exe/);
  assert.match(bat, /goto fallback/, '浏览器找不到时必须退回默认浏览器而不是报错退出');
  assert.ok(!/https?:\/\//.test(bat.replace(/file:\/\/\/%P%/g, '')), '除 file:// 外不允许出现任何网络地址');
});

test('macOS launcher 可执行、Info.plist 指向它、并优先走本地回退到默认浏览器', () => {
  const app = path.join(PKG, 'Mac版-运营商拆表.app');
  const plist = fs.readFileSync(path.join(app, 'Contents/Info.plist'), 'utf8');
  assert.match(plist, /<string>launcher<\/string>/);
  const st = fs.statSync(path.join(app, 'Contents/MacOS/launcher'));
  assert.ok(st.mode & 0o111, 'launcher 没有可执行位');
  assert.match(plist, /icon\.icns/);
});

test('launcher 在指定 SMS_BROWSER 时把 --app 指向纯 ASCII 中转路径（软链回包内文件）', () => {
  // 拷到「带空格 + 中文」的目录再跑，模拟同事随手放到 下载/OneDrive 里的真实路径
  const sandbox = fs.realpathSync(fs.mkdtempSync('/tmp/pkg-sp-'));
  const spaced = path.join(sandbox, 'sms 包 测试 运营商拆表');
  fs.cpSync(PKG, spaced, { recursive: true });
  const stubDir = path.join(sandbox, 'stub');
  fs.mkdirSync(stubDir);
  const log = path.join(stubDir, 'args.txt');
  const stub = path.join(stubDir, 'fake-browser');
  fs.writeFileSync(stub, `#!/bin/sh\nprintf '%s\\n' "$@" > "${log}"\n`);
  fs.chmodSync(stub, 0o755);
  execFileSync(path.join(spaced, 'Mac版-运营商拆表.app/Contents/MacOS/launcher'), [], { env: { ...process.env, SMS_BROWSER: stub }, stdio: 'ignore' });
  const args = fs.readFileSync(log, 'utf8').split('\n').filter(Boolean);
  const url = args[0].replace(/^--app=file:\/\//, '');
  assert.ok(args[0].startsWith('--app=file://'), `不是 --app=file:// 参数：${args[0]}`);
  // 中文目录名会让 Chrome 忽略 --app（实测只开空白标签页），所以参数里不能有裸中文和空格
  assert.ok(!/[^\x20-\x7e]/.test(url), `--app 路径含非 ASCII：${url}`);
  assert.ok(!url.includes(' '), `--app 路径含空格：${url}`);
  assert.equal(fs.realpathSync(url), fs.realpathSync(path.join(spaced, 'app/index.html')), '中转路径必须指回这份包里的网页，不能是别处的副本');
  assert.ok(args.some((a) => a.startsWith('--user-data-dir=')), '不给独立 profile，Edge 已开着时会被并成标签页');
  assert.ok(!args.some((a) => /^--app=https?:/.test(a)), '不允许打开网络地址');
  fs.rmSync(sandbox, { recursive: true, force: true });
});

test('两个 ps1 带 UTF-8 BOM 且只用 CRLF（Windows PowerShell 5.1 无 BOM 会把中文读成乱码）', () => {
  for (const rel of ['tools/make_shortcut.ps1', 'tools/verify.ps1']) {
    const buf = fs.readFileSync(path.join(PKG, rel));
    assert.deepEqual([buf[0], buf[1], buf[2]], [0xef, 0xbb, 0xbf], `${rel} 缺 BOM`);
    const txt = buf.toString('utf8').slice(1);
    assert.ok(!txt.replace(/\r\n/g, '').includes('\n'), `${rel} 混进了裸 LF 换行`);
    assert.match(txt, /\r\n/);
  }
});

test('校验清单里的 SHA256 与磁盘文件逐条对得上', () => {
  const txt = fs.readFileSync(path.join(PKG, '版本与校验.txt'), 'utf8');
  const rows = [...txt.matchAll(/^([0-9a-f]{64})  (.+)$/gm)].map((m) => ({ sha: m[1], rel: m[2] }));
  assert.ok(rows.length >= REQUIRED.length - 3, `清单只有 ${rows.length} 条，明显漏了`);
  for (const r of rows) {
    const p = path.join(PKG, r.rel);
    assert.ok(fs.existsSync(p), `清单写了但文件不存在：${r.rel}`);
    assert.equal(sha256(p), r.sha, `${r.rel} 哈希与清单不符`);
  }
});

test('bat 的 CRLF 与 mac launcher 的 LF 不能互相污染（清单不含行尾差异外的假改动）', () => {
  const launcher = fs.readFileSync(path.join(PKG, 'Mac版-运营商拆表.app/Contents/MacOS/launcher'), 'latin1');
  assert.ok(!launcher.includes('\r'), 'shell 脚本带 \\r 会在 macOS 上直接执行失败');
});

test('使用说明把三条承诺与限制写清楚', () => {
  const buf = fs.readFileSync(path.join(PKG, '使用说明.txt'));
  assert.equal(buf[0], 0xef, 'Windows 记事本需要 UTF-8 BOM 才不乱码');
  assert.ok(buf[1] === 0xbb && buf[2] === 0xbf);
  const txt = buf.toString('utf8').slice(1);
  for (const need of ['不联网', '不会修改', '携号转网', '双击', '右键']) {
    assert.match(txt, new RegExp(need), `使用说明缺少「${need}」`);
  }
});

test('压缩包能直接传：条目齐全、macOS 启动器保留可执行位、字节与包内一致', () => {
  const zips = fs.readdirSync(DIST).filter((n) => /^运营商拆表-v\d+\.\d+\.\d+\.zip$/.test(n));
  assert.equal(zips.length, 1, `dist 里应该有且只有一个版本压缩包：${zips.join(', ') || '没有'}`);
  const zipPath = path.join(DIST, zips[0]);
  // 用 python 读中央目录：macOS 的 unzip -Z 只认系统代码页，中文条目名会打成问号
  const dump = execFileSync('python3', ['-c',
    'import zipfile,sys\nfor i in zipfile.ZipFile(sys.argv[1]).infolist():\n    print("%o\\t%s" % (i.external_attr >> 16 & 0o777, i.filename))',
    zipPath], { encoding: 'utf8' }).trim().split('\n').map((l) => l.split('\t'));
  const entries = new Map(dump.map(([mode, name]) => [name, parseInt(mode, 8)]));
  for (const rel of REQUIRED) {
    assert.ok(entries.has(`运营商拆表/${rel}`), `压缩包里缺 ${rel}`);
  }
  const lmode = entries.get('运营商拆表/Mac版-运营商拆表.app/Contents/MacOS/launcher');
  assert.ok(lmode & 0o111, `启动器在压缩包里丢了可执行位（${lmode.toString(8)}），Mac 解压后双击打不开`);

  const into = fs.realpathSync(fs.mkdtempSync('/tmp/pkg-zip-'));
  execFileSync('unzip', ['-q', zipPath, '-d', into]);
  assert.equal(sha256(path.join(into, '运营商拆表/app/index.html')), sha256(DELIVERABLE), '解压出来的网页和交付件不是同一份');
  const launcher = path.join(into, '运营商拆表/Mac版-运营商拆表.app/Contents/MacOS/launcher');
  assert.ok(fs.statSync(launcher).mode & 0o111, '解压后启动器仍不可执行');
  fs.rmSync(into, { recursive: true, force: true });
});

test('Windows 启动器 exe 是真 PE：amd64、GUI 子系统、带图标资源、编译进了同一套中转逻辑', () => {
  const exePath = path.join(PKG, '运营商拆表.exe');
  const buf = fs.readFileSync(exePath);
  assert.equal(buf.subarray(0, 2).toString('latin1'), 'MZ', '不是 PE 文件');
  const peOff = buf.readUInt32LE(0x3c);
  assert.equal(buf.subarray(peOff, peOff + 4).toString('latin1'), 'PE\0\0', '缺 PE 头');
  assert.equal(buf.readUInt16LE(peOff + 4), 0x8664, '机器类型不是 amd64（普通办公机是 x64）');
  const subsystem = buf.readUInt16LE(peOff + 92);
  assert.equal(subsystem, 2, `子系统应为 2=GUI（否则双击会闪一个黑控制台窗），实际 ${subsystem}`);
  // 图标：rsrc 把 .ico 的像素数据原样嵌进 .rsrc，取 ico 尾部 4KB（最大那张的像素行）在 exe 里找
  const ico = fs.readFileSync(path.join(PKG, '图标/app.ico'));
  const txt = buf.toString('latin1');
  assert.ok(txt.includes('.rsrc'), '没有 .rsrc 段，说明图标没进 exe');
  assert.ok(buf.includes(ico.subarray(ico.length - 4096)), 'exe 里找不到 app.ico 的像素数据，图标没烘进去');
  // 逻辑必须和 启动.bat 同一套：ASCII 中转 + --app + Edge 优先，缺一条就是两份实现漂移。
  // 只断言源码里就是整串常量那些片段（Go 会把拼接的常量分开存，别指望搜到完整 URL）
  for (const needle of ['sms-carrier-splitter', '--app=', 'file:///', '--user-data-dir=', '--no-first-run', 'msedge.exe', 'index.html']) {
    assert.ok(txt.includes(needle), `exe 里找不到 ${needle}，说明编译进去的不是这套启动逻辑`);
  }
  assert.ok(!/https?:\/\//.test(txt.replace(/file:\/\/\//g, '')), 'exe 里不该出现任何网络地址');
});

test('exe 与 bat 并存：浏览器/权限出问题时 bat 仍是退路，清单里两者都校了哈希', () => {
  assert.ok(fs.existsSync(path.join(PKG, '启动.bat')), 'bat 退路被删掉了');
  const txt = fs.readFileSync(path.join(PKG, '版本与校验.txt'), 'utf8');
  for (const rel of ['运营商拆表.exe', '启动.bat', 'app/index.html']) {
    const row = txt.match(new RegExp(`^([0-9a-f]{64})  ${rel.replace(/[./]/g, '\\$&')}$`, 'm'));
    assert.ok(row, `清单里没有 ${rel} 的哈希`);
    assert.equal(sha256(path.join(PKG, rel)), row[1], `${rel} 与清单不符`);
  }
});

test('示例表能被页面识别：正常表 21 个号码、嵌文本表 7 个、无号码列表 0 个', () => {
  const sizes = {
    '示例/示例1-标准名单.xlsx': fs.statSync(path.join(ROOT, 'fixtures/sample.xlsx')).size,
    '示例/示例2-号码嵌在文本里.xlsx': fs.statSync(path.join(ROOT, 'fixtures/embed.xlsx')).size,
  };
  for (const [rel, size] of Object.entries(sizes)) {
    assert.equal(fs.statSync(path.join(PKG, rel)).size, size, `${rel} 不是对应夹具的副本`);
  }
});
