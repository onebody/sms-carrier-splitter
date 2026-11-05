"""用 openpyxl（与页面不同的实现）独立校验产物字节，而不是只看页面截图。"""
import json
import pathlib
import sys

from openpyxl import load_workbook

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from make_sample import BAD, CM, CB, CT, CU, EMPTY, EMBED, ROWS  # 手写答案表

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / "fixtures" / "out"
EXP = json.loads((ROOT / "fixtures" / "expected.json").read_text(encoding="utf-8"))
CARRIERS = (CM, CU, CT, CB)
DUP_NAME = "冯三"  # 手写答案表里唯一那条重复行
fails = []


def check(name, ok, detail=""):
    print(f"{'PASS' if ok else 'FAIL'} {name}{f' — {detail}' if detail else ''}")
    if not ok:
        fails.append(name)


def expect_label(want):
    return {EMPTY: "", BAD: "未知或其他"}.get(want, want)


def rows_of(ws):
    return list(ws.iter_rows(values_only=True))


def col(head, title):
    return head.index(title)


def sample_lines(dedup):
    """sample.xlsx 的期望行序列（去重时丢掉那条重复行）"""
    out = []
    for name, phone, want, note in ROWS:
        if dedup and name == DUP_NAME:
            continue
        digits = {"带 +86": "13800138002", "带 0086 与连字符": "13712345678", "含空格": "18612345678"}.get(note, str(phone))
        out.append({"name": name, "src": phone, "label": expect_label(want), "digits": digits, "note": note})
    return out


def embed_lines(dedup):
    """提取用例的期望行序列：一格多号拆成多行；去重时只留首次出现的那条"""
    out, seen = [], set()
    for name, text, nums, want in EMBED:
        if not nums:
            out.append({"name": name, "src": text, "label": "未知或其他", "digits": ""})
            continue
        for num, carrier in zip(nums, want):
            if dedup and num in seen:
                continue
            seen.add(num)
            out.append({"name": name, "src": text, "label": carrier, "digits": num})
    return out


def check_split(path, sheets, *, dedup, three=False, extract=False):
    wb = load_workbook(path)
    tag = path.name
    check(f"{tag} sheet 顺序", wb.sheetnames == sheets, str(wb.sheetnames))

    all_ws = wb["全部号码"]
    head = [c.value for c in all_ws[1]]
    body = rows_of(all_ws)[1:]
    num_col = col(head, "提取号码") if extract else col(head, "手机号")
    label_col = col(head, "运营商")
    note_col = col(head, "备注")
    want = embed_lines(dedup) if extract else sample_lines(dedup)

    if extract:
        check(f"{tag} 提取列插在号码列右侧", head[1] == "联系方式" and head[2] == "提取号码", str(head))
        check(f"{tag} 一格多号展开出的行数", len(body) == len(want), f"{len(body)} vs {len(want)}")
        check(f"{tag} 展开行的姓名序列", [r[0] for r in body] == [w["name"] for w in want],
              f"{[r[0] for r in body]} vs {[w['name'] for w in want]}")
        # 没提出号码的行（座机/身份证）提取列留空，openpyxl 读回是 None
        check(f"{tag} 提取号码逐行等于手写答案", [(r[num_col] or "") for r in body] == [w["digits"] for w in want],
              str([r[num_col] for r in body]))
        check(f"{tag} 原文列一字未改", [r[1] for r in body] == [w["src"] for w in want], str([r[1] for r in body][:2]))
        check(f"{tag} 提取后逐行运营商标注", [r[label_col] for r in body] == [w["label"] for w in want],
              str([r[label_col] for r in body]))
    else:
        check(f"{tag} 追加两列", head == ["姓名", "手机号", "城市", "运营商", "备注"], str(head))
        check(f"{tag} 全部号码行数", len(body) == len(want), f"{len(body)} vs {len(want)}")
        wrong = [f"{w['name']}: {r[label_col]!r} 应为 {w['label']!r}"
                 for r, w in zip(body, want) if (r[label_col] or "") != w["label"]]
        check(f"{tag} 逐行运营商标注", not wrong, "; ".join(wrong[:6]))

        cells = [all_ws.cell(row=i + 2, column=num_col + 1) for i in range(len(body))]
        numeric = [(c.coordinate, c.value) for c in cells if c.data_type == "n"]
        check(f"{tag} 号码列无数字型单元格", not numeric, str(numeric[:3]))
        i_num = next(i for i, w in enumerate(want) if w["note"] == "Excel 存成数字")
        check(f"{tag} 数字单元格转文本", cells[i_num].value == "13512345678" and cells[i_num].data_type == "s",
              f"{cells[i_num].value!r}/{cells[i_num].data_type}")
        vals = {c.value for c in cells}
        check(f"{tag} 带前缀号码已归一", "13712345678" in vals and "18612345678" in vals,
              str(sorted(v for v in vals if isinstance(v, str))[:4]))

    e = EXP["embed"] if extract else EXP
    per = e["by"]
    want_counts = {c: (per.get(c, {"valid": 0, "unique": 0})["unique"] if dedup
                       else per.get(c, {"valid": 0, "unique": 0})["valid"]) for c in CARRIERS}
    counts = {c: sum(1 for r in body if r[label_col] == c) for c in CARRIERS}
    check(f"{tag} 全部号码里各运营商行数", counts == want_counts, f"{counts} vs {want_counts}")
    for c in CARRIERS:
        if c in wb.sheetnames:
            n = len(rows_of(wb[c])) - 1
            check(f"{tag} {c} sheet 行数", n == want_counts[c], f"{n} vs {want_counts[c]}")
    if three:
        other = rows_of(wb["其他(含广电)"])[1:]
        want_other = want_counts[CB] + e["invalid"]
        check(f"{tag} 其他(含广电)=广电+异常", len(other) == want_other, f"{len(other)} vs {want_other}")
        check(f"{tag} 广电号码在三大模式仍标注真实运营商", "中国广电" in {r[label_col] for r in other},
              str({r[label_col] for r in other}))
    elif "未知或其他" in wb.sheetnames:
        n = len(rows_of(wb["未知或其他"])) - 1
        check(f"{tag} 未知或其他行数", n == e["invalid"], f"{n} vs {e['invalid']}")

    if "重复号码" in sheets:
        dup = rows_of(wb["重复号码"])[1:]
        check(f"{tag} 重复号码清单行数", len(dup) == e["dup"], f"{len(dup)} vs {e['dup']}")
        check(f"{tag} 重复清单里的号码", [r[num_col] for r in dup] == ["13800138001"], str([r[num_col] for r in dup]))
        check(f"{tag} 重复清单标注首次行号", any("第2行已出现" in str(r[note_col]) for r in dup), str([r[note_col] for r in dup]))
        if not extract:
            check(f"{tag} 重复清单就是被去掉的那一行", [r[0] for r in dup] == [DUP_NAME], str([r[0] for r in dup]))

    total_row = next(r for r in rows_of(wb["汇总"]) if r[0] == "合计")
    want_total = (e["valid"], e["unique"], e["dup"])
    check(f"{tag} 汇总合计（有效/去重后/重复）", tuple(total_row[1:4]) == want_total, f"{tuple(total_row[1:4])} vs {want_total}")
    if not extract:
        virt = sum(EXP["virtual"].get(c, 0) for c in CARRIERS)
        check(f"{tag} 汇总虚商转售列", total_row[4] == virt, f"{total_row[4]} vs {virt}")
    return wb


try:
    # 默认口径：拆分时去重
    check_split(OUT / "four.xlsx", EXP["sheets_four_dedup"], dedup=True)
    check_split(OUT / "three.xlsx", EXP["sheets_three_dedup"], dedup=True, three=True)
    # 关掉去重：含重复行的旧口径
    check_split(OUT / "nodup.xlsx", EXP["expected_sheets_four"], dedup=False)
    # 号码嵌在文本里：提取 + 一格多号拆行 + 去重
    check_split(OUT / "embed_split.xlsx", EXP["sheets_four_dedup"], dedup=True, extract=True)

    # 浏览器真实下载的那份
    if (OUT / "click.xlsx").exists():
        wb = load_workbook(OUT / "click.xlsx")
        check("click.xlsx 与页面导出同源（四大模式）", wb.sheetnames == EXP["sheets_four_dedup"], str(wb.sheetnames))
        check("click.xlsx 全部号码行数=去重后", len(rows_of(wb["全部号码"])) - 1 == EXP["total"] - EXP["dup"],
              str(len(rows_of(wb["全部号码"])) - 1))
    else:
        check("click.xlsx 存在", False, "浏览器未落盘下载文件")

    raw = OUT / "raw.xlsx"
    if raw.exists():
        rwb = load_workbook(raw)
        rws = rwb["全部号码"]
        head = [c.value for c in rws[1]]
        want = sample_lines(True)
        i86 = next(i for i, w in enumerate(want) if w["note"] == "带 +86")
        c86 = rws.cell(row=2 + i86, column=col(head, "手机号") + 1)
        check("原样模式保留 +86 前缀", c86.value == "+8613800138002", repr(c86.value))
        i_num = next(i for i, w in enumerate(want) if w["note"] == "Excel 存成数字")
        cn = rws.cell(row=2 + i_num, column=col(head, "手机号") + 1)
        check("原样模式保留数字单元格", cn.data_type == "n" and cn.value == 13512345678, f"{cn.value!r}/{cn.data_type}")
        crow = [r[col(head, "运营商")] for r in rows_of(rws)[1:]]
        check("原样模式仍带运营商标注", sum(1 for v in crow if v in CARRIERS) == EXP["unique"],
              str(sum(1 for v in crow if v in CARRIERS)))
        rule = [str(c.value) for row in rwb["汇总"].iter_rows() for c in row if c.value]
        check("汇总写明去重口径", any("去重" in t and "重复号码" in t for t in rule), str([t for t in rule if "去重" in t][:1]))
    else:
        check("raw.xlsx 存在", False)

    order = OUT / "order.xlsx"
    if order.exists():
        ows = load_workbook(order)["下单清单"]
        body = [r for r in ows.iter_rows(values_only=True) if r[1] in CARRIERS]
        got = {r[1]: r[4:7] for r in body}
        check("下单清单 移动 8条×0.05=0.40", got.get(CM) == (8, 0.05, 0.4), str(got.get(CM)))
        check("下单清单 联通 6条×0.045=0.27", got.get(CU) == (6, 0.045, 0.27), str(got.get(CU)))
        check("下单清单 未填单价的分组金额为0", got.get(CT) == (4, None, 0) and got.get(CB) == (2, None, 0),
              f"{got.get(CT)} {got.get(CB)}")
        total = next(r for r in ows.iter_rows(values_only=True) if r[1] == "合计")
        check("下单清单 合计 20条 0.67元", (total[4], round(total[6], 2)) == (20, 0.67), str((total[4], total[6])))
    else:
        check("order.xlsx 存在", False, "浏览器未落盘下单清单")
except Exception as e:  # noqa: BLE001
    check("产物可被 openpyxl 打开", False, repr(e))

print(f"\n未通过：{('、'.join(fails)) if fails else '无'}")
sys.exit(1 if fails else 0)
