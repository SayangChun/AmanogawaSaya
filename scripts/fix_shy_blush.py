"""Recolor current shy animation cheek hatching from black to pink."""

from __future__ import annotations

from pathlib import Path
import sys

from PIL import Image

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from scripts.build_animations import ROOT, recolor_shy_blush


def main() -> None:
    shy_dir = ROOT / "assets" / "animations" / "shy"
    for path in sorted(shy_dir.glob("*.png")):
        if not path.stem.isdigit():
            continue
        im = Image.open(path).convert("RGBA")
        fixed = recolor_shy_blush(im)
        fixed.save(path, "PNG", optimize=True)
        print(f"fixed {path.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
