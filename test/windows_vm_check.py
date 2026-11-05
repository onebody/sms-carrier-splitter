#!/usr/bin/env python3
# 在 Windows 客户机（Parallels Win11）里跑：真 Edge、真下载目录
# 目的：证明发布包页面在 Windows 上不只是能打开，而是能跑完业务并真的落盘产物
# 用法：python windows_vm_check.py <包目录> <工作目录>
import base64
import hashlib
import io
import json
import os
import select
import socket
import struct
import subprocess
import sys
import time
import urllib.request
import uuid
import zipfile

PORT = 9348
PKG = os.path.abspath(sys.argv[1])
WORK = os.path.abspath(sys.argv[2])
DL = os.path.join(WORK, 'dl')
OUT = os.path.join(WORK, 'out')
LOG = os.path.join(WORK, 'cdp-check.log')
STAGE = os.path.join(os.environ['PUBLIC'], 'sms-carrier-splitter', 'index.html')
PROFILE = os.path.join(WORK, 'cdp-profile')

checks = []
fails = []


def check(name, ok, detail=''):
    checks.append('%s %s%s' % ('PASS' if ok else 'FAIL', name, (' — ' + str(detail)) if detail else ''))
    if not ok:
        fails.append(name)


def log(line):
    with open(LOG, 'a', encoding='utf-8') as f:
        f.write(line + '\n')


class WS:
    def __init__(self, url):
        hostport, path = url[5:].split('/', 1)
        path = '/' + path
        host, port = hostport.split(':')
        self.s = socket.create_connection((host, int(port)), timeout=15)
        key = base64.b64encode(uuid.uuid4().bytes).decode()
        req = ('GET %s HTTP/1.1\r\nHost: %s\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n'
               'Sec-WebSocket-Key: %s\r\nSec-WebSocket-Version: 13\r\n\r\n' % (path, hostport, key))
        self.s.sendall(req.encode())
        buf = b''
        while b'\r\n\r\n' not in buf:
            buf += self.s.recv(4096)
        head, self.buf = buf.split(b'\r\n\r\n', 1)
        if b'101' not in head.split(b'\r\n')[0]:
            raise RuntimeError('ws handshake: ' + head.decode('latin1')[:120])

    def _exact(self, n):
        while len(self.buf) < n:
            chunk = self.s.recv(65536)
            if not chunk:
                raise ConnectionError('socket closed')
            self.buf += chunk
        out, self.buf = self.buf[:n], self.buf[n:]
        return out

    def send_text(self, text):
        payload = text.encode()
        mask = os.urandom(4)
        head = bytearray([0x81])
        n = len(payload)
        if n < 126:
            head.append(0x80 | n)
        elif n < 65536:
            head += bytes([0x80 | 126]) + struct.pack('>H', n)
        else:
            head += bytes([0x80 | 127]) + struct.pack('>Q', n)
        head += mask
        self.s.sendall(bytes(head) + bytes(b ^ mask[i % 4] for i, b in enumerate(payload)))

    def recv_message(self):
        data = b''
        while True:
            b0, b1 = self._exact(2)
            ln = b1 & 0x7F
            if ln == 126:
                ln = struct.unpack('>H', self._exact(2))[0]
            elif ln == 127:
                ln = struct.unpack('>Q', self._exact(8))[0]
            payload = self._exact(ln)
            op = b0 & 0x0F
            if op == 8:
                raise ConnectionError('server close')
            if op == 9:
                self.s.sendall(bytes([0x8A, 0x80, 0, 0, 0, 0]))
                continue
            if op == 10:
                continue
            data += payload
            if b0 & 0x80:
                return data.decode('utf-8', 'replace')


class CDP:
    def __init__(self, ws):
        self.ws = ws
        self.seq = 0
        self.events = []

    def call(self, method, **params):
        self.seq += 1
        mid = self.seq
        self.ws.send_text(json.dumps({'id': mid, 'method': method, 'params': params}))
        while True:
            msg = json.loads(self.ws.recv_message())
            if msg.get('id') == mid:
                if 'error' in msg:
                    raise RuntimeError('%s %s' % (method, json.dumps(msg['error'])[:200]))
                return msg['result']
            self.events.append(msg)

    def pump(self, seconds):
        end = time.time() + seconds
        while time.time() < end:
            if not select.select([self.ws.s], [], [], 0.2)[0]:
                continue
            try:
                self.events.append(json.loads(self.ws.recv_message()))
            except (ConnectionError, OSError):
                return

    def js(self, expression):
        r = self.call('Runtime.evaluate', expression=expression, returnByValue=True, awaitPromise=True)
        if r.get('exceptionDetails'):
            raise RuntimeError(str(r['exceptionDetails'].get('exception', {}).get('description')
                                or r['exceptionDetails'].get('text'))[:300])
        return r['result'].get('value')


def wait_port(seconds=30):
    end = time.time() + seconds
    while time.time() < end:
        try:
            with urllib.request.urlopen('http://127.0.0.1:%d/json/list' % PORT, timeout=2) as r:
                return json.loads(r.read().decode())
        except Exception:
            time.sleep(0.3)
    raise RuntimeError('调试端口未就绪')


os.makedirs(DL, exist_ok=True)
os.makedirs(OUT, exist_ok=True)
open(LOG, 'w', encoding='utf-8').close()
log('pkg=%s' % PKG)

edge = None
cdp = None
try:
    # 与启动器同样的落地动作：把包内页面复制到纯 ASCII 路径（Chromium 对非 ASCII 的 file:// 会忽略 --app）
    with open(os.path.join(PKG, 'app', 'index.html'), 'rb') as f:
        raw = f.read()
    os.makedirs(os.path.dirname(STAGE), exist_ok=True)
    with open(STAGE, 'wb') as f:
        f.write(raw)
    check('落地页与包内页面逐字节相同',
          hashlib.sha256(raw).hexdigest() == hashlib.sha256(open(STAGE, 'rb').read()).hexdigest(),
          '%d 字节' % len(raw))

    app_url = 'file:///' + STAGE.replace('\\', '/')
    edge = subprocess.Popen(
        [os.path.expandvars(r'%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe'),
         '--app=' + app_url, '--user-data-dir=' + PROFILE, '--no-first-run',
         '--no-default-browser-check', '--remote-debugging-port=%d' % PORT],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    targets = wait_port()
    page = [t for t in targets if t.get('type') == 'page' and t.get('url', '').startswith('file:///')]
    check('Edge 起了一个包内页面的调试目标', len(page) >= 1, page[0]['url'] if page else [t.get('url') for t in targets][:3])
    cdp = CDP(WS(page[0]['webSocketDebuggerUrl']))
    cdp.call('Runtime.enable')
    cdp.call('Page.enable')
    cdp.call('Network.enable')
    cdp.call('Browser.setDownloadBehavior', behavior='allow', downloadPath=DL, eventsEnabled=True)

    # 正面等待：页面要先解析近 1 MB 的内联脚本，__smsApp 是最后一步才挂上去的
    ready = False
    end = time.time() + 25
    while time.time() < end and not ready:
        ready = bool(cdp.js('!!(window.XLSX && window.CarrierDB && window.__smsApp)'))
        if not ready:
            time.sleep(0.3)
    check('引擎就位', ready, cdp.js("XLSX.version + ' / 号段表 ' + CarrierDB.updated"))
    check('地址就是包内落地页（不联网）', cdp.js('location.href') == app_url, cdp.js('location.href')[-48:])

    handle = cdp.call('Runtime.evaluate', expression="document.getElementById('file')")['result']['objectId']

    def load(sample, cond, get):
        p = os.path.join(PKG, '示例', sample)
        cdp.call('DOM.setFileInputFiles', files=[p], objectId=handle)
        cdp.js("document.getElementById('file').dispatchEvent(new Event('change'))")
        end = time.time() + 25
        while time.time() < end and not cdp.js(cond):
            time.sleep(0.2)
        return cdp.js(get)

    s1 = load('示例1-标准名单.xlsx',
              "__smsApp.state.stats && __smsApp.state.stats.total===26",
              "JSON.stringify({total:__smsApp.state.stats.total,valid:__smsApp.state.stats.valid,"
              + "sheets:__smsApp.buildSplitWorkbook().SheetNames.length})")
    check('示例1（标准名单）：26 行 / 21 有效 / 去重后 8 张 sheet',
          json.loads(s1) == {'total': 26, 'valid': 21, 'sheets': 8}, s1)

    before = set(os.listdir(DL))
    cdp.js("document.getElementById('btnSplit').click()")
    split_file = None
    end = time.time() + 25
    while time.time() < end and not split_file:
        new = [n for n in set(os.listdir(DL)) - before if n.endswith('.xlsx')]
        if new:
            split_file = new[0]
        time.sleep(0.3)
    check('点「下载拆分结果」真的在 Windows 落盘', bool(split_file), split_file or '下载目录无新 xlsx')
    if split_file:
        src = os.path.join(DL, split_file)
        while os.path.exists(src + '.crdownload'):
            time.sleep(0.3)
        data = open(src, 'rb').read()
        zf = zipfile.ZipFile(io.BytesIO(data))
        names = [n for n in zf.namelist() if n.startswith('xl/worksheets/')]
        check('落盘产物是合法 xlsx 且含 8 张工作表', len(names) == 8,
              '%d 字节 / %d sheet / sha16=%s' % (len(data), len(names), hashlib.sha256(data).hexdigest()[:16]))
        dst = os.path.join(OUT, 'win_split.xlsx')
        with open(dst, 'wb') as f:
            f.write(data)
        log('saved %s sha256=%s' % (dst, hashlib.sha256(data).hexdigest()))

    before = set(os.listdir(DL))
    cdp.js("document.getElementById('btnOrder').click()")
    order_file = None
    end = time.time() + 25
    while time.time() < end and not order_file:
        new = [n for n in set(os.listdir(DL)) - before if n.endswith('.xlsx')]
        if new:
            order_file = new[0]
        time.sleep(0.3)
    check('点「下载下单清单」真的在 Windows 落盘', bool(order_file), order_file or '下载目录无新 xlsx')
    if order_file:
        data = open(os.path.join(DL, order_file), 'rb').read()
        with open(os.path.join(OUT, 'win_order.xlsx'), 'wb') as f:
            f.write(data)
        log('saved win_order.xlsx sha256=%s' % hashlib.sha256(data).hexdigest())

    s2 = load('示例2-号码嵌在文本里.xlsx',
              "__smsApp.state.stats && __smsApp.state.stats.total===9",
              "JSON.stringify({extract:document.getElementById('extract').checked,"
              + "n:__smsApp.state.stats.extracted,valid:__smsApp.state.stats.valid})")
    j = json.loads(s2)
    check('示例2（号码嵌文本）自动提取 7 个', j.get('extract') is True and j.get('n') == 7, s2)

    s3 = load('示例3-没有号码列.xlsx',
              "__smsApp.state.lastFile==='示例3-没有号码列.xlsx'",
              "document.getElementById('msg').className + '|' + __smsApp.state.stats.valid")
    check('示例3（没有号码列）给黄色提示而不是崩', 'warn|0' in s3, s3)

    cdp.pump(1.5)
    external = [e['params']['request']['url'] for e in cdp.events
                if e.get('method') == 'Network.requestWillBeSent'
                and not e['params']['request']['url'].startswith(('file://', 'data:', 'chrome://',
                                                                   'chrome-extension://', 'devtools://', 'edge://'))]
    check('整轮没有发出任何非 file:// 请求', len(external) == 0, ' | '.join(external)[:200] or '0 条')
    errs = [json.dumps(e['params']).encode('utf-8', 'replace')[:200].decode('utf-8', 'replace')
            for e in cdp.events if e.get('method') == 'Runtime.exceptionThrown']
    check('全程无 JS 未捕获异常', len(errs) == 0, ' | '.join(errs)[:300] or '无')
except Exception as exc:
    fails.append('脚本异常')
    checks.append('ERROR %r' % (exc,))
finally:
    for line in checks:
        log(line)
    log('未通过：%s' % ('、'.join(fails) if fails else '无'))
    if cdp:
        try:
            cdp.call('Browser.close')
        except Exception:
            pass
    if edge and edge.poll() is None:
        subprocess.call(['taskkill', '/F', '/T', '/PID', str(edge.pid)],
                        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    sys.exit(1 if fails else 0)
