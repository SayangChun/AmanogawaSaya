"""Rebuild walk / hop / bounce with denser, alternating gait frames."""

from __future__ import annotations

import json
import sys
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
from build_animations import OUT, process, save_seq  # noqa: E402

SESS = Path(
    r"C:\Users\ZenithChunyang\.grok\sessions"
    r"\E%3A%5Cproject%5CAmanogawaSaya\019fae8a-2e62-7cc3-aab3-381fd793ef00\images"
)
WALK_DIR = OUT / "walk"
HOP_DIR = OUT / "hop"


def load_existing(path: Path) -> Image.Image:
    return Image.open(path).convert("RGBA")


def p(name: str) -> Image.Image:
    return process(SESS / name, thr=18)


def main() -> None:
    # Snapshot existing polished frames before overwrite.
    walk00 = load_existing(WALK_DIR / "00.png")
    walk01_old = load_existing(WALK_DIR / "01.png")
    hop00 = load_existing(HOP_DIR / "00.png")
    hop01 = load_existing(HOP_DIR / "01.png")

    print("Processing walk keys...")
    # 8-frame alternating cycle:
    # A-half: contact → mid → high → reach
    # B-half: opposite contact → mid → soft pass → mild A reach (loops)
    w00 = walk00
    w01 = p("13.jpg")  # mid A
    w02 = p("16.jpg")  # high pass A
    w03 = p("15.jpg")  # reach A
    w04 = p("18.jpg")  # opposite contact B
    w05 = p("20.jpg")  # mid B
    w06 = walk01_old  # soft mid / both-feet-under bridge
    w07 = p("1.jpg")  # mild A-side mid-reach → contact A

    walk_frames = [w00, w01, w02, w03, w04, w05, w06, w07]
    print("Writing walk...")
    walk_paths = save_seq("walk", walk_frames)

    print("Processing hop keys...")
    h00 = hop00
    h01 = p("7.jpg")  # push-off
    h02 = hop01  # air
    h03 = p("10.jpg")  # higher peak
    h04 = p("8.jpg")  # land crouch
    h05 = walk01_old  # recover stand mid (not shy base)

    hop_frames = [h00, h01, h02, h03, h04, h05]
    print("Writing hop / bounce...")
    hop_paths = save_seq("hop", hop_frames)
    bounce_paths = save_seq("bounce", hop_frames)

    manifest_path = OUT / "manifest.json"
    data = json.loads(manifest_path.read_text(encoding="utf-8"))
    data["actions"]["walk"] = {
        "frames": walk_paths,
        "fps": 8,
        "loop": True,
        "duration": 3200,
        "holdLast": False,
    }
    data["actions"]["hop"] = {
        "frames": hop_paths,
        "fps": 8,
        "loop": False,
        "duration": 1400,
        "holdLast": False,
    }
    data["actions"]["bounce"] = {
        "frames": bounce_paths,
        "fps": 8,
        "loop": False,
        "duration": 1400,
        "holdLast": False,
    }
    manifest_path.write_text(
        json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )

    anim_js = ROOT / "src" / "character" / "anim-manifest.js"
    anim_js.write_text(
        "/** Auto-generated timing tuned for natural motion — fps from manifest */\n"
        "export const ANIM_MANIFEST = "
        + json.dumps(data, ensure_ascii=False, indent=2)
        + ";\n",
        encoding="utf-8",
    )
    print("Updated manifest + anim-manifest.js")
    print(f"walk={len(walk_paths)} hop={len(hop_paths)} bounce={len(bounce_paths)}")


if __name__ == "__main__":
    main()
