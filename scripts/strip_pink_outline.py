"""
Standalone: strip pink cutout strokes from assets/animations/**/*.png

Prefer rebuilding via build_animations.py (includes this step). Use this
script only to re-process existing PNG packs without regenerating poses.
"""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from scripts.build_animations import strip_pink_stroke  # noqa: E402
from PIL import Image  # noqa: E402

ANIM = ROOT / "assets" / "animations"


def main() -> None:
    import numpy as np

    paths = [
        p
        for p in sorted(ANIM.rglob("*.png"))
        if not p.name.startswith("_debug")
    ]
    n = 0
    for p in paths:
        im = Image.open(p)
        out = strip_pink_stroke(im)
        if not np.array_equal(np.array(im.convert("RGBA")), np.array(out)):
            out.save(p, "PNG", optimize=True)
            n += 1
            print(f"  cleaned {p.relative_to(ANIM)}")
    print(f"Done. rewritten={n}/{len(paths)}")


if __name__ == "__main__":
    main()
