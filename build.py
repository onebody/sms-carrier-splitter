"""把 src/index.html 里的 <script src=...> 内联成真正的单文件离线页面。"""
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent
TPL = ROOT / "src" / "index.html"
OUT = ROOT / "号码运营商分类与拆表.html"

TAG = re.compile(r'<script src="([^"]+)"></script>')


def inline(match: re.Match) -> str:
    path = (TPL.parent / match.group(1)).resolve()
    if not path.is_file():
        sys.exit(f"缺少依赖文件：{path}")
    code = path.read_text(encoding="utf-8")
    if "</script" in code.lower():
        sys.exit(f"{path.name} 内含 </script>，不能直接内联")
    return f"<script>\n{code}\n</script>"


source = TPL.read_text(encoding="utf-8")
count = len(TAG.findall(source))
if count != 3:
    sys.exit(f"预期内联 3 个脚本，实际找到 {count} 个")
html = TAG.subn(inline, source)[0]
OUT.write_text(html, encoding="utf-8")
print(f"已生成 {OUT.name}（{len(html) / 1024:.0f} KB，内联 {count} 个脚本）")
