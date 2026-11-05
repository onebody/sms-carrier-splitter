"""生成固定用例样本 + 逐行手写的答案表（答案不从号段程序推导，避免自证）。"""
import json
import pathlib

from openpyxl import Workbook

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / "fixtures"
OUT.mkdir(exist_ok=True)

CM, CU, CT, CB = "中国移动", "中国联通", "中国电信", "中国广电"
BAD, EMPTY = "无效", "空号码"

# (姓名, 单元格原值, 期望归属, 备注)
ROWS = [
    ("张三", "13800138001", CM, ""),
    ("李四", "13912345678", CM, ""),
    ("王五", "15900000001", CM, ""),
    ("赵六", "19812345678", CM, ""),
    ("钱七", "13012345678", CU, ""),
    ("孙八", "15500000001", CU, ""),
    ("周九", "16612345678", CU, ""),
    ("吴十", "19612345678", CU, ""),
    ("郑一", "13312345678", CT, ""),
    ("王二", "18012345678", CT, ""),
    ("陈三", "18912345678", CT, ""),
    ("林四", "19912345678", CT, ""),
    ("黄五", "19212345678", CB, "广电"),
    ("徐六", "19200000001", CB, "广电"),
    ("朱七", "17040000000", CU, "虚商落地联通"),
    ("高八", "16512345678", CM, "虚商落地移动"),
    ("罗九", "+8613800138002", CM, "带 +86"),
    ("梁十", "0086-137-1234-5678", CM, "带 0086 与连字符"),
    ("宋一", " 186 1234 5678 ", CU, "含空格"),
    ("唐二", 13512345678, CM, "Excel 存成数字"),
    ("冯三", "13800138001", CM, "与第2行重复"),
    ("邓四", "1380013800", BAD, "10位"),
    ("曹五", "075512345678", BAD, "固话"),
    ("彭六", "15400000000", BAD, "未登记号段"),
    ("薛七", "", EMPTY, "空号码"),
    ("何九", "abc电话", BAD, "含非数字"),
]
SKIPPED = 1  # 一整行空白，程序应跳过

# 号码嵌在文本里的表（提取用例）：期望号码与期望归属均为手写，不从提取逻辑反推
EMBED = [
    ("张伟", "手机 13800138001，备用 13912345678", ["13800138001", "13912345678"], [CM, CM]),
    ("李娜", "联系 13012345678", ["13012345678"], [CU]),
    ("王强", "座机 0755-12345678", [], []),
    ("刘敏", "13800138001 重复", ["13800138001"], [CM]),
    ("陈达", "电话 +86 186 1234 5678 或 19212345678", ["18612345678", "19212345678"], [CU, CB]),
    ("赵磊", "身份证 110101199003078888", [], []),
    ("孙丽", "手机19912345678转8001", ["19912345678"], [CT]),
]


def main():
    wb = Workbook()
    ws = wb.active
    ws.title = "客户名单"
    ws.append(["姓名", "手机号", "城市"])
    for name, phone, _, note in ROWS:
        ws.append([name, phone, "深圳" if note != "含空格" else "北京"])
    ws.append([None, None, None])
    # 第二个 sheet：无表头，纯号码列
    ws2 = wb.create_sheet("纯号码")
    for p in ["13800138001", "19212345678", "13312345678"]:
        ws2.append([p])
    path = OUT / "sample.xlsx"
    wb.save(path)

    # GBK 编码 CSV：验证国内导出文件常见的非 UTF-8 路径
    csv_rows = ["姓名,手机号,城市"] + [f"{n},{p if isinstance(p, str) else p},城市" for n, p, _w, _nt in ROWS[:12]]
    (OUT / "sample_gbk.csv").write_bytes("\n".join(csv_rows).encode("gbk"))

    # 负例 1：整表没有号码列
    npwb = Workbook()
    np_ws = npwb.active
    np_ws.title = "订单"
    np_ws.append(["订单号", "金额", "日期"])
    for i in range(1, 21):
        np_ws.append([f"A{i:04d}", i * 12.5, "2026-11-05"])
    npwb.save(OUT / "no_phone.xlsx")

    # 负例 2：扩展名是 xlsx 但内容不是工作簿
    (OUT / "broken.xlsx").write_bytes(("这不是 Excel 文件\n" * 20).encode("utf-8"))

    # 性能用例：1 万行
    big = Workbook()
    bs = big.active
    bs.title = "一万行"
    bs.append(["客户", "手机号"])
    pool = ["13800138000", "13012340000", "13312340000", "19212340000", "15400000000"]
    for i in range(10000):
        bs.append([f"客户{i}", pool[i % len(pool)][:-4] + f"{i % 10000:04d}"])
    big.save(OUT / "big.xlsx")

    # 号码嵌在文本里的表（提取用例）
    eb = Workbook()
    ebs = eb.active
    ebs.title = "联系人"
    ebs.append(["姓名", "联系方式", "城市"])
    for name, text, _nums, _w in EMBED:
        ebs.append([name, text, "深圳"])
    eb.save(OUT / "embed.xlsx")

    exp = {"valid": 0, "unique": 0, "dup": 0, "invalid": 0, "empty": 0, "by": {}}
    seen = set()
    for _, phone, want, _n in ROWS:
        if want == EMPTY:
            exp["empty"] += 1
            continue
        if want == BAD:
            exp["invalid"] += 1
            continue
        exp["valid"] += 1
        b = exp["by"].setdefault(want, {"valid": 0, "unique": 0, "dup": 0})
        b["valid"] += 1
        key = str(phone)
        if key in seen:
            b["dup"] += 1
            exp["dup"] += 1
        else:
            seen.add(key)
            b["unique"] += 1
            exp["unique"] += 1
    exp["total"] = len(ROWS)
    exp["skipped_blank_rows"] = SKIPPED
    exp["expected_sheets_four"] = ["全部号码", CM, CU, CT, CB, "未知或其他", "汇总"]
    exp["expected_sheets_three"] = ["全部号码", CM, CU, CT, "其他(含广电)", "汇总"]
    exp["three_other_rows"] = exp["by"][CB]["valid"] + exp["invalid"]
    exp["virtual"] = {"中国移动": 1, "中国联通": 1}

    # 提取用例的期望：只从上面手写的 EMBED（原文 + 期望号码 + 期望归属）算，不看任何实现
    ex_nums = [n for _nm, _t, nums, _w in EMBED for n in nums]
    ex_pairs = [(n, c) for _nm, _t, nums, want in EMBED for n, c in zip(nums, want)]
    seen2 = set()
    eby = {}
    for num, carrier in ex_pairs:
        b = eby.setdefault(carrier, {"valid": 0, "unique": 0, "dup": 0})
        b["valid"] += 1
        if num in seen2:
            b["dup"] += 1
        else:
            seen2.add(num)
            b["unique"] += 1
    exp["embed"] = {
        "rows": [max(len(nums), 1) for _nm, _t, nums, _w in EMBED],  # 每源行展开出的行数
        "total": sum(max(len(nums), 1) for _nm, _t, nums, _w in EMBED),
        "extracted": len(ex_nums),
        "valid": len(ex_nums),
        "unique": len(set(ex_nums)),
        "dup": len(ex_nums) - len(set(ex_nums)),
        "invalid": sum(1 for _nm, _t, nums, _w in EMBED if not nums),
        "empty": 0,
        "by": eby,
        "numbers": ex_nums,
        "dup_numbers": [n for n in ex_nums if ex_nums.count(n) > 1],
    }
    exp["dedup"] = {
        "全部号码": exp["total"] - exp["dup"],
        "重复号码": exp["dup"],
        CM: exp["by"][CM]["unique"],
        CU: exp["by"][CU]["unique"],
        CT: exp["by"][CT]["unique"],
        CB: exp["by"][CB]["unique"],
        "未知或其他": exp["invalid"],
    }
    exp["sheets_four_dedup"] = exp["expected_sheets_four"][:6] + ["重复号码", "汇总"]
    exp["sheets_three_dedup"] = exp["expected_sheets_three"][:5] + ["重复号码", "汇总"]
    (OUT / "expected.json").write_text(json.dumps(exp, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"已生成 {path.name}（{len(ROWS)} 条数据 + {SKIPPED} 条全空行，2 个 sheet）")
    print(json.dumps(exp["by"], ensure_ascii=False))


if __name__ == "__main__":
    main()
