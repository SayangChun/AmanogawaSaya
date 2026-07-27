"""
Crop face-only squares for the floating orb.
Face is geometrically centered in the output (pad if near image edge).
"""
from __future__ import annotations

from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "assets" / "faces"
OUT.mkdir(parents=True, exist_ok=True)

# Each crop: source, face center (cx, cy) as 0–1 ratios of width/height,
# and square side as fraction of source WIDTH (keeps scale consistent).
# Centers target the middle of the face (between eyes / nose bridge).
CROPS = {
    # default ← saya-uniform.jpg face（略偏右取景，抵消头向左倾）
    "default": {
        "src": "assets/portraits/uniform.jpg",
        "cx": 0.515,
        "cy": 0.114,
        "side": 0.270,
        "bg": (255, 255, 255, 255),
    },
    "calm": {
        "src": "assets/portraits/idle.jpg",
        "cx": 0.500,
        "cy": 0.34,
        "side": 0.70,
        "bg": (0, 0, 0, 255),
    },
    "happy": {
        "src": "assets/portraits/smile.png",
        "cx": 0.510,
        "cy": 0.122,
        "side": 0.320,
        "bg": (0, 0, 0, 255),
    },
    "soft": {
        "src": "assets/portraits/soft.png",
        "cx": 0.510,
        "cy": 0.122,
        "side": 0.320,
        "bg": (0, 0, 0, 255),
    },
    "coat": {
        "src": "assets/portraits/coat.jpg",
        "cx": 0.505,
        "cy": 0.105,
        "side": 0.285,
        "bg": (255, 255, 255, 255),
    },
    "excite": {
        "src": "assets/portraits/fullbody.png",
        "cx": 0.505,
        "cy": 0.100,
        "side": 0.285,
        "bg": (0, 0, 0, 255),
    },
}


def crop_face_centered(
    im: Image.Image,
    cx: float,
    cy: float,
    side: float,
    bg: tuple[int, int, int, int],
) -> Image.Image:
    """Return a square crop with (cx, cy) at the exact center of the square."""
    w, h = im.size
    # side in pixels — based on width so face scale is comparable across arts
    s = max(32, int(round(w * side)))
    # Center pixel of face in source
    fcx = cx * w
    fcy = cy * h

    # Ideal crop box in source coords (may go outside)
    left = fcx - s / 2
    top = fcy - s / 2
    right = left + s
    bottom = top + s

    # Region that actually overlaps the image
    src_left = max(0, int(left))
    src_top = max(0, int(top))
    src_right = min(w, int(right))
    src_bottom = min(h, int(bottom))

    piece = im.crop((src_left, src_top, src_right, src_bottom))

    # Paste onto square canvas so face center stays at canvas center
    canvas = Image.new("RGBA", (s, s), bg)
    paste_x = int(round(src_left - left))
    paste_y = int(round(src_top - top))
    canvas.paste(piece, (paste_x, paste_y))
    return canvas


def main() -> None:
    size = 512
    for name, cfg in CROPS.items():
        src = ROOT / cfg["src"]
        if not src.exists():
            print("missing", src)
            continue
        im = Image.open(src).convert("RGBA")
        crop = crop_face_centered(
            im,
            cx=cfg["cx"],
            cy=cfg["cy"],
            side=cfg["side"],
            bg=tuple(cfg["bg"]),
        )
        out = crop.resize((size, size), Image.Resampling.LANCZOS)
        out_path = OUT / f"{name}.png"
        out.save(out_path, "PNG")
        print(
            f"wrote {out_path.relative_to(ROOT)}  "
            f"center=({cfg['cx']:.3f},{cfg['cy']:.3f}) side={cfg['side']:.3f}"
        )


if __name__ == "__main__":
    main()
