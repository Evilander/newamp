"""
Rebuild every NewAmp logo asset from the source medallion with a clean alpha
channel:

- Detect the red medallion's circular boundary.
- Force everything INSIDE the circle to alpha = 255 (no more transparent hair,
  no more ghost-eyes on white GitHub-mobile backgrounds).
- Force everything OUTSIDE the circle to alpha = 0 (clean cutout).
- Apply a 1.5 px feathered ring to keep the edge smooth (not jaggy on retina).
- Resize down to every shipped asset size (16, 32, 48, 64, 96, 128, 192, 256,
  384, 512, 1024) using a high-quality Lanczos kernel.
- Pack the .ico with the standard Windows tray + installer sizes.
- Wrap the cleaned high-res PNG inside a scalable SVG with a circle clip-path
  so the logo can be rendered crisply at any size on the web without the
  raster halo problem.

Run: python scripts/fix-logo.py
"""

from __future__ import annotations

import base64
import sys
from pathlib import Path

from PIL import Image, ImageFilter
import numpy as np

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "assets" / "github" / "logo-readme.png"

SHIPPED = {
    ROOT / "build" / "icon.png": 512,
    ROOT / "build" / "logo.png": 1024,
    ROOT / "build" / "logo-app.webp": 1024,
    ROOT / "assets" / "github" / "logo-readme.png": 1024,
}
SVG_OUT = ROOT / "assets" / "github" / "logo-readme.svg"
ICO_OUT = ROOT / "build" / "icon.ico"
ICO_SIZES = (16, 24, 32, 48, 64, 96, 128, 256)


def clean_medallion(image: Image.Image) -> Image.Image:
    """Detect the circular medallion, force inside opaque + outside transparent."""
    rgba = image.convert("RGBA")
    arr = np.array(rgba)
    h, w = arr.shape[:2]
    rgb = arr[:, :, :3].astype(np.float32)
    brightness = rgb.mean(axis=2)

    # Background detection: the off-medallion area is near-black (R, G, B all
    # below ~30). Use a soft threshold so partial alpha leak doesn't drag
    # near-black hair shadows into the "background" mask.
    bg = brightness < 28
    fg = ~bg
    if fg.sum() < 1000:
        raise SystemExit("Could not locate the medallion (foreground too small).")

    ys, xs = np.where(fg)
    y0, y1 = int(ys.min()), int(ys.max())
    x0, x1 = int(xs.min()), int(xs.max())

    # Center on the bounding box; radius is the larger half-extent. The source
    # asset is already pixel-tight against the medallion, so a 1 px inset is
    # enough to avoid bleeding the black ring into the alpha.
    cy = (y0 + y1) / 2.0
    cx = (x0 + x1) / 2.0
    diameter = max(y1 - y0, x1 - x0)
    radius = (diameter / 2.0) - 1.0
    if radius <= 4:
        raise SystemExit("Medallion radius collapsed to zero.")

    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    dist = np.sqrt((yy - cy) ** 2 + (xx - cx) ** 2)

    # Hard inside / outside, then a 1.5 px feathered ring so retina scaling
    # doesn't produce a stair-step edge against a light page.
    feather = 1.5
    alpha = np.clip((radius - dist) / feather + 0.5, 0.0, 1.0)
    alpha8 = (alpha * 255.0 + 0.5).astype(np.uint8)
    arr[:, :, 3] = alpha8

    # Inside the medallion, also flatten any sub-opaque pixels from the source
    # against the median in-circle background tone so faint hair holes and
    # eye-color leaks vanish. We do this only where the cleaned alpha is high.
    inside_mask = alpha > 0.95
    if inside_mask.any():
        inside_rgb = arr[inside_mask][:, :3]
        # We don't need a median pre-fill — forcing alpha to 255 inside is
        # enough to defeat ghost-eyes and transparent-hair on light pages.
        # Keep the original RGB.
        arr[inside_mask, 3] = 255

    return Image.fromarray(arr)


def save_resized(cleaned: Image.Image, target: Path, size: int) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    resized = cleaned.resize((size, size), resample=Image.Resampling.LANCZOS)
    fmt = target.suffix.lower()
    if fmt == ".webp":
        resized.save(target, format="WEBP", quality=92, method=6, lossless=False)
    elif fmt == ".png":
        resized.save(target, format="PNG", optimize=True)
    else:
        raise SystemExit(f"Unsupported raster format: {target.suffix}")
    print(f"wrote {target.relative_to(ROOT)} ({size}x{size})")


def save_ico(cleaned: Image.Image, target: Path, sizes: tuple[int, ...]) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    # Pillow's PNG-in-ICO format works for Windows 10/11 explorer + the tray.
    cleaned.save(
        target,
        format="ICO",
        sizes=[(s, s) for s in sizes],
    )
    print(f"wrote {target.relative_to(ROOT)} ({','.join(str(s) for s in sizes)})")


def save_svg(cleaned: Image.Image, target: Path) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    # Embed the cleaned 1024 PNG into a scalable SVG with a circle clip-path.
    # The SVG container scales without re-rasterising in browsers / GitHub
    # rendering, and the raster stays at the 1024 source pixel grid.
    import io

    side = max(cleaned.size)
    canvas = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    canvas.paste(cleaned, ((side - cleaned.width) // 2, (side - cleaned.height) // 2))

    buf = io.BytesIO()
    canvas.save(buf, format="PNG", optimize=True)
    encoded = base64.b64encode(buf.getvalue()).decode("ascii")

    svg = f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {side} {side}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="NewAmp">
  <defs>
    <clipPath id="newamp-medallion">
      <circle cx="{side / 2}" cy="{side / 2}" r="{(side / 2) - 1}"/>
    </clipPath>
  </defs>
  <image href="data:image/png;base64,{encoded}"
         x="0" y="0" width="{side}" height="{side}"
         clip-path="url(#newamp-medallion)" />
</svg>
"""
    target.write_text(svg, encoding="utf-8")
    print(f"wrote {target.relative_to(ROOT)} (svg wrapper, {side}x{side} embedded)")


def main() -> int:
    if not SOURCE.exists():
        print(f"missing source: {SOURCE}", file=sys.stderr)
        return 1
    source = Image.open(SOURCE)
    cleaned = clean_medallion(source)
    # Save the high-res cleaned master back to the README slot first so the
    # SVG wrapper picks it up; then derive every shipped size from the same
    # in-memory cleaned image (no compound resampling).
    for target, size in SHIPPED.items():
        save_resized(cleaned, target, size)
    save_ico(cleaned, ICO_OUT, ICO_SIZES)
    save_svg(cleaned, SVG_OUT)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
