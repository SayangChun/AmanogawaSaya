"""
Build crouch / lie / prone action frame packs for Saya.
Reuses process() helpers from build_animations.py; merges into manifest.
"""

from __future__ import annotations

import json
import shutil
import sys
from pathlib import Path

# Import processing pipeline
sys.path.insert(0, str(Path(__file__).resolve().parent))
from build_animations import (  # noqa: E402
    CANVAS,
    OUT,
    ROOT,
    fit_canvas,
    key_black_bg,
    process,
    strip_pink_stroke,
)

SESSION = Path(
    r"C:\Users\ZenithChunyang\.grok\sessions\E%3A%5Cproject%5CAmanogawaSaya\019fb0ac-01c3-7683-8be3-9b778af9085a\images"
)

# Key pose sources (raw Imagine edits) — classified by content height:
# tall crouch: 2/7 · short lie: 5/6 · mid prone: 1/8
POSE_SRC = {
    "crouch_main": SESSION / "2.jpg",
    "crouch_soft": SESSION / "7.jpg",
    "lie_main": SESSION / "5.jpg",
    "lie_sleep": SESSION / "6.jpg",
    "prone_main": SESSION / "1.jpg",
    "prone_soft": SESSION / "8.jpg",
}


def save_seq(name: str, frames: list) -> list[str]:
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


def load_existing(rel: str):
    p = ROOT / rel.lstrip("./").replace("/", "\\") if "\\" in str(ROOT) else ROOT / rel.lstrip("./")
    # pathlib handles /
    p = ROOT / rel.replace("./", "")
    if not p.exists():
        raise FileNotFoundError(p)
    return p


def main() -> None:
    print("Processing rest poses...")
    poses = {}
    for k, src in POSE_SRC.items():
        if not src.exists():
            print(f"  skip missing {k}: {src.name}")
            continue
        poses[k] = process(src, thr=18)
        print(f"  ok {k}")

    if "prone_soft" not in poses and "prone_main" in poses:
        poses["prone_soft"] = poses["prone_main"]

    base = process(OUT / "_base.png", thr=12)
    # Transition helpers from existing packs
    sit_hold = Image_open_rgba(OUT / "sit" / "03.png")
    hop_pre = Image_open_rgba(OUT / "hop" / "00.png")
    soft = Image_open_rgba(OUT / "soft" / "01.png")

    crouch_m = poses["crouch_main"]
    crouch_s = poses.get("crouch_soft", crouch_m)
    lie_m = poses["lie_main"]
    lie_s = poses.get("lie_sleep", lie_m)
    prone_m = poses["prone_main"]
    prone_s = poses.get("prone_soft", prone_m)

    # Sequences: transition → hold with micro-idle
    crouch_frames = [base, hop_pre, crouch_m, crouch_s, crouch_m]
    lie_frames = [sit_hold, crouch_m, lie_m, lie_s, lie_m]
    prone_frames = [crouch_m, prone_m, prone_s, prone_m]

    actions_new = {
        "crouch": {
            "frames": save_seq("crouch", crouch_frames),
            "fps": 2.5,
            "loop": False,
            "duration": 12000,
            "holdLast": True,
        },
        "lie": {
            "frames": save_seq("lie", lie_frames),
            "fps": 2,
            "loop": False,
            "duration": 16000,
            "holdLast": True,
        },
        "prone": {
            "frames": save_seq("prone", prone_frames),
            "fps": 2.2,
            "loop": False,
            "duration": 14000,
            "holdLast": True,
        },
    }

    # Merge into manifest.json
    man_path = OUT / "manifest.json"
    with open(man_path, encoding="utf-8") as f:
        man = json.load(f)
    man["actions"].update(actions_new)

    # Enrich "rest" to include new low postures as a longer multi-pose settle
    man["actions"]["rest"] = {
        "frames": [
            "./assets/animations/calm/00.png",
            "./assets/animations/soft/01.png",
            "./assets/animations/sit/01.png",
            "./assets/animations/sit/03.png",
            "./assets/animations/crouch/02.png",
            "./assets/animations/crouch/03.png",
        ],
        "fps": 2.2,
        "loop": False,
        "duration": 14000,
        "holdLast": True,
    }

    with open(man_path, "w", encoding="utf-8") as f:
        json.dump(man, f, ensure_ascii=False, indent=2)

    # Write anim-manifest.js
    anim_js = ROOT / "src" / "character" / "anim-manifest.js"
    anim_js.write_text(
        "/** Auto-generated timing tuned for natural motion — fps from manifest */\n"
        "export const ANIM_MANIFEST = "
        + json.dumps(man, ensure_ascii=False, indent=2)
        + ";\n",
        encoding="utf-8",
    )
    print(f"Merged actions: {', '.join(actions_new)}")
    print(f"Wrote {man_path.relative_to(ROOT)} and {anim_js.relative_to(ROOT)}")


def Image_open_rgba(path: Path):
    from PIL import Image

    return Image.open(path).convert("RGBA")


if __name__ == "__main__":
    main()
