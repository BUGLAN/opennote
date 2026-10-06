"""生成 Opennote 的全部图标资源，图形与界面左上角的印章一致：
圆角方块 + 内描边 + 居中的「記」字。

产物：
  public/favicon.svg          站点图标（浏览器标签页）
  public/icon-192.png         PWA 图标
  public/icon-512.png         PWA 图标（含 maskable）
  public/apple-touch-icon.png iOS 主屏图标
  build/icon.ico              Windows 打包与窗口图标（多尺寸）
  public/seal/<accent>-<kind>.png
                              侧栏左上角那枚印章：4 套强调色 × 明/暗 = 8 个文件。
                              颜色**逐字从 src/styles/tokens.css 读**（见 read_accent_tokens），
                              所以改了主题令牌要重新跑一次 `pnpm icons`。

用法：pnpm icons（需要 Pillow）

注意：脚本会重写上面每一个产物。图形是确定的（同一份几何 + 同一份字体），但 PNG 的
压缩字节会随 Pillow / zlib 的版本变化 —— 重新生成后 `git diff` 里那几个应用图标可能
显示为「已修改」，逐像素其实完全一样（`git checkout` 掉即可，不必提交）。真正会改图的
只有两处：调色板令牌改了（`public/seal/` 跟着变），或者这里改了绘制代码。
"""

import re
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
PUBLIC = ROOT / "public"
BUILD = ROOT / "build"
TOKENS_CSS = ROOT / "src" / "styles" / "tokens.css"

SEAL = (178, 58, 46, 255)
PAPER = (251, 248, 243, 255)
INNER_RULE = (251, 248, 243, 115)
# CSS `.seal` 的内描边是 `inset 0 0 0 1px rgb(255 255 255 / .32)`
SEAL_RING = (255, 255, 255, 82)

ACCENT_ORDER = ("seal", "indigo", "pine", "gamboge")
# 侧栏里显示 22px，按 4 倍出图（HiDPI 下不糊）
SEAL_ICON_SIZE = 96
# 以 CSS `.seal` 的 22px 为基准的几何：5px 圆角 / 13px 字
SEAL_CSS_SIZE = 22.0

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


def hex_to_rgba(value: str) -> tuple[int, int, int, int]:
    raw = value.lstrip("#")
    return (int(raw[0:2], 16), int(raw[2:4], 16), int(raw[4:6], 16), 255)


def read_accent_tokens() -> dict[tuple[str, str], tuple[str, str]]:
    """从 `tokens.css` 读 4 套强调色 × 明/暗 的 `--accent` / `--accent-ink`。

    强调色的唯一产地是 `tokens.css`，图标只是它的一个消费方。在这个脚本里再抄一份
    十六进制值，就会出现「改了主题、忘了改脚本」——界面一套色、图标另一套色，
    而且两边都编译得过。所以这里直接解析 CSS：`[data-theme=...][data-accent=...]`
    的选择器 = 暗色档，只有 `[data-accent=...]`（或 `:root`）= 亮色档，
    与 `tokens.css` 的分档方式逐字对应。
    """
    css = TOKENS_CSS.read_text(encoding="utf-8")
    found: dict[tuple[str, str], tuple[str, str]] = {}
    for selector, body in re.findall(r"([^{}]+)\{([^{}]*)\}", css):
        if "--accent-ink" not in body:
            continue
        match = re.search(r'\[data-accent="([a-z]+)"\]', selector)
        if match:
            accent = match.group(1)
        elif ":root" in selector:
            accent = "seal"  # 默认强调色 = 朱砂，与 tokens.css 的 `:root` 同一档
        else:
            continue
        kind = "dark" if "[data-theme=" in selector else "light"
        base = re.search(r"--accent:\s*(#[0-9a-fA-F]{6})", body)
        ink = re.search(r"--accent-ink:\s*(#[0-9a-fA-F]{6})", body)
        if base and ink:
            found[(accent, kind)] = (base.group(1), ink.group(1))

    missing = [f"{accent}-{kind}" for accent in ACCENT_ORDER for kind in ("light", "dark") if (accent, kind) not in found]
    if missing:
        raise SystemExit(f"tokens.css 里没读到这些强调色：{', '.join(missing)}")
    return found


def draw_accent_seal(size: int, accent: str, ink: str) -> Image.Image:
    """与 CSS `.seal` 同几何的印章：22px 里 5px 圆角、贴边 1px 内描边、「記」占 13px。"""
    unit = size / SEAL_CSS_SIZE
    radius = round(5 * unit)
    image = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    draw.rounded_rectangle((0, 0, size - 1, size - 1), radius=radius, fill=hex_to_rgba(accent))
    draw.rounded_rectangle(
        (0, 0, size - 1, size - 1),
        radius=radius,
        outline=SEAL_RING,
        width=max(1, round(unit)),
    )

    # 「記」的视觉重心略高于几何中心，和 `draw_seal` 用同一个偏移
    font = load_font(round(13 * unit))
    box = draw.textbbox((0, 0), "記", font=font)
    x = (size - (box[2] - box[0])) / 2 - box[0]
    y = (size - (box[3] - box[1])) / 2 - box[1] - size * 0.015
    draw.text((x, y), "記", font=font, fill=hex_to_rgba(ink))
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

    # 侧栏左上角的印章：4 套强调色 × 明/暗。图标固定 8 个文件，界面按
    # `data-accent` + 主题明暗挑一个 —— 颜色来自 tokens.css，不是手抄的。
    seal_dir = PUBLIC / "seal"
    seal_dir.mkdir(parents=True, exist_ok=True)
    tokens = read_accent_tokens()
    for (accent, kind), (base, ink) in sorted(tokens.items()):
        draw_accent_seal(SEAL_ICON_SIZE, base, ink).save(seal_dir / f"{accent}-{kind}.png")

    print(f"icons written to public/, public/seal/ ({len(tokens)} 个印章) and build/icon.ico")


if __name__ == "__main__":
    main()
