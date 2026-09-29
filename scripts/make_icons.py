"""Generate the PWA raster icons from the same design as public/favicon.svg."""

from PIL import Image, ImageDraw

SEAL = (178, 58, 46, 255)
PAPER = (251, 248, 243, 255)


def draw_icon(size: int) -> Image.Image:
    scale = size / 64
    image = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)

    # rounded seal square
    radius = round(13 * scale)
    draw.rounded_rectangle((0, 0, size - 1, size - 1), radius=radius, fill=SEAL)
    draw.rounded_rectangle(
        (4.5 * scale, 4.5 * scale, size - 4.5 * scale, size - 4.5 * scale),
        radius=round(10 * scale),
        outline=(251, 248, 243, 115),
        width=max(1, round(1.2 * scale)),
    )

    # three text rules + a full stop, mirroring favicon.svg
    width = max(2, round(3.4 * scale))
    for y, x2 in ((22, 46), (32, 46), (42, 35)):
        draw.line((18 * scale, y * scale, x2 * scale, y * scale), fill=PAPER, width=width)
    r = 3.6 * scale
    draw.ellipse((43.5 * scale - r, 42 * scale - r, 43.5 * scale + r, 42 * scale + r), fill=PAPER)
    return image


for dimension in (192, 512):
    icon = draw_icon(dimension)
    icon.save(rf"E:\repo\opennote\public\icon-{dimension}.png")
# apple touch icon doubles as a 180px variant of the same art
draw_icon(180).save(r"E:\repo\opennote\public\apple-touch-icon.png")
print("icons written")
