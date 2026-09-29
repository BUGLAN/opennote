"""生成 Opennote 的全部图标资源，图形与界面左上角的印章一致：
朱砂红圆角方块 + 内描边 + 居中的「記」字。

产物：
  public/favicon.svg          站点图标（浏览器标签页）
  public/icon-192.png         PWA 图标
  public/icon-512.png         PWA 图标（含 maskable）
  public/apple-touch-icon.png iOS 主屏图标
  build/icon.ico              Windows 打包与窗口图标（多尺寸）

用法：pnpm icons（需要 Pillow）
"""

from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
PUBLIC = ROOT / "public"
BUILD = ROOT / "build"

SEAL = (178, 58, 46, 255)
PAPER = (251, 248, 243, 255)
INNER_RULE = (251, 248, 243, 115)

# 与应用内印章一致的 CJK 字体，按可用性回退
FONT_CANDIDATES = [
    Path(r"C:\Windows\Fonts\simsun.ttc"),
    Path(r"C:\Windows\Fonts\simkai.ttf"),
    Path(r"C:\Windows\Fonts\msyh.ttc"),
    Path("/System/Library/Fonts/Songti.ttc"),
    Path("/usr/share/fonts/opentype/noto/NotoSerifCJK-Regular.ttc"),
]


def load_font(size: int) -> ImageFont.FreeTypeFont:
    for candidate in FONT_CANDIDATES:
        if candidate.exists():
            try:
                return ImageFont.truetype(str(candidate), size)
            except OSError:
                continue
    # 最后回退到 Pillow 自带位图字体（会明显偏小，但不至于失败）
    return ImageFont.load_default(size)


def draw_seal(size: int) -> Image.Image:
    """朱砂圆角方块 + 内描边 + 居中「記」。"""
    scale = size / 64
    image = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)

    draw.rounded_rectangle((0, 0, size - 1, size - 1), radius=round(13 * scale), fill=SEAL)
    draw.rounded_rectangle(
        (4.5 * scale, 4.5 * scale, size - 4.5 * scale, size - 4.5 * scale),
        radius=round(10 * scale),
        outline=INNER_RULE,
        width=max(1, round(1.2 * scale)),
    )

    # 「記」在印章里的视觉重心略高于几何中心，这里手工上移一点点
    glyph_size = round(size * 0.62)
    font = load_font(glyph_size)
    box = draw.textbbox((0, 0), "記", font=font)
    x = (size - (box[2] - box[0])) / 2 - box[0]
    y = (size - (box[3] - box[1])) / 2 - box[1] - size * 0.015
    draw.text((x, y), "記", font=font, fill=PAPER)
    return image


def write_favicon_svg(path: Path) -> None:
    """站点图标用 SVG text：体积小，且能跟随系统 CJK 字体渲染。"""
    path.write_text(
        """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64">
  <rect width="64" height="64" rx="13" fill="#b23a2e" />
  <rect x="4.5" y="4.5" width="55" height="55" rx="10" fill="none"
        stroke="#fbf8f3" stroke-opacity=".45" stroke-width="1.2" />
  <text x="32" y="33" fill="#fbf8f3" font-size="40" text-anchor="middle"
        dominant-baseline="central"
        font-family="Songti SC, Noto Serif SC, Source Han Serif SC, SimSun, serif">記</text>
</svg>
""",
        encoding="utf-8",
    )


def main() -> None:
    PUBLIC.mkdir(parents=True, exist_ok=True)
    BUILD.mkdir(parents=True, exist_ok=True)

    draw_seal(192).save(PUBLIC / "icon-192.png")
    draw_seal(512).save(PUBLIC / "icon-512.png")
    draw_seal(180).save(PUBLIC / "apple-touch-icon.png")
    write_favicon_svg(PUBLIC / "favicon.svg")

    # Windows 需要多尺寸 ICO：任务栏/资源管理器/Alt-Tab 各取所需
    sizes = [16, 24, 32, 48, 64, 128, 256]
    icons = [draw_seal(size) for size in sizes]
    icons[-1].save(BUILD / "icon.ico", format="ICO", sizes=[(size, size) for size in sizes])
    print("icons written to public/ and build/icon.ico")


if __name__ == "__main__":
    main()
