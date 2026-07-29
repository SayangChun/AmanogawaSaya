"""
Build VPet-style frame animation packs for Saya from generated pose keys.
- Keys pure-black background via edge flood-fill (keeps dark tights)
- Bottom-aligns to 512x768 transparent canvas
- Writes per-action frame folders + manifest.json
"""

from __future__ import annotations

import json
import shutil
from collections import deque
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
SESSION = Path(
    r"C:\Users\ZenithChunyang\.grok\sessions\E%3A%5Cproject%5CAmanogawaSaya\019fa180-d39d-73f3-a0e2-f2992a250f1f\images"
)
OUT = ROOT / "assets" / "animations"
BASE = OUT / "_base.png"
REF = ROOT / "原型参考"
SOFT = REF / "saya-uniform-soft.png"
SMILE = REF / "saya-uniform-smile.png"
WORRIED = REF / "saya-uniform-worried.png"

POSE_SRC = {
    "crouch": SESSION / "1.jpg",
    "sit": SESSION / "2.jpg",
    "wave1": SESSION / "3.jpg",
    "drag": SESSION / "4.jpg",
    "shy": SESSION / "5.jpg",
    "hop": SESSION / "6.jpg",
    "sleep": SESSION / "7.jpg",
    "walk_a": SESSION / "8.jpg",
    "celebrate": SESSION / "9.jpg",
    "walk_b": SESSION / "10.jpg",
    "stretch": SESSION / "11.jpg",
    "look": SESSION / "12.jpg",
    "idle_peak": SESSION / "13.jpg",
    "wave2": SESSION / "14.jpg",
    "nod": SESSION / "15.jpg",
    "walk_mid": SESSION / "16.jpg",
}

CANVAS = (512, 768)


def key_black_bg(im: Image.Image, thr: int = 18) -> Image.Image:
    """Flood-fill near-black from edges to alpha; preserve dark clothing inside."""
    im = im.convert("RGBA")
    w, h = im.size
    px = im.load()
    visited = [[False] * w for _ in range(h)]
    q: deque[tuple[int, int]] = deque()

    def is_bg(x: int, y: int) -> bool:
        r, g, b, _a = px[x, y]
        return r <= thr and g <= thr and b <= thr

    for x in range(w):
        for y in (0, h - 1):
            if is_bg(x, y):
                q.append((x, y))
                visited[y][x] = True
    for y in range(h):
        for x in (0, w - 1):
            if not visited[y][x] and is_bg(x, y):
                q.append((x, y))
                visited[y][x] = True

    while q:
        x, y = q.popleft()
        r, g, b, _a = px[x, y]
        px[x, y] = (r, g, b, 0)
        for nx, ny in ((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)):
            if 0 <= nx < w and 0 <= ny < h and not visited[ny][nx] and is_bg(nx, ny):
                visited[ny][nx] = True
                q.append((nx, ny))
    return im


def fit_canvas(im: Image.Image, size: tuple[int, int] = CANVAS) -> Image.Image:
    im = im.convert("RGBA")
    bbox = im.getbbox()
    if bbox:
        im = im.crop(bbox)
    tw, th = size
    scale = min(tw / im.width, th / im.height)
    nw = max(1, int(im.width * scale))
    nh = max(1, int(im.height * scale))
    im = im.resize((nw, nh), Image.Resampling.LANCZOS)
    canvas = Image.new("RGBA", size, (0, 0, 0, 0))
    x = (tw - nw) // 2
    y = th - nh
    canvas.paste(im, (x, y), im)
    return canvas


def strip_pink_stroke(im: Image.Image) -> Image.Image:
    """Remove VN hot-pink cutout stroke everywhere it appears.

    Must NOT eat dark tights / soft shadows / brown loafers. Earlier builds used
    dark magenta palette anchors (dist<=70) that matched black-tights AA and
    shoe leather, punching stocking-like holes in the legs.
    """
    import numpy as np

    arr = np.array(im.convert("RGBA"), dtype=np.uint8)
    rgb = arr[:, :, :3].astype(np.float32)
    a = arr[:, :, 3]
    # Hot-pink stroke only — no dark anchors that collide with tights/shoes.
    variants = np.array(
        [
            [215, 96, 141],
            [255, 120, 170],
            [230, 90, 150],
            [200, 80, 130],
            [255, 105, 180],
            [240, 100, 160],
            [231, 99, 148],
            [225, 87, 147],
            [218, 95, 141],
            [235, 110, 155],
            [210, 85, 140],
        ],
        dtype=np.float32,
    )
    diff = rgb[:, :, None, :] - variants[None, None, :, :]
    dist = np.sqrt((diff * diff).sum(axis=-1)).min(axis=-1)
    r, g, b = rgb[:, :, 0], rgb[:, :, 1], rgb[:, :, 2]
    mx = np.maximum(np.maximum(r, g), b)

    # Protect black tights / dark clothing / hair shadows
    protect_dark = mx <= 115

    # Protect brown loafers (warm, R-dominant, not magenta)
    protect_shoe = (
        (r >= 70)
        & (r <= 210)
        & (g >= 35)
        & (g <= 160)
        & (b <= 120)
        & ((r - b) >= 12)
        & (g >= b - 15)
        & ((r - g) <= 90)  # not neon pink
    )

    protect = protect_dark | protect_shoe

    # Magenta-pink stroke: bright R, elevated B vs G (not pure red bow / brown)
    magenta = (
        (r >= 160)
        & (g <= 170)
        & (b >= 100)
        & ((r - g) >= 40)
        & ((r - b) >= 15)
        & (b >= g - 5)
        & ((b - g) >= 5)
    )
    # Distance to hot-pink palette (tighter than before)
    near = dist <= 48
    stroke = (a > 0) & (~protect) & (
        (near & (r >= 150))
        | (magenta & (dist <= 75))
        | (magenta & (r >= 190) & (dist <= 95))
    )

    # Soft AA: semi-transparent magenta fringe only
    soft = (
        (a > 0)
        & (a < 250)
        & (~protect)
        & (r >= 150)
        & (g <= 180)
        & (b >= 100)
        & ((r - g) >= 30)
        & (b >= g - 5)
        & (dist <= 70)
    )

    remove = stroke | soft
    arr[remove] = 0

    # One dilate of removed area into remaining near-stroke pixels (AA clean)
    # Keep protect mask so tights/shoes never get fringe-eaten.
    pad = np.pad(remove, 1, constant_values=False)
    border = (
        pad[0:-2, 1:-1]
        | pad[2:, 1:-1]
        | pad[1:-1, 0:-2]
        | pad[1:-1, 2:]
    ) & (~remove)
    near2 = (
        border
        & (~protect)
        & (dist <= 55)
        & (r >= 150)
        & (r > g + 25)
        & (b >= g - 5)
        & (a > 0)
    )
    arr[near2] = 0

    arr[arr[:, :, 3] <= 10] = 0
    return Image.fromarray(arr, "RGBA")


def recolor_shy_blush(im: Image.Image) -> Image.Image:
    """Tint the generated shy cheek hatching pink instead of near-black."""
    import numpy as np

    arr = np.array(im.convert("RGBA"), dtype=np.uint8)
    h, w = arr.shape[:2]
    yy, xx = np.mgrid[:h, :w]
    rgb = arr[:, :, :3].astype(np.float32)
    a = arr[:, :, 3]
    r, g, b = rgb[:, :, 0], rgb[:, :, 1], rgb[:, :, 2]

    # The blush marks live in a small oval under the eyes. Limit the mask to
    # that area so hair, eye detail, and hand outlines keep their original tones.
    face_oval = (((xx - 258) / 62) ** 2 + ((yy - 112) / 23) ** 2) <= 1
    near_black_hatch = (
        (a > 0)
        & face_oval
        & (r <= 95)
        & (g <= 80)
        & (b <= 80)
        & ((np.maximum.reduce([r, g, b]) - np.minimum.reduce([r, g, b])) <= 42)
    )
    transparent_hatch = (a < 35) & face_oval & (xx >= 220) & (xx <= 302) & (yy >= 98) & (yy <= 126)

    if near_black_hatch.any() or transparent_hatch.any():
        shade = np.clip(0.55 + (95 - np.maximum.reduce([r, g, b])) / 120, 0.55, 1.0)
        pink = np.array([234, 104, 132], dtype=np.float32)
        softened = np.clip(pink[None, None, :] * shade[:, :, None], 0, 255)
        arr[near_black_hatch, :3] = softened[near_black_hatch].astype(np.uint8)
        arr[transparent_hatch, :3] = np.array([232, 98, 128], dtype=np.uint8)
        arr[transparent_hatch, 3] = 215

    return Image.fromarray(arr, "RGBA")


def process(src: Path, thr: int = 18, shy_blush: bool = False) -> Image.Image:
    im = key_black_bg(Image.open(src), thr=thr)
    im = strip_pink_stroke(im)
    im = fit_canvas(im)
    if shy_blush:
        im = recolor_shy_blush(im)
    return im


def save_seq(name: str, frames: list[Image.Image]) -> list[str]:
    d = OUT / name
    if d.exists():
        shutil.rmtree(d)
    d.mkdir(parents=True, exist_ok=True)
    paths: list[str] = []
    for i, im in enumerate(frames):
        p = d / f"{i:02d}.png"
        im.save(p, "PNG", optimize=True)
        paths.append(f"./assets/animations/{name}/{i:02d}.png")
    print(f"  {name}: {len(frames)} frames")
    return paths


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    print("Processing poses...")
    poses = {k: process(v, shy_blush=(k == "shy")) for k, v in POSE_SRC.items()}
    base = process(BASE, thr=12)
    soft = process(SOFT, thr=12)
    smile = process(SMILE, thr=12)
    try:
        process(WORRIED, thr=12)  # available if later needed
    except OSError:
        pass

    idle_frames = [base, poses["idle_peak"], soft, poses["idle_peak"]]
    breathe_frames = [base, soft, poses["idle_peak"], soft]
    sway_frames = [base, poses["look"], base, poses["walk_mid"], base]
    look_frames = [base, poses["look"], base]
    walk_frames = [poses["walk_a"], poses["walk_mid"], poses["walk_b"], base]
    hop_frames = [poses["crouch"], poses["hop"], poses["crouch"], base]
    sit_frames = [base, poses["crouch"], poses["sit"], poses["sit"]]
    stretch_frames = [base, poses["stretch"], poses["stretch"], base]
    calm_frames = [soft, base, soft]
    soft_action = [soft, base, soft]
    smile_frames = [base, smile, smile, base]
    nod_frames = [base, poses["nod"], base, poses["nod"], base]
    talk_frames = [base, smile, base, poses["idle_peak"], base]
    bounce_frames = hop_frames
    alert_frames = [base, poses["crouch"], poses["look"], base]
    shy_frames = [base, poses["shy"], poses["shy"], base]
    celebrate_frames = [base, poses["celebrate"], poses["hop"], poses["celebrate"], base]
    sleep_frames = [poses["sleep"], soft, poses["sleep"]]
    wave_frames = [base, poses["wave1"], poses["wave2"], poses["wave1"], base]
    drag_frames = [poses["drag"], poses["drag"]]

    print("Writing sequences...")
    # Natural desktop-pet timing — slower frame cuts read calmer on hard-swap sprites
    actions = {
        "idle": {
            "frames": save_seq("idle", idle_frames),
            "fps": 2.5,
            "loop": True,
            "duration": None,
            "holdLast": False,
        },
        "breathe": {
            "frames": save_seq("breathe", breathe_frames),
            "fps": 2,
            "loop": True,
            "duration": 4500,
            "holdLast": False,
        },
        "sway": {
            "frames": save_seq("sway", sway_frames),
            "fps": 2,
            "loop": False,
            "duration": 4200,
            "holdLast": False,
        },
        "look": {
            "frames": save_seq("look", look_frames),
            "fps": 1.5,
            "loop": False,
            "duration": 3200,
            "holdLast": False,
        },
        "walk": {
            "frames": save_seq("walk", walk_frames),
            "fps": 4,
            "loop": True,
            "duration": 2800,
            "holdLast": False,
        },
        "hop": {
            "frames": save_seq("hop", hop_frames),
            "fps": 5,
            "loop": False,
            "duration": 1100,
            "holdLast": False,
        },
        "sit": {
            "frames": save_seq("sit", sit_frames),
            "fps": 2.5,
            "loop": False,
            "duration": 4800,
            "holdLast": True,
        },
        "stretch": {
            "frames": save_seq("stretch", stretch_frames),
            "fps": 2,
            "loop": False,
            "duration": 2600,
            "holdLast": False,
        },
        "calm": {
            "frames": save_seq("calm", calm_frames),
            "fps": 1.5,
            "loop": False,
            "duration": 4200,
            "holdLast": False,
        },
        "coat": {
            "frames": save_seq("coat", soft_action),
            "fps": 1.5,
            "loop": False,
            "duration": 4200,
            "holdLast": False,
        },
        "soft": {
            "frames": save_seq("soft", soft_action),
            "fps": 1.5,
            "loop": False,
            "duration": 4000,
            "holdLast": False,
        },
        "smile": {
            "frames": save_seq("smile", smile_frames),
            "fps": 2,
            "loop": False,
            "duration": 3400,
            "holdLast": False,
        },
        "nod": {
            "frames": save_seq("nod", nod_frames),
            "fps": 3,
            "loop": False,
            "duration": 2000,
            "holdLast": False,
        },
        "talk": {
            "frames": save_seq("talk", talk_frames),
            "fps": 2.5,
            "loop": True,
            "duration": 3200,
            "holdLast": False,
        },
        "bounce": {
            "frames": save_seq("bounce", bounce_frames),
            "fps": 5,
            "loop": False,
            "duration": 1200,
            "holdLast": False,
        },
        "alert": {
            "frames": save_seq("alert", alert_frames),
            "fps": 3,
            "loop": False,
            "duration": 2600,
            "holdLast": False,
        },
        "shy": {
            "frames": save_seq("shy", shy_frames),
            "fps": 2,
            "loop": False,
            "duration": 3000,
            "holdLast": False,
        },
        "celebrate": {
            "frames": save_seq("celebrate", celebrate_frames),
            "fps": 3.5,
            "loop": False,
            "duration": 2600,
            "holdLast": False,
        },
        "sleep": {
            "frames": save_seq("sleep", sleep_frames),
            "fps": 1,
            "loop": True,
            "duration": None,
            "holdLast": False,
        },
        "wave": {
            "frames": save_seq("wave", wave_frames),
            "fps": 3,
            "loop": False,
            "duration": 2600,
            "holdLast": False,
        },
        "drag": {
            "frames": save_seq("drag", drag_frames),
            "fps": 1.5,
            "loop": True,
            "duration": None,
            "holdLast": False,
        },
    }

    base.save(OUT / "default.png", "PNG", optimize=True)
    smile.save(OUT / "default_smile.png", "PNG", optimize=True)

    # Lightweight JS-friendly export used by the app (no need to fetch json at runtime)
    js_export = {
        "version": 1,
        "canvas": list(CANVAS),
        "anchor": "bottom-center",
        "actions": actions,
    }
    with open(OUT / "manifest.json", "w", encoding="utf-8") as f:
        json.dump(js_export, f, ensure_ascii=False, indent=2)

    # Also write a pure module for easy import without fetch
    lines = [
        "/** Auto-generated by scripts/build_animations.py — do not edit by hand */",
        "export const ANIM_MANIFEST = " + json.dumps(js_export, ensure_ascii=False, indent=2) + ";",
        "",
    ]
    anim_js = ROOT / "src" / "character" / "anim-manifest.js"
    anim_js.write_text("\n".join(lines), encoding="utf-8")

    png_count = sum(1 for _ in OUT.rglob("*.png"))
    print(f"Done. actions={len(actions)} pngs={png_count}")
    print(f"Wrote {anim_js.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
