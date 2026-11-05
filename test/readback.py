"""把下载回来的 xlsx 用 openpyxl 读一遍，输出结构化证据给报告用（与页面实现无关）。"""
import json
import sys
from collections import Counter

from openpyxl import load_workbook

path = sys.argv[1]
wb = load_workbook(path)
out = []
for name in wb.sheetnames:
    ws = wb[name]
    rows = list(ws.iter_rows(values_only=True))
    entry = {
        "name": name,
        "rows": len(rows),
        "dataRows": len(rows) - 1 if rows else 0,
        "cols": max((len(r) for r in rows), default=0),
        "head": [c for c in (rows[0] if rows else [])],
    }
    if name == "全部号码" and rows:
        cells = [ws.cell(row=i, column=2) for i in range(2, len(rows) + 1)]
        entry["phoneTypes"] = dict(Counter(c.data_type for c in cells))
        entry["phoneOdd"] = [c.coordinate for c in cells if c.data_type != "s"][:8]
        entry["phones"] = [str(ws.cell(row=i, column=2).value) for i in range(2, min(6, len(rows) + 1))]
        entry["carriers"] = [str(r[3]) for r in rows[1:6]]
    out.append(entry)
print(json.dumps({"file": path.rsplit("/", 1)[-1], "sheets": out}, ensure_ascii=False))
