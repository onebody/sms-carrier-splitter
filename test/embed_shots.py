"""把逐步截图缩到报告内嵌可用的尺寸（会话内嵌有 1MB 上限，base64 会再膨胀 4/3）。"""
import sys
from pathlib import Path

from PIL import Image

src_dir, dst_dir = Path(sys.argv[1]), Path(sys.argv[2])
dst_dir.mkdir(parents=True, exist_ok=True)
for p in sorted(src_dir.glob("step-*.jpg")):
    with Image.open(p) as im:
        if im.width > 900:
            im = im.resize((900, round(im.height * 900 / im.width)), Image.LANCZOS)
        out = dst_dir / p.name
        im.convert("RGB").save(out, "JPEG", quality=58, optimize=True)
        print(f"{p.name} {p.stat().st_size // 1024}KB -> {out.stat().st_size // 1024}KB")
