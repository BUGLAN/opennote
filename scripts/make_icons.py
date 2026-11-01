"""生成 Opennote 的全部图标资源，图形与界面左上角的印章一致：
圆角方块 + 内描边 + 居中的「記」字。

产物：
  public/favicon.svg          站点图标（浏览器标签页）
  public/icon-192.png         PWA 图标
  public/icon-512.png         PWA 图标（含 maskable）
  public/apple-touch-icon.png iOS 主屏图标
  build/icon.ico              Windows 打包与窗口图标（多尺寸；满幅美术）
  build/icon.icns             macOS 打包图标（多尺寸；Apple 图标网格，见 write_icns）
  build/icon-mac.png          macOS 运行时 Dock 图标（Electron app.dock.setIcon；
                              与 .icns 同一份 Apple 网格美术）

上面两类「应用图标」不是同一张图：favicon / PWA / .ico 是**满幅**的（印章铺满
整张画布），macOS 的 .icns 与 icon-mac.png 是 **Apple 图标网格**（身体 824/1024
居中 + 投影，见下方 MAC_* 常量）。macOS 的 Dock / Finder / ⌘Tab 按「身体 + 留白」
对齐图标，满幅图在那里会比邻居大一圈；Windows 任务栏与 PWA 没有这个要求。
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
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

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

# 与应用内印章一致的 CJK 字体，按可用性回退。
#
# ⚠️ 路径会随系统版本搬家：macOS 把 Songti 从 `/System/Library/Fonts/` 挪进了
# `Supplemental/`。老路径还在表里、只是存在性检查过不去，于是脚本**静默**回退到
# Pillow 自带的位图字体 —— 那个字体没有中日韩字形，画出来是一个「缺字方框」，
# 而 `pnpm icons` 会拿这个方框覆盖**全部**已提交图标（真踩过：Dock 图标变成白框叉）。
# 所以这里三条一起立规矩：新旧路径都列、取到字体必须**验证真能画出「記」**、
# 一个都不行就**报错退出**（宁可什么都不生成，也不静默写坏图）。
FONT_CANDIDATES = [
    Path(r"C:\Windows\Fonts\simsun.ttc"),
    Path(r"C:\Windows\Fonts\simkai.ttf"),
    Path(r"C:\Windows\Fonts\msyh.ttc"),
    Path("/System/Library/Fonts/Supplemental/Songti.ttc"),  # macOS 13+ 的实际位置
    Path("/System/Library/Fonts/Songti.ttc"),  # 旧版 macOS
    Path("/System/Library/Fonts/PingFang.ttc"),
    Path("/usr/share/fonts/opentype/noto/NotoSerifCJK-Regular.ttc"),
    Path("/usr/share/fonts/truetype/noto/NotoSerifCJK-Regular.ttc"),
]

GLYPH = "記"
# 这个码位在 Unicode 里永久保留、不属于任何字符，因此没有任何字体会给它字形：
# 渲染出来就是该字体的 `.notdef`（缺字方框）。拿它当「有没有字形」的对照。
NOTDEF_PROBE = "\U0010FFFF"
# 印章要的是宋体那种笔画，不是黑体/粗体：这些字重即使有字形也先让开。
NON_REGULAR_STYLES = ("Black", "Heavy", "Bold", "Light", "Thin", "Ultralight")


def renders_glyph(font: ImageFont.FreeTypeFont) -> bool:
    """字体是否**真有**「記」的字形（而不是画出一个缺字方框）。"""

    def render(text: str) -> bytes:
        canvas = Image.new("L", (font.size * 2, font.size * 2), 0)
        ImageDraw.Draw(canvas).text((font.size // 2, font.size // 2), text, font=font, fill=255)
        return canvas.tobytes()

    return render(GLYPH) != render(NOTDEF_PROBE)


def load_font(size: int) -> ImageFont.FreeTypeFont:
    non_regular = None
    for candidate in FONT_CANDIDATES:
        if not candidate.exists():
            continue
        # TTC 是字体集合，逐个 face 试：Songti.ttc 的 index 0 恰好是 Black（且无「記」字形）
        for index in range(0, 16):
            try:
                font = ImageFont.truetype(str(candidate), size, index=index)
            except OSError:
                break
            if not renders_glyph(font):
                continue
            if any(word in " ".join(font.getname()) for word in NON_REGULAR_STYLES):
                non_regular = non_regular or font
                continue
            return font
    if non_regular is not None:
        return non_regular
    raise SystemExit(
        "找不到能画出「記」的 CJK 字体，**没有生成任何图标**（绝不写出缺字方框）。"
        "请把本机可用的字体路径补进 FONT_CANDIDATES。"
    )


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


# ── macOS 图标画布 ─────────────────────────────────────────────────────────
#
# macOS 的 Dock / Finder / ⌘Tab / 启动台**不是**铺满画布的：Apple 的 App Icon
# 模板把印章身体放在 824×824 的居中区域（四边 100px 留白），圆角 185.4，身体
# 外面还有一圈投影。本机实测（Claude / PyCharm / VS Code 的 1024 档 icns，
# 以及 Apple 自家 Notes / Calendar / Safari 的 256 档；实心 = alpha>=250，投影 = alpha>0）：
#   · 实心身体 100..924，即 824/1024 = 0.8047（连续边界同一比例，不是抗锯齿造成的）；
#   · 投影外溢 ≈ 左 30 / 上 20 / 右 30 / 下 40；
#   · 拟合阴影 ≈ 高斯 σ15 + 向下偏移 10 + 18% 黑（贴着 Apple 模板的观感：
#     Apple 自己的阴影比多数第三方更宽更淡，σ15/18% 比 σ10/30% 更接近）。
# 满幅美术（Opennote 之前就是 0..1024）在 Dock 里会比邻居大一圈 —— 这是 macOS
# 图标最典型的错法，也是这次要修的那条。Windows 任务栏 / PWA 没有这个网格要求，
# 所以 .ico 与 public/icon-*.png 保持原来的满幅美术，不要跟着改。
MAC_CANVAS = 1024
MAC_BODY = 824
MAC_RADIUS = 185.4
MAC_SHADOW_SIGMA = 15.0
MAC_SHADOW_DY = 10.0
MAC_SHADOW_ALPHA = 0.18
# 运行时 Dock 位图的边长（Dock 最大 128px@2x，512 已经绰绰有余）。
MAC_DOCK_SIZE = 512
# Pillow 的圆角矩形与文字都不抗锯齿：按目的大小直画，16/32 档的圆角就是锯齿。
# 母版按 4 倍画，再 LANCZOS 缩到每一档。
MAC_SUPERSAMPLE = 4

_mac_master_cache: Image.Image | None = None


def mac_master() -> Image.Image:
    """macOS 图标母版（1024 画布的 4 倍超采样）。调用方缩放到目标档位。"""
    global _mac_master_cache
    if _mac_master_cache is not None:
        return _mac_master_cache

    k = MAC_SUPERSAMPLE
    canvas = MAC_CANVAS * k
    body = MAC_BODY * k
    left = (MAC_CANVAS - MAC_BODY) // 2 * k
    box = (left, left, left + body - 1, left + body - 1)
    radius = MAC_RADIUS * k

    image = Image.new("RGBA", (canvas, canvas), (0, 0, 0, 0))

    # 投影是**画进图里**的，不是系统加的：没有它，图标在浅色 Finder 背景上像一张
    # 贴纸浮着；做得太重又和系统图标不在一个调子上（实测 Apple 模板约 σ15 / 偏移
    # 10 / 18% 黑；VSCode 一类第三方更深更硬，但「更宽更淡」才是 Apple 的调子）。
    mask = Image.new("L", (canvas, canvas), 0)
    ImageDraw.Draw(mask).rounded_rectangle(box, radius=radius, fill=255)
    shadow = mask.filter(ImageFilter.GaussianBlur(MAC_SHADOW_SIGMA * k))
    shadow_layer = Image.new("RGBA", (canvas, canvas), (0, 0, 0, 0))
    shadow_layer.putalpha(shadow.point(lambda v: round(v * MAC_SHADOW_ALPHA)))
    image.alpha_composite(shadow_layer, (0, round(MAC_SHADOW_DY * k)))

    draw = ImageDraw.Draw(image)
    draw.rounded_rectangle(box, radius=radius, fill=SEAL)

    # 印章内部几何仍是 64 视框那套比例（内框 4.5 / 圆角 10 / 描边 1.2 / 字 62%），
    # 只是把「身体」当作 64 单位来缩放 —— 与侧栏那枚、favicon 是同一份几何。
    unit = body / 64
    inset = 4.5 * unit
    draw.rounded_rectangle(
        (box[0] + inset, box[1] + inset, box[2] - inset, box[3] - inset),
        radius=round(10 * unit),
        outline=INNER_RULE,
        width=max(1, round(1.2 * unit)),
    )

    font = load_font(round(body * 0.62))
    glyph = draw.textbbox((0, 0), GLYPH, font=font)
    x = left + (body - (glyph[2] - glyph[0])) / 2 - glyph[0]
    y = left + (body - (glyph[3] - glyph[1])) / 2 - glyph[1] - body * 0.015
    draw.text((x, y), GLYPH, font=font, fill=PAPER)

    _mac_master_cache = image
    return image


def draw_mac_icon(size: int) -> Image.Image:
    """macOS 某档图标（Apple 图标网格 + 投影）：从超采样母版降采样。"""
    return mac_master().resize((size, size), Image.LANCZOS)


def verify_mac_icon() -> None:
    """自检：macOS 图标必须留白。退回满幅就报错，绝不静默交付。"""
    master = mac_master()
    alpha = master.split()[-1]
    solid = alpha.point(lambda v: 255 if v >= 250 else 0).getbbox()
    if solid is None:
        raise SystemExit("macOS 图标自检失败：整张图都是透明的")
    ratio = (solid[2] - solid[0]) / master.width
    expected = MAC_BODY / MAC_CANVAS
    if abs(ratio - expected) > 0.01:
        raise SystemExit(
            f"macOS 图标自检失败：实心身体占画布 {ratio:.4f}，应 ≈{expected:.4f}"
            "（满幅会让 Dock 里的图标比其它 App 大一圈）"
        )
    corners = [
        alpha.getpixel(corner)
        for corner in ((0, 0), (master.width - 1, 0), (0, master.height - 1), (master.width - 1, master.height - 1))
    ]
    if any(corners):
        raise SystemExit(f"macOS 图标自检失败：四角应完全透明，实际 {corners}")


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


# macOS 打包只认 `.icns`。electron-builder 自带的图标转换器会**联网下载** icons 工具链
# （`icons@1.1.0`），离线环境直接 `fetch failed` 打包失败；系统自带的 `iconutil` 是纯本地
# 转换，没有任何第三方依赖。所以这里自己出 `.icns`，`mac.icon` 直接指向它。
#
# (基准边长, 倍率)：iconutil 要求 iconset 目录里恰好是这套命名与尺寸。
ICNS_SIZES = ((16, 1), (16, 2), (32, 1), (32, 2), (128, 1), (128, 2), (256, 1), (256, 2), (512, 1), (512, 2))


def write_icns() -> None:
    """生成 `build/icon.icns`（16→1024 共 10 档，Apple 图标网格）。

    只在 macOS 上做：`iconutil` 是系统自带的，其它平台没有也不需要一个 macOS 图标。
    跳过时**明确打印**，不静默成功 —— 免得在 Windows 上以为 `.icns` 更新过了。
    """
    if sys.platform != "darwin" or shutil.which("iconutil") is None:
        print("跳过 build/icon.icns（iconutil 只在 macOS 上有）—— Windows/Linux 图标不受影响")
        return

    with tempfile.TemporaryDirectory() as tmp:
        iconset = Path(tmp) / "icon.iconset"
        iconset.mkdir()
        for base, scale in ICNS_SIZES:
            suffix = "@2x" if scale == 2 else ""
            draw_mac_icon(base * scale).save(iconset / f"icon_{base}x{base}{suffix}.png")
        subprocess.run(
            ["iconutil", "-c", "icns", str(iconset), "-o", str(BUILD / "icon.icns")],
            check=True,
        )
    print(f"build/icon.icns 已生成（{len(ICNS_SIZES)} 档，16→1024，Apple 图标网格）")


def write_mac_dock_png() -> None:
    """生成 `build/icon-mac.png`：Electron 运行时 `app.dock.setIcon` 用的那张。

    为什么要单独一张：开发模式跑的是 Electron 自己的 app bundle，不显式设就显示
    Electron 默认图标；而这张必须和 `.icns` 是**同一份 macOS 网格美术**，否则开发/
    打包两种形态的 Dock 图标大小不一致。放 `build/` 而不是 `public/`：这是桌面端
    运行时资源，不该进 PWA 的 manifest 与 Service Worker 预缓存。
    """
    draw_mac_icon(MAC_DOCK_SIZE).save(BUILD / "icon-mac.png")


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

    # macOS 的两份是另一套画布（Apple 图标网格）。先自检再落盘：宁可报错退出，
    # 也不把「满幅」图标写进 .icns / Dock 位图。
    verify_mac_icon()
    write_mac_dock_png()
    write_icns()

    # 侧栏左上角的印章：4 套强调色 × 明/暗。图标固定 8 个文件，界面按
    # `data-accent` + 主题明暗挑一个 —— 颜色来自 tokens.css，不是手抄的。
    seal_dir = PUBLIC / "seal"
    seal_dir.mkdir(parents=True, exist_ok=True)
    tokens = read_accent_tokens()
    for (accent, kind), (base, ink) in sorted(tokens.items()):
        draw_accent_seal(SEAL_ICON_SIZE, base, ink).save(seal_dir / f"{accent}-{kind}.png")

    print(
        f"icons written to public/, public/seal/ ({len(tokens)} 个印章)、build/icon.ico、"
        "build/icon.icns 与 build/icon-mac.png"
    )


if __name__ == "__main__":
    main()
