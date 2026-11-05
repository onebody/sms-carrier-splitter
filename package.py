#!/usr/bin/env python3
"""把单文件网页打包成「拷走即用」的桌面应用包。

Windows：启动.bat 找 Edge/Chrome，用 --app 开一个没有地址栏的独立窗口。
macOS ：Mac版-运营商拆表.app 里的 sh 启动器做同样的事，找不到浏览器就退回默认浏览器。
全程 file:// 本地打开，不引入任何网络地址；源网页字节不改。
"""
from __future__ import annotations

import argparse
import datetime
import hashlib
import os
import pathlib
import re
import shutil
import subprocess
import sys
import time
import zipfile

ROOT = pathlib.Path(__file__).resolve().parent
APP_NAME = "运营商拆表"
HTML_NAME = "号码运营商分类与拆表.html"
VERSION = "1.1.0"

# .bat 只能出现 ASCII：cmd 按系统代码页解码批处理文本，UTF-8 中文会变乱码并截断命令。
# 源路径一律从 %~dp0 取，所以整个文件夹放哪、叫什么（含中文）都能跑。
LAUNCH_BAT = r"""@echo off
setlocal
rem Offline launcher for the carrier-splitter tool (Windows 10/11).
rem Keep every byte of this file pure ASCII: cmd decodes .bat with the system codepage.
set "SRC=%~dp0app\index.html"
if not exist "%SRC%" (
  echo [X] app\index.html is missing beside this launcher.
  echo     Copy the whole folder, not only the .bat.
  pause
  exit /b 1
)

rem Chrome/Edge silently ignore --app when the file:// path contains non-ASCII
rem characters, which happens as soon as the folder is named in Chinese. A copy at
rem a fixed ASCII path (C:\Users\Public, same on every locale) keeps the app window.
set "STAGE=%PUBLIC%\sms-carrier-splitter"
if not exist "%STAGE%" mkdir "%STAGE%" 2>nul
copy /Y "%SRC%" "%STAGE%\index.html" >nul 2>nul
if errorlevel 1 goto fallback
set "P=%STAGE%\index.html"

rem Optional: set SMS_BROWSER=D:\portable\chrome.exe to use your own browser build.
call :try "%SMS_BROWSER%"
call :try "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
call :try "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"
call :try "%ProgramFiles%\Google\Chrome\Application\chrome.exe"
call :try "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
call :try "%LocalAppData%\Google\Chrome\Application\chrome.exe"

if not defined BROWSER goto fallback

set "P=%P:\=/%"
set "PROFILE=%LOCALAPPDATA%\sms-carrier-splitter\profile"
start "" "%BROWSER%" --app="file:///%P%" "--user-data-dir=%PROFILE%" --no-first-run --no-default-browser-check
exit /b 0

:fallback
echo [!] No app window this time (no Edge/Chrome found, or C:\Users\Public is not writable).
echo     Opening with the default browser instead - it is a normal tab, same page, still offline.
start "" "%SRC%"
pause
exit /b 0

:try
if defined BROWSER exit /b 0
if "%~1"=="" exit /b 0
if exist "%~1" set "BROWSER=%~1"
exit /b 0
"""

RUN_BAT = """@echo off
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\\{script}"
pause
"""

SHORTCUT_PS1 = r"""# 在桌面 + 开始菜单创建「运营商拆表」快捷方式（带图标，任务栏显示为独立应用）
$ErrorActionPreference = 'Stop'
$dir = Split-Path -Parent $PSScriptRoot
$exe = Join-Path $dir '运营商拆表.exe'
$bat = Join-Path $dir '启动.bat'
$ico = Join-Path $dir '图标\app.ico'
if (Test-Path -LiteralPath $exe) { $target = $exe }
elseif (Test-Path -LiteralPath $bat) { $target = $bat }
else { Write-Host "既没有 运营商拆表.exe 也没有 启动.bat：$dir"; exit 1 }
$shell = New-Object -ComObject WScript.Shell
$targets = @([Environment]::GetFolderPath('Desktop'), (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'))
foreach ($t in $targets) {
    if (-not (Test-Path -LiteralPath $t)) { continue }
    $lnk = $shell.CreateShortcut((Join-Path $t '运营商拆表.lnk'))
    $lnk.TargetPath = $target
    $lnk.WorkingDirectory = $dir
    if (Test-Path -LiteralPath $ico) { $lnk.IconLocation = "$ico,0" }
    $lnk.Description = '手机号运营商分类 / 拆表 / 下单清单（离线，数据不出本机）'
    $lnk.Save()
    Write-Host "已创建：$t\运营商拆表.lnk（指向 $(Split-Path -Leaf $target)）"
}
Write-Host '以后从快捷方式打开即可；删掉快捷方式不影响本文件夹。'
"""

VERIFY_PS1 = r"""# 逐条核对 版本与校验.txt 里的 SHA256，确认包内文件没有被动过
$ErrorActionPreference = 'Stop'
$dir = Split-Path -Parent $PSScriptRoot
$list = Get-Content -LiteralPath (Join-Path $dir '版本与校验.txt') -Encoding UTF8
$bad = 0; $n = 0
foreach ($line in $list) {
    if ($line -notmatch '^([0-9a-f]{64})  (.+)$') { continue }
    $n++
    $rel = $Matches[2]; $want = $Matches[1]
    $p = Join-Path $dir $rel
    if (-not (Test-Path -LiteralPath $p)) { Write-Host "[缺失] $rel"; $bad++; continue }
    $got = (Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash.ToLower()
    if ($got -ne $want) { Write-Host "[被改动] $rel"; $bad++ } else { Write-Host "[OK] $rel" }
}
Write-Host ''
if ($bad -eq 0) { Write-Host "校验通过：$n 个文件与清单一致。" } else { Write-Host "发现 $bad / $n 个不一致，请勿使用该包。" }
"""

MAC_LAUNCHER = """#!/bin/sh
# 离线启动器（macOS）：用 Chrome/Edge 的 --app 开独立窗口；都没有时退回默认浏览器。
# 本文件必须保持 LF 换行，带上 \\r（回车）会在这里直接执行失败。
HERE=$(CDPATH= cd -- "$(dirname -- "$0")/../../.." && pwd)
HTML="$HERE/app/index.html"
[ -f "$HTML" ] || {
    osascript -e 'display alert "缺少 app/index.html" message "请把整个「运营商拆表」文件夹一起拷贝，不要只拷 .app。"' 2>/dev/null
    echo "找不到 app/index.html（请把整个文件夹一起拷贝）"; exit 1; }
PROFILE="$HOME/Library/Application Support/sms-carrier-splitter/profile"

pick() {
    if [ -n "$SMS_BROWSER" ]; then printf '%s' "$SMS_BROWSER"; return 0; fi
    for b in "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \\
             "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"; do
        [ -x "$b" ] && { printf '%s' "$b"; return 0; }
    done
    return 1
}

# 实测：--app 的 file:// URL 里带非 ASCII 字符（比如「下载」「运营商拆表」这种目录名）
# 会被 Chrome 整个忽略，只弹一个空白新标签页。用一条 ASCII 软链指回包内文件绕过。
stage() {
    S="/tmp/sms-carrier-$(id -u)"
    mkdir -p "$S" 2>/dev/null && chmod 700 "$S" 2>/dev/null || return 1
    ln -sf "$HTML" "$S/index.html" 2>/dev/null || return 1
    [ -r "$S/index.html" ] || return 1
    printf '%s' "$S/index.html"
}

if TARGET=$(stage) && BROWSER=$(pick); then
    [ -d "$PROFILE" ] || mkdir -p "$PROFILE"
    # 用 exec：启动器进程就此变成浏览器进程，窗口关 → .app 自动退出（Dock 不会留僵尸图标）
    exec "$BROWSER" --app="file://$TARGET" --user-data-dir="$PROFILE" --no-first-run --no-default-browser-check
fi
# /tmp 建不出软链，或本机没有 Chrome/Edge：默认浏览器开包内网页，同样是本地、不联网
exec open "$HTML"
"""

INFO_PLIST = """<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleName</key><string>运营商拆表</string>
    <key>CFBundleDisplayName</key><string>运营商拆表</string>
    <key>CFBundleExecutable</key><string>launcher</string>
    <key>CFBundleIdentifier</key><string>local.offline.sms-carrier-splitter</string>
    <key>CFBundleIconFile</key><string>icon.icns</string>
    <key>CFBundlePackageType</key><string>APPL</string>
    <key>CFBundleShortVersionString</key><string>{version}</string>
    <key>CFBundleVersion</key><string>{version}</string>
    <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
"""

README = """运营商拆表 · 使用说明（版本 {version}）
════════════════════════════════════════════════════════════

一、这是什么
  把一份含手机号的 Excel/CSV 按运营商分类、加一列标注、按三大或四大运营商拆成不同
  sheet，并生成给运营商的下单清单。全程在你这台电脑上跑。

二、怎么打开（三选一）
  1) Windows：双击「运营商拆表.exe」→ 弹出没有地址栏的独立窗口，就是本工具。
     没有 exe 或它被公司策略拦了，就双击「启动.bat」，效果完全一样。
  2) Windows：双击「制作桌面快捷方式.bat」→ 桌面与开始菜单各生成一个「运营商拆表」
     图标，以后直接点快捷方式。想撤销就删掉那两个 .lnk，本文件夹不用动。
  3) macOS：双击「Mac版-运营商拆表.app」。
     第一次若提示「无法验证开发者／已损坏」：右键该图标 → 打开 → 再点一次打开。
  从微信/网盘下载后第一次打开，Windows 可能弹蓝色 SmartScreen「Windows 已保护你的电脑」：
  点「更多信息」→「仍要运行」；macOS 的提示按上面右键处理。exe 和 bat 都没有代码签名
  （签名要买证书并绑定发布者主体），提示属正常，可用「校验文件完整性.bat」核对文件没被动过。
  个别公司的终端安全软件会直接禁止未签名 exe 运行——那就用「启动.bat」，功能一致。
  上面两条 Windows 路径都在真实的 Windows 11 + Edge 上实测过：双击后直接出无边框窗口，
  导出的两个 xlsx 落在系统「下载」文件夹；文件名、sheet 数与内容都和 macOS 上一致。
  浏览器装在非默认位置（便携版 Chrome/Edge）？先设环境变量再启动：
     Windows  set SMS_BROWSER=D:\\portable\\chrome.exe
     macOS    export SMS_BROWSER="/path/to/Google Chrome"   （指到可执行文件本身）

三、怎么用
  1) 把 .xlsx / .xls / .csv 拖进页面虚线框（或点「选择文件」）。
  2) 页面自动挑好工作表、号码列、表头行；挑错了自己在下拉里改。
  3) 选「四大 / 三大运营商」拆分方式，按需勾选：
     · 号码列归一化为 11 位 —— 去掉 +86、空格、连字符，Excel 里不再变科学计数
     · 拆分时去重（默认开）—— 每张 sheet 只留首次出现的行，重复行单列「重复号码」
     · 从文本中提取号码 —— 号码夹在整句里（如「手机 138…，备用 139…」）时，
       在原文列右侧新增「提取号码」列，一格两个号自动拆成两行；身份证/座机不会误命中
  4) 在下单页填各运营商单价 → 「下载拆分结果」/「下载下单清单」。
  5) 先拿「示例」文件夹里的三张表试一遍，心里有数再上真实数据。

四、三条承诺
  · 不联网：页面里没有任何网络请求，断网机、内网机照常用，数据不出本机。
  · 不会修改你的源文件：只读取，结果一律另存为新文件，原有列与列序保持不动。
  · 可核对：本包每个文件的 SHA256 都写在「版本与校验.txt」，双击
    「校验文件完整性.bat」逐条比对；换机器、被改动都能查出来。

五、已知限制（重要，请转告同事）
  · 归属按工信部号段核发公告判断，**携号转网后的号码仍按原号段归类**，
    与该机当前实际服务商可能不一致；批量下单前建议向运营商索取携转名单。
  · 144/148/145 等物联网、上网卡号段，以及 165/167/170x 等虚商转售号段，
    会在备注列写明；下单页的「发送条数」默认取去重后的号码数。
  · 号段表版本见页脚（{seg_updated}）。新号段核发后需要更新号段表才能识别。
  · 一次只读一个 sheet 的一个号码列；多个号码列请分次处理。
  · .xls / .ods 由内置引擎解析，公式类工作簿只取已算出的值。
  · 打开用的是本机已有的 Edge/Chrome（只是窗口模式不同），不额外装任何东西。

六、文件结构
  运营商拆表.exe             Windows 启动器（Go 交叉编译，图标已烘进文件，双击不闪黑框）
  启动.bat                   Windows 启动器备用（同上，纯 ASCII 文本，避免 cmd 代码页乱码）
  app\\index.html          真正的程序，单文件离线网页（也可直接拖进浏览器）
  制作桌面快捷方式.bat      生成带图标的 .lnk（桌面 + 开始菜单）
  校验文件完整性.bat        比对下方清单里的 SHA256
  Mac版-运营商拆表.app      macOS 启动器（内部是个 sh，同样调 Chrome/Edge）
  tools\\*.ps1             上面两个 bat 调用的 PowerShell 脚本
  图标\\                   icon-1024.png / app.ico / icon.icns
  示例\\                   三张练习表：标准名单 / 号码嵌在文本里 / 没有号码列
  版本与校验.txt           版本、引擎版本、每个文件的 SHA256

七、拷给别人或放共享盘
  · 整个「{pkg}」文件夹一起拷，不能只拷 .bat。
  · 发同事时直接发旁边的「{pkg}-v{version}.zip」（本包里已带）：对方解压得到一个同名
    文件夹，双击里面的「启动.bat」就行；压缩包保留了 Mac 启动器的可执行权限。
    自己重新压也可以，但别用会丢权限的老式工具直接拷 U 盘（FAT32/exFAT 不带 unix
    权限），放到 Mac 上打不开时把 zip 重拷一次即可。
  · 为什么窗口打开的不是本文件夹里那份网页：Chrome/Edge 遇到路径里有中文（比如放在
    「下载」或「运营商拆表」文件夹里）会直接丢掉无边框窗口，只剩一个空白标签页。
    启动器因此把网页搬到一条全英文的固定路径上再打开：
       Windows  复制一份到 C:\\Users\\Public\\sms-carrier-splitter\\index.html（每次启动都覆盖）
       macOS    在 /tmp/sms-carrier-你的UID/ 建一条软链指回包内网页（不含任何数据）
    这两处随时可以删，下次启动自动重建；你的号码表一个字节都不会写到那里。
  · 首次使用会在本机生成窗口数据目录，只存你填过的单价：
     Windows  %LOCALAPPDATA%\\sms-carrier-splitter\\profile
     macOS    ~/Library/Application Support/sms-carrier-splitter/profile
    删掉它程序照常，只是单价恢复空白。你的号码数据从头到尾不落在这里。

"""

# iconutil 要的 iconset 命名（同一个像素尺寸可以顶两个名字）
ICONS = [
    ("icon_16x16.png", 16), ("icon_16x16@2x.png", 32),
    ("icon_32x32.png", 32), ("icon_32x32@2x.png", 64),
    ("icon_128x128.png", 128), ("icon_128x128@2x.png", 256),
    ("icon_256x256.png", 256), ("icon_256x256@2x.png", 512),
    ("icon_512x512.png", 512), ("icon_512x512@2x.png", 1024),
]

SAMPLES = {
    "示例/示例1-标准名单.xlsx": "fixtures/sample.xlsx",
    "示例/示例2-号码嵌在文本里.xlsx": "fixtures/embed.xlsx",
    "示例/示例3-没有号码列.xlsx": "fixtures/no_phone.xlsx",
}


def sha256(p: pathlib.Path) -> str:
    return hashlib.sha256(p.read_bytes()).hexdigest()


def write(path: pathlib.Path, text: str, *, crlf: bool = False, bom: bool = False, mode: int | None = None) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    data = text.encode("utf-8")
    if bom:
        data = b"\xef\xbb\xbf" + data
    if crlf:
        data = data.replace(b"\r\n", b"\n").replace(b"\n", b"\r\n")
    path.write_bytes(data)
    if mode is not None:
        path.chmod(mode)


def make_icons(src_png: pathlib.Path, pkg: pathlib.Path) -> None:
    from PIL import Image

    icon_dir = pkg / "图标"
    icon_dir.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(src_png, icon_dir / "icon-1024.png")
    im = Image.open(src_png).convert("RGBA")
    im.save(icon_dir / "app.ico", sizes=[(s, s) for s in (16, 32, 48, 64, 128, 256)])

    # .icns 只能由 iconutil 从标准命名的 iconset 目录生成（目录名必须以 .iconset 结尾）
    iconset = pathlib.Path("/tmp/sms-carrier.iconset")
    shutil.rmtree(iconset, ignore_errors=True)
    iconset.mkdir(parents=True)
    cache: dict[int, pathlib.Path] = {}
    for name, px in ICONS:
        if px not in cache:
            out = iconset / f"_{px}.png"
            im.resize((px, px), Image.LANCZOS).save(out)
            cache[px] = out
        shutil.copyfile(cache[px], iconset / name)
    for p in cache.values():
        p.unlink()
    subprocess.run(["iconutil", "-c", "icns", str(iconset), "-o", str(icon_dir / "icon.icns")], check=True)
    shutil.rmtree(iconset, ignore_errors=True)


def build_exe(pkg: pathlib.Path) -> pathlib.Path | None:
    """交叉编译 Windows 启动器 exe（图标烘进 PE 资源，双击不闪控制台）。

    纯标准库，所以本机离线就能编；缺 go 或 rsrc 时返回 None，由 启动.bat 兜底。
    """
    go = shutil.which("go")
    rsrc = shutil.which("rsrc") or shutil.which("rsrc", path=str(pathlib.Path.home() / "go/bin"))
    if not go or not rsrc:
        return None
    src = ROOT / "launcher"
    syso = src / "icon.syso"
    subprocess.run([rsrc, "-ico", str(pkg / "图标/app.ico"), "-o", str(syso)], check=True, capture_output=True)
    try:
        env = {**os.environ, "GOOS": "windows", "GOARCH": "amd64", "CGO_ENABLED": "0", "GOFLAGS": "-trimpath"}
        subprocess.run([go, "build", "-ldflags", "-H=windowsgui -s -w",
                        "-o", str(pkg / f"{APP_NAME}.exe"), "."],
                       cwd=src, check=True, env=env, capture_output=True)
    finally:
        syso.unlink(missing_ok=True)
    return pkg / f"{APP_NAME}.exe"


def build(out_dir: pathlib.Path, deliverable: pathlib.Path, icon: pathlib.Path, *, with_exe: bool = True) -> pathlib.Path:
    pkg = out_dir / APP_NAME
    if pkg.exists():
        shutil.rmtree(pkg)
    (pkg / "app").mkdir(parents=True)

    html = deliverable.read_text(encoding="utf-8")
    xlsx_ver = re.search(r'version="(\d+\.\d+\.\d+)"', html)
    seg_ver = re.search(r"updated: '([^']+)'", (ROOT / "src/segment.js").read_text(encoding="utf-8"))
    seg_updated = seg_ver.group(1) if seg_ver else "未标注"

    shutil.copyfile(deliverable, pkg / "app/index.html")
    write(pkg / "启动.bat", LAUNCH_BAT, crlf=True)
    write(pkg / "制作桌面快捷方式.bat", RUN_BAT.format(script="make_shortcut.ps1"), crlf=True)
    write(pkg / "校验文件完整性.bat", RUN_BAT.format(script="verify.ps1"), crlf=True)
    write(pkg / "tools/make_shortcut.ps1", SHORTCUT_PS1, crlf=True, bom=True)
    write(pkg / "tools/verify.ps1", VERIFY_PS1, crlf=True, bom=True)
    write(pkg / "使用说明.txt", README.format(version=VERSION, pkg=APP_NAME, seg_updated=seg_updated), bom=True)

    appdir = pkg / f"Mac版-{APP_NAME}.app"
    write(appdir / "Contents/Info.plist", INFO_PLIST.format(version=VERSION))
    write(appdir / "Contents/MacOS/launcher", MAC_LAUNCHER, mode=0o755)
    make_icons(icon, pkg)
    (appdir / "Contents/Resources").mkdir(parents=True, exist_ok=True)
    shutil.copyfile(pkg / "图标/icon.icns", appdir / "Contents/Resources/icon.icns")

    if with_exe and build_exe(pkg) is None:
        print("提示：本机没有 go 或 rsrc，跳过 Windows exe；包里的 启动.bat 功能相同。", file=sys.stderr)

    for rel, src in SAMPLES.items():
        (pkg / rel).parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(ROOT / src, pkg / rel)

    rows = [f"{sha256(p)}  {p.relative_to(pkg).as_posix()}" for p in sorted(pkg.rglob("*")) if p.is_file()]
    head = [
        f"{APP_NAME} · 版本 {VERSION}",
        f"构建时间 {datetime.datetime.now().strftime('%Y-%m-%d %H:%M')}",
        f"网页引擎 SheetJS {xlsx_ver.group(1) if xlsx_ver else '未标注'} ｜ 号段表 {seg_updated}",
        "核对：Windows 双击「校验文件完整性.bat」；命令行也可 sha256sum -c 下面这段（先去掉 # 行）",
        "",
        "# sha256  相对路径",
    ]
    write(pkg / "版本与校验.txt", "\n".join(head + rows) + "\n")
    return pkg


def make_zip(pkg: pathlib.Path) -> pathlib.Path:
    """压成可直接微信/网盘发送的 zip。

    权限位要自己写进 external_attr：zipfile 默认按 ZipInfo 建条目，不带上 unix mode
    的话 Mac 同事解压出来启动器不可执行，双击只会提示无法打开。
    """
    zpath = pkg.parent / f"{APP_NAME}-v{VERSION}.zip"
    with zipfile.ZipFile(zpath, "w", zipfile.ZIP_DEFLATED) as zf:
        for p in sorted(pkg.rglob("*")):
            if not p.is_file():
                continue
            info = zipfile.ZipInfo(f"{APP_NAME}/{p.relative_to(pkg).as_posix()}",
                                   date_time=time.localtime(p.stat().st_mtime)[:6])
            info.external_attr = (0o755 if p.stat().st_mode & 0o111 else 0o644) << 16
            info.compress_type = zipfile.ZIP_DEFLATED
            zf.writestr(info, p.read_bytes())
    return zpath


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=str(ROOT / "dist"))
    ap.add_argument("--html", default=str(ROOT / HTML_NAME))
    ap.add_argument("--icon", default=None)
    ap.add_argument("--no-zip", action="store_true", help="只出文件夹，不压 zip")
    ap.add_argument("--no-exe", action="store_true", help="不交叉编译 Windows exe（包里的 启动.bat 功能相同）")
    a = ap.parse_args()
    deliverable = pathlib.Path(a.html)
    if not deliverable.exists():
        print(f"找不到单文件网页 {deliverable}，先运行 python3 build.py", file=sys.stderr)
        return 2
    icon = pathlib.Path(a.icon) if a.icon else sorted((ROOT / "vibe_images").glob("carrier-split-app-icon_*.png"))[-1]
    if not icon.exists():
        print("缺少应用图标 png（先生成图标或传 --icon）", file=sys.stderr)
        return 2
    pkg = build(pathlib.Path(a.out), deliverable, icon, with_exe=not a.no_exe)
    files = [f for f in pkg.rglob("*") if f.is_file()]
    total = sum(f.stat().st_size for f in files)
    zpath = make_zip(pkg) if not a.no_zip else None
    print(f"已打包 {pkg}（{total / 1024 / 1024:.1f} MB，{len(files)} 个文件）")
    if zpath:
        print(f"已压缩 {zpath}（{zpath.stat().st_size / 1024 / 1024:.1f} MB，可直接发送）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
