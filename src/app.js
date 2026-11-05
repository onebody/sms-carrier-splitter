(() => {
  const $ = (id) => document.getElementById(id);
  const el = {};
  const IDS = ['drop', 'file', 'sheetSel', 'colSel', 'noHeader', 'normNum', 'dedupe', 'extract', 'modeFour', 'modeThree', 'btnFile', 'btnSplit', 'btnOrder', 'btnPrint', 'btnCopy',
    'result', 'opts', 'cards', 'orderWrap', 'previewWrap', 'msg', 'fileName', 'segNote'];

  const CARRIERS = ['中国移动', '中国联通', '中国电信', '中国广电'];
  const LS_PRICE = 'sms_carrier_splitter.prices';
  const SAMPLE = 300;

  const state = { wb: null, perSheet: [], aoa: [], headerRow: -1, header: null, col: 0, rows: [], stats: null, lastFile: '', autoAsked: '' };
  let prices = {};
  try { prices = JSON.parse(localStorage.getItem(LS_PRICE) || '{}') || {}; } catch (e) { prices = {}; }

  IDS.forEach((id) => { el[id] = $(id); });

  function msg(text, kind) {
    if (!text) { el.msg.hidden = true; return; }
    el.msg.textContent = text;
    el.msg.className = 'msg ' + (kind || 'info');
    el.msg.hidden = false;
  }

  const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
  const cellText = (v) => (v === null || v === undefined ? '' : String(v));
  const hex = (b) => (b === undefined ? '00' : b.toString(16).padStart(2, '0'));
  const width = (aoa) => aoa.reduce((m, r) => Math.max(m, r.length), 0);
  const uniqTotal = () => CARRIERS.reduce((a, c) => a + (state.stats && state.stats.by[c] ? state.stats.by[c].unique : 0), 0);
  const mode = () => (el.modeFour.checked ? 'four' : 'three');
  const dedupeOn = () => el.dedupe.checked;
  const extractOn = () => el.extract.checked;
  // 提取列插在号码列右侧，导出与预览都按这个列位算
  const phoneOutCol = () => (extractOn() ? state.col + 1 : state.col);
  const virtualTotal = () => CARRIERS.reduce((a, c) => a + (state.stats && state.stats.by[c] ? state.stats.by[c].virtual : 0), 0);

  // ---------- 读取与列识别 ----------
  async function readFile(file) {
    const buf = new Uint8Array(await file.arrayBuffer());
    const isZip = buf[0] === 0x50 && buf[1] === 0x4b;
    const isOle = buf[0] === 0xd0 && buf[1] === 0xcf;
    if (isZip || isOle) return { wb: XLSX.read(buf, { type: 'array' }), enc: '二进制工作簿' };
    const ext = (file.name.match(/\.(\w+)$/) || [, ''])[1].toLowerCase();
    if (['xlsx', 'xlsm', 'xls', 'ods'].includes(ext)) {
      throw new Error(`扩展名 .${ext} 但内容不是工作簿（前两字节 0x${hex(buf[0])} 0x${hex(buf[1])}）`);
    }
    let text, enc;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(buf); enc = 'UTF-8'; }
    catch (e) { text = new TextDecoder('gb18030').decode(buf); enc = 'GBK/GB18030'; }
    return { wb: XLSX.read(text, { type: 'string' }), enc };
  }

  const aoaOf = (ws) => XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', raw: true });
  const KEY_RE = /(手机|电话|号码|联系方式|手机号|msisdn|mobile|phone|tel|contact)/i;

  // 整格号码优先，其次「文本里嵌着号码」，最后才是列名带关键词
  const score = (d) => d.valid * 1e6 + d.hits * 1e3 + (d.keyword ? 1 : 0);

  // valid：整格就是号码的行数；hits：整格不是号码、但里面嵌着号码的个数
  function detectColumn(aoa, headerRow) {
    const from = headerRow + 1;
    const to = Math.min(aoa.length, from + SAMPLE);
    const cols = width(aoa);
    let best = { col: -1, valid: 0, hits: 0, keyword: false };
    for (let c = 0; c < cols; c++) {
      let valid = 0;
      let hits = 0;
      for (let r = from; r < to; r++) {
        if (CarrierDB.classify(aoa[r][c]).valid) valid++;
        else hits += CarrierDB.extract(aoa[r][c]).length;
      }
      const head = headerRow >= 0 ? cellText(aoa[headerRow][c]).trim() : '';
      const keyword = !!head && KEY_RE.test(head);
      const cand = { col: c, valid, hits, keyword };
      if (score(cand) > score(best)) best = cand;
    }
    return score(best) > 0 ? best : { col: -1, valid: 0, hits: 0, keyword: false };
  }

  const phoneIn = (cell) => CarrierDB.classify(cell).valid || CarrierDB.extract(cell).length > 0;

  function findHeaderRow(aoa) {
    const limit = Math.min(aoa.length, 10);
    for (let r = 0; r < limit; r++) {
      if (aoa[r].some((c) => KEY_RE.test(cellText(c)))) {
        const det = detectColumn(aoa, r);
        if (det.valid > 0 || det.hits > 0) return r;
      }
    }
    const det = detectColumn(aoa, -1);
    if (det.valid > 0 || det.hits > 0) {
      for (let r = Math.min(limit, 3) - 1; r >= 0; r--) {
        const cell = aoa[r] && aoa[r][det.col];
        if (cell === '' || cell === null || cell === undefined) continue;
        if (!phoneIn(cell)) return r;
      }
    }
    return -1;
  }

  function loadWorkbook(wb, fileName, enc) {
    state.wb = wb;
    state.lastFile = fileName;
    state.perSheet = wb.SheetNames.map((name) => {
      const aoa = aoaOf(wb.Sheets[name]);
      const headerRow = findHeaderRow(aoa);
      return { name, aoa, headerRow, ...detectColumn(aoa, headerRow) };
    });
    el.sheetSel.innerHTML = '';
    for (const s of state.perSheet) {
      const o = document.createElement('option');
      o.value = s.name;
      o.textContent = `${s.name}（${s.valid ? `识别到 ${s.valid} 个手机号` : s.hits ? `含 ${s.hits} 个内嵌手机号` : '未识别到手机号'}）`;
      el.sheetSel.appendChild(o);
    }
    const best = state.perSheet.slice().sort((a, b) => (b.valid - a.valid) || (b.hits - a.hits))[0];
    el.sheetSel.value = best ? best.name : '';
    useSheet(best ? best.name : state.perSheet[0] && state.perSheet[0].name);
    const read = `已读取 ${fileName}（${enc || '工作簿'}）。源文件不会被修改，结果另存为新文件。`;
    if (best && best.valid > 0) msg(read, 'ok');
    else if (autoExtract(best)) msg(`${read} 该列没有整格号码，但有 ${best ? best.hits : 0} 个号码嵌在文本里，已自动开启「从文本中提取号码」并新增「提取号码」列。`, 'ok');
    else msg('没有识别出 11 位手机号。请在下方手动选择工作表、取消「首行为表头」或换一列。', 'warn');
  }

  // 号码嵌在文本里时主动帮用户打开提取；同一文件+同一张表只提示一次
  function autoExtract(sheet) {
    if (!sheet || !sheet.hits || sheet.valid > 0) return false;
    const key = `${state.lastFile}|${sheet.name}`;
    if (state.autoAsked === key) return el.extract.checked;
    state.autoAsked = key;
    el.extract.checked = true;
    process();
    return true;
  }

  function useSheet(name) {
    const found = state.perSheet.find((s) => s.name === name);
    if (!found) return;
    state.aoa = found.aoa;
    state.headerRow = found.headerRow;
    state.col = found.col >= 0 ? found.col : 0;
    el.noHeader.checked = found.headerRow < 0;
    el.opts.hidden = !state.aoa.length;
    fillColumnSelect();
    el.colSel.value = String(state.col);
    process();
  }

  const headerRowIdx = () => (el.noHeader.checked ? -1 : state.headerRow);

  function fillColumnSelect() {
    const h = headerRowIdx();
    const det = detectColumn(state.aoa, h);
    el.colSel.innerHTML = '';
    for (let c = 0; c < width(state.aoa); c++) {
      const name = h >= 0 ? cellText(state.aoa[h][c]).trim() : '';
      const o = document.createElement('option');
      o.value = String(c);
      o.textContent = `第${c + 1}列${name ? `「${name}」` : ''}${c === det.col ? ' ← 推荐' : ''}`;
      el.colSel.appendChild(o);
    }
  }

  // ---------- 分类 ----------
  function process() {
    const col = Number(el.colSel.value);
    state.col = Number.isFinite(col) && col >= 0 ? col : state.col;
    const h = headerRowIdx();
    state.header = h >= 0 ? state.aoa[h].slice() : null;

    const seen = new Map();
    const rows = [];
    for (let r = h + 1; r < state.aoa.length; r++) {
      const cells = state.aoa[r].slice();
      if (cells.every((c) => c === '' || c === null || c === undefined)) continue;
      const whole = CarrierDB.classify(cells[state.col]);
      // 整格就是号码时不绕道提取；整格不是号码但里面有号码时，一个号码一行
      const found = whole.valid ? [whole.digits] : (extractOn() ? CarrierDB.extract(cells[state.col]) : []);
      const items = found.length ? found : [null];
      const fromText = !whole.valid && found.length > 0;
      items.forEach((digits, i) => {
        const res = digits === null ? whole : CarrierDB.classify(digits);
        let dup = false;
        let note = res.note;
        if (res.valid) {
          if (seen.has(res.digits)) {
            note = `重复号码（第${seen.get(res.digits) + 1}行已出现）`;
            dup = true;
          } else seen.set(res.digits, r);
        }
        const parts = [];
        if (items.length > 1) parts.push(`一格多号·第${i + 1}/${items.length}个`);
        if (note) parts.push(note);
        rows.push({
          srcRow: r, cells, raw: cells[state.col], note: parts.join('；'), dup,
          empty: res.note === '空号码', valid: res.valid, carrier: res.carrier,
          segment: res.segment, digits: res.digits || '', virtual: !!res.virtual, fromText,
        });
      });
    }
    state.rows = rows;
    state.stats = summarize(rows);
    render();
    buildOrder();
  }

  function summarize(rows) {
    const s = { total: rows.length, valid: 0, dup: 0, empty: 0, invalid: 0, extracted: 0, by: {}, unknown: {} };
    for (const c of CARRIERS) s.by[c] = { valid: 0, unique: 0, dup: 0, virtual: 0 };
    for (const r of rows) {
      if (r.fromText) s.extracted++;
      if (r.empty) { s.empty++; continue; }
      if (!r.valid) {
        s.invalid++;
        if (r.note === '未登记号段') s.unknown[r.segment] = (s.unknown[r.segment] || 0) + 1;
        continue;
      }
      s.valid++;
      const b = s.by[r.carrier];
      b.valid++;
      if (r.virtual) b.virtual++;
      if (r.dup) { s.dup++; b.dup++; } else b.unique++;
    }
    return s;
  }

  // ---------- 渲染 ----------
  function render() {
    const s = state.stats;
    el.result.hidden = !s;
    el.fileName.textContent = state.lastFile;
    if (!s) return;
    el.cards.innerHTML = [
      [s.total, '数据行'], [s.valid, '有效手机号'], [uniqTotal(), '去重后'], [s.dup, '重复', s.dup ? 'warn' : ''],
      [s.invalid, '异常/未登记', s.invalid ? 'warn' : ''], [s.empty, '空号码'],
      ...(s.extracted ? [[s.extracted, '从文本提取']] : []),
    ].map(([n, t, k]) => `<div class="card${k ? ' ' + k : ''}"><b>${n.toLocaleString()}</b><span>${t}</span></div>`).join('');

    const unknown = Object.keys(s.unknown);
    el.segNote.hidden = !unknown.length;
    if (unknown.length) {
      el.segNote.textContent = `号段表未收录这些前缀（异常 ${s.invalid} 条，其中这些前缀 ${unknown.reduce((a, k) => a + s.unknown[k], 0)} 条）：`
        + unknown.sort((a, b) => s.unknown[b] - s.unknown[a]).slice(0, 15).map((k) => `${k}(${s.unknown[k]})`).join('、')
        + '。这些号码未计入下单，可提供完整号码以扩充号段表。';
    }
    renderPreview();
  }

  function renderPreview() {
    const cols = width(state.aoa);
    const ex = extractOn();
    const rows = state.rows.filter((r) => !r.empty).slice(0, 20);
    let html = '<table class="grid"><thead><tr><th>行</th>';
    for (let c = 0; c < cols; c++) {
      html += `<th>${escapeHtml(c === state.col ? `${nameOf(c)} ★` : nameOf(c))}</th>`;
      if (ex && c === state.col) html += '<th>提取号码</th>';
    }
    html += '<th>运营商</th><th>备注</th></tr></thead><tbody>';
    if (!rows.length) html += `<tr><td colspan="${cols + 3 + (ex ? 1 : 0)}" class="note">该列没有可预览的有效号码。</td></tr>`;
    for (const r of rows) {
      html += `<tr class="${dedupeOn() && r.dup ? 'dim' : ''}"><td class="num">${r.srcRow + 1}</td>`;
      for (let c = 0; c < cols; c++) {
        html += `<td class="${c === state.col ? 'hl' : ''}">${escapeHtml(cellText(r.cells[c]))}</td>`;
        if (ex && c === state.col) html += `<td class="hl">${escapeHtml(r.digits || '')}</td>`;
      }
      html += `<td><span class="tag ${tagClass(r)}">${escapeHtml(r.carrier)}</span></td><td class="note">${escapeHtml(r.note)}</td></tr>`;
    }
    html += '</tbody></table>';
    const s = state.stats;
    const m = mode();
    html += `<p class="small" id="previewNote">当前拆分方式：${m === 'four' ? '四大运营商（中国广电单列一张 sheet）' : '三大运营商（广电并入「其他」）'}；`
      + `号码列：${el.normNum.checked ? '导出时归一化为 11 位（预览仍显示原样）' : '导出保持原样'}；`
      + `去重：${dedupeOn() ? `开启，${s.dup} 条重复不进各 sheet（预览中灰显），单列「重复号码」` : '关闭，重复号码也留在各 sheet'}。`
      + (ex ? ` 已从文本提取 ${s.extracted} 个号码，新增「提取号码」列（原文列不动）。` : '')
      + ` 预览前 ${Math.min(20, state.rows.length)} 条，导出文件包含全部 ${state.rows.length} 行。</p>`;
    el.previewWrap.innerHTML = html;
  }

  function nameOf(c) {
    const h = headerRowIdx();
    const name = h >= 0 ? cellText(state.aoa[h][c]).trim() : '';
    return name || `第${c + 1}列`;
  }

  const tagClass = (r) => (r.valid ? { 中国移动: 't-cm', 中国联通: 't-cu', 中国电信: 't-ct', 中国广电: 't-cb' }[r.carrier] || 't-other' : 't-other');

  // ---------- 下单页 ----------
  function buildOrder() {
    const s = state.stats;
    if (!s) { el.orderWrap.innerHTML = ''; return; }
    const list = CARRIERS.filter((c) => s.by[c].valid > 0);
    let html = '<table class="grid order"><thead><tr><th>运营商</th><th>有效</th><th>去重后</th><th>重复</th><th>虚商转售</th><th>发送条数</th><th>单价(元/条)</th><th>金额(元)</th><th>备注</th></tr></thead><tbody>';
    for (const c of list) {
      const b = s.by[c];
      html += `<tr data-carrier="${c}"><td><span class="tag ${tagClass({ carrier: c, valid: true })}">${c}</span></td>`
        + `<td class="num">${b.valid}</td><td class="num">${b.unique}</td><td class="num">${b.dup}</td><td class="num">${b.virtual}</td>`
        + `<td><input class="qty" type="number" min="0" step="1" value="${b.unique}"></td>`
        + `<td><input class="price" type="number" min="0" step="0.0001" value="${prices[c] !== undefined ? prices[c] : ''}" placeholder="0.0000"></td>`
        + `<td class="num amount">—</td><td><input class="remark" type="text" placeholder="选填"></td></tr>`;
    }
    if (!list.length) html += `<tr><td colspan="9" class="note">没有有效号码，无法生成下单清单。</td></tr>`;
    html += '</tbody><tfoot><tr><td>合计</td><td class="num">' + s.valid + '</td><td class="num">' + uniqTotal() + '</td><td class="num">' + s.dup
      + '</td><td class="num">' + virtualTotal() + '</td><td class="num" id="sumQty">0</td><td></td><td class="num" id="sumAmt">0.00</td><td></td></tr></tfoot></table>';

    const skipped = [];
    if (s.invalid) skipped.push(`异常/未登记 ${s.invalid} 条`);
    if (s.empty) skipped.push(`空号码 ${s.empty} 条`);
    html += `<p class="small">${skipped.length ? '未计入下单：' + skipped.join('、') + '。' : '全部号码均已计入下单。'} 号段表 ${CarrierDB.updated} 版 · ${escapeHtml(CarrierDB.source)}</p>`;
    el.orderWrap.innerHTML = html;
    el.orderWrap.querySelectorAll('tr[data-carrier]').forEach((tr) => {
      tr.querySelectorAll('input').forEach((inp) => inp.addEventListener('input', () => recalc(tr)));
      recalc(tr);
    });
    recalcTotals();
  }

  function recalc(tr) {
    const c = tr.dataset.carrier;
    const qty = Number(tr.querySelector('.qty').value) || 0;
    const raw = tr.querySelector('.price').value;
    const price = raw === '' ? null : Number(raw);
    const amt = price === null || !Number.isFinite(price) ? 0 : Math.round(qty * price * 1e6) / 1e6;
    tr.querySelector('.amount').textContent = price === null ? '—' : amt.toFixed(2);
    tr.dataset.amount = String(amt);
    if (price === null) delete prices[c];
    else { prices[c] = price; localStorage.setItem(LS_PRICE, JSON.stringify(prices)); }
    recalcTotals();
  }

  function recalcTotals() {
    let qty = 0, amt = 0;
    el.orderWrap.querySelectorAll('tr[data-carrier]').forEach((tr) => {
      qty += Number(tr.querySelector('.qty').value) || 0;
      amt += Number(tr.dataset.amount || 0);
    });
    el.orderWrap.querySelector('#sumQty').textContent = qty.toLocaleString();
    el.orderWrap.querySelector('#sumAmt').textContent = amt.toFixed(2);
  }

  function orderData() {
    const out = [];
    el.orderWrap.querySelectorAll('tr[data-carrier]').forEach((tr) => {
      const p = tr.querySelector('.price').value;
      out.push({
        carrier: tr.dataset.carrier,
        valid: Number(tr.children[1].textContent) || 0,
        unique: Number(tr.children[2].textContent) || 0,
        qty: Number(tr.querySelector('.qty').value) || 0,
        price: p === '' ? null : Number(p),
        amount: Number(tr.dataset.amount || 0),
        remark: tr.querySelector('.remark').value.trim(),
      });
    });
    return out;
  }

  // ---------- 导出 ----------
  const stamp = () => {
    const d = new Date(), p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
  };

  function dataSheet(rows) {
    const ex = extractOn();
    const head = state.header ? (ex ? state.header.slice(0, state.col + 1).concat(['提取号码'], state.header.slice(state.col + 1)) : state.header.slice()) : null;
    const aoa = head ? [head.concat(['运营商', '备注'])] : [];
    for (const r of rows) {
      const cells = ex ? r.cells.slice(0, state.col + 1).concat([r.digits || ''], r.cells.slice(state.col + 1)) : r.cells.slice();
      aoa.push(cells.concat([r.empty ? '' : r.carrier, r.empty ? '' : r.note]));
    }
    if (!aoa.length) return null;
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    const pCol = phoneOutCol();
    // 提取列永远是纯号码文本；原号码列只在开了归一化时改写
    if (ex || el.normNum.checked) {
      const offset = head ? 1 : 0;
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        if (ex && !r.digits) continue;
        const addr = XLSX.utils.encode_cell({ r: i + offset, c: pCol });
        if (!ws[addr]) continue;
        ws[addr] = { t: 's', v: r.digits || cellText(r.raw) };
      }
    }
    const cols = width(aoa);
    ws['!cols'] = [];
    for (let c = 0; c < cols; c++) ws['!cols'].push({ wch: c === pCol ? 16 : c === cols - 1 ? 34 : c === cols - 2 ? 12 : 16 });
    return ws;
  }

  const exportRows = () => (dedupeOn() ? state.rows.filter((r) => !r.dup) : state.rows);

  function summarySheet(mode) {
    const s = state.stats;
    const base = s.valid || 1;
    const aoa = [['运营商', '有效号码', '去重后号码', '重复', '虚拟转售', '占比', '备注'],
    ];
    for (const c of CARRIERS) {
      const b = s.by[c];
      aoa.push([c, b.valid, b.unique, b.dup, b.virtual, (b.valid / base * 100).toFixed(1) + '%', b.valid ? '' : '本表无该运营商号码']);
    }
    aoa.push(['未知或其他', 0, 0, 0, 0, '', `异常 ${s.invalid} 条 / 空号码 ${s.empty} 条`]);
    aoa.push(['合计', s.valid, uniqTotal(), s.dup, virtualTotal(), '100%', `数据行 ${s.total}`]);
    aoa.push([]);
    aoa.push(['拆分方式', mode === 'four' ? '四大运营商（中国广电单列一张 sheet）' : '三大运营商（广电与异常并入「其他(含广电)」）']);
    aoa.push(['源文件', state.lastFile]);
    aoa.push(['号段表', `${CarrierDB.updated} · ${CarrierDB.source}`]);
    aoa.push(['处理规则', (el.normNum.checked ? '号码列归一化为 11 位文本（去 +86/空格/连字符）' : '号码列保持原样（未归一化、未改单元格格式）')
      + (dedupeOn() ? `；拆分时去重：各 sheet 只留首次出现的行，被去掉的 ${s.dup} 条重复号码单列在「重复号码」` : '；不去重：重复号码仍留在各 sheet，备注标明首次出现行号')
      + (extractOn() ? `；已从文本中提取 ${s.extracted} 个号码，新增「提取号码」列（原文列未改动），一格多号拆成多行` : '')
      + '；原始列与列序未改动；全空行跳过。']);
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws['!cols'] = [{ wch: 14 }, { wch: 12 }, { wch: 13 }, { wch: 8 }, { wch: 11 }, { wch: 9 }, { wch: 60 }];
    return ws;
  }

  const safeName = (n) => n.replace(/[\\/?*[\]:]/g, '_').slice(0, 31);
  const baseName = () => (state.lastFile || '号码').replace(/\.[^.]+$/, '');

  function appendSheet(wb, ws, name) {
    XLSX.utils.book_append_sheet(wb, ws || XLSX.utils.aoa_to_sheet([['该分组无号码']]), safeName(name));
  }

  function buildSplitWorkbook() {
    const wb = XLSX.utils.book_new();
    const m = mode();
    const keep = exportRows();
    appendSheet(wb, dataSheet(keep), '全部号码');

    const groups = m === 'four'
      ? CARRIERS.map((c) => ({ name: c, pick: (r) => r.valid && r.carrier === c }))
        .concat([{ name: '未知或其他', pick: (r) => !r.valid && !r.empty }])
      : CARRIERS.slice(0, 3).map((c) => ({ name: c, pick: (r) => r.valid && r.carrier === c }))
        .concat([{ name: '其他(含广电)', pick: (r) => !r.empty && (r.carrier === '中国广电' || !r.valid) }]);

    for (const g of groups) appendSheet(wb, dataSheet(keep.filter(g.pick)), g.name);
    if (dedupeOn()) appendSheet(wb, dataSheet(state.rows.filter((r) => r.dup)), '重复号码');
    XLSX.utils.book_append_sheet(wb, summarySheet(m), '汇总');
    return wb;
  }

  function downloadSplit() {
    if (!state.stats) return msg('先选择一个 Excel/CSV 文件。', 'warn');
    XLSX.writeFile(buildSplitWorkbook(), `${baseName()}_运营商拆分_${stamp()}.xlsx`);
    msg('拆分文件已生成；源文件未做任何修改。', 'ok');
  }

  function downloadOrder() {
    const rows = orderData();
    if (!rows.length) return msg('没有可下单的运营商分组。', 'warn');
    const aoa = [['运营商短信下单清单'], ['源文件', state.lastFile], ['生成时间', new Date().toLocaleString()], []];
    aoa.push(['序号', '运营商', '有效号码', '去重后号码', '发送条数', '单价(元/条)', '金额(元)', '备注']);
    let qty = 0, amt = 0;
    rows.forEach((r, i) => {
      qty += r.qty; amt += r.amount;
      aoa.push([i + 1, r.carrier, r.valid, r.unique, r.qty, r.price === null ? '' : r.price, r.amount, r.remark]);
    });
    aoa.push(['', '合计', '', '', qty, '', Math.round(amt * 1e6) / 1e6, '']);
    aoa.push([]);
    aoa.push(['说明', '号码数按去重后的有效号码统计；异常/空号码未计入。']);
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 7 } }];
    ws['!cols'] = [{ wch: 6 }, { wch: 12 }, { wch: 11 }, { wch: 12 }, { wch: 11 }, { wch: 13 }, { wch: 12 }, { wch: 26 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '下单清单');
    XLSX.writeFile(wb, `${baseName()}_运营商下单清单_${stamp()}.xlsx`);
    msg('下单清单已生成。', 'ok');
  }

  function copyOrder() {
    const rows = orderData();
    if (!rows.length) return msg('没有可复制的分组。', 'warn');
    const amt = rows.reduce((a, r) => a + r.amount, 0);
    const lines = [`运营商短信下单清单 · ${state.lastFile} · ${new Date().toLocaleDateString()}`];
    for (const r of rows) lines.push(`${r.carrier}：${r.qty} 条${r.price === null ? '' : ` × ${r.price} 元/条 = ${r.amount.toFixed(2)} 元`}${r.remark ? `（${r.remark}）` : ''}`);
    lines.push(`合计：${amt.toFixed(2)} 元`);
    navigator.clipboard.writeText(lines.join('\n')).then(
      () => msg('清单已复制到剪贴板。', 'ok'),
      () => msg('浏览器拒绝写入剪贴板，请手动选中表格文本。', 'warn'),
    );
  }

  // ---------- 事件 ----------
  async function handle(file) {
    msg(`正在读取 ${file.name} …`);
    try {
      const { wb, enc } = await readFile(file);
      loadWorkbook(wb, file.name, enc);
    } catch (e) {
      console.error(e);
      msg(`读取失败：${e.message}`, 'err');
    }
  }

  function bind() {
    ['dragenter', 'dragover'].forEach((t) => el.drop.addEventListener(t, (e) => { e.preventDefault(); el.drop.classList.add('hot'); }));
    ['dragleave', 'drop'].forEach((t) => el.drop.addEventListener(t, (e) => { e.preventDefault(); el.drop.classList.remove('hot'); }));
    el.drop.addEventListener('drop', (e) => { if (e.dataTransfer.files.length) handle(e.dataTransfer.files[0]); });
    el.btnFile.addEventListener('click', (e) => { e.stopPropagation(); el.file.click(); });
    el.file.addEventListener('change', () => { if (el.file.files.length) handle(el.file.files[0]); });
    el.btnSplit.addEventListener('click', downloadSplit);
    el.btnOrder.addEventListener('click', downloadOrder);
    el.btnPrint.addEventListener('click', () => window.print());
    el.btnCopy.addEventListener('click', copyOrder);
    el.sheetSel.addEventListener('change', () => useSheet(el.sheetSel.value));
    el.colSel.addEventListener('change', process);
    el.noHeader.addEventListener('change', () => { fillColumnSelect(); process(); });
    [el.modeFour, el.modeThree].forEach((r) => r.addEventListener('change', render));
    el.normNum.addEventListener('change', render);
    el.dedupe.addEventListener('change', render);
    el.extract.addEventListener('change', process);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind);
  else bind();

  // 供端到端验证直接调用
  globalThis.__smsApp = { handle, process, buildSplitWorkbook, downloadOrder, state, CARRIERS };
})();
