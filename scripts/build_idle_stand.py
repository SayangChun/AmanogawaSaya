"""
Build anti-flicker default standing (idle) frame animation for Saya.

Why procedural (not multi-source cutouts):
  The previous idle mixed base / idle_peak / soft art with large silhouette
  jumps (mean channel diff ~226). Hard-cut swaps then looked like flicker
  and limb/hair pop (穿模).

Approach:
  - Single clean sprite at native size: assets/animations/default.png
    (same scale/feet as other actions → no size pop when returning to idle)
  - Continuous warp: feet locked, torso breathes, hair secondary sway
  - Frame 0 is a bit-exact copy of default.png for seamless action→idle
  - Integer harmonics only so last→first loop closes
  - Writes idle/ + breathe/ and patches manifest + anim-manifest.js
"""

from __future__ import annotations

import json
import math
import shutil
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "assets" / "animations"
DEFAULT = OUT / "default.png"
CANVAS = (512, 768)

# Subtle desktop-pet motion (px at full strength). Keep small to avoid
# hair-tip clipping at canvas top and resampling sparkle on fine strands.
BREATH_PX = 1.8
SWAY_PX = 1.4
HAIR_PX = 1.5


def sample_bilinear(arr: np.ndarray, ys: np.ndarray, xs: np.ndarray) -> np.ndarray:
    h, w = arr.shape[:2]
    valid = (ys >= 0) & (ys <= h - 1) & (xs >= 0) & (xs <= w - 1)

    y0 = np.floor(ys).astype(np.int32)
    x0 = np.floor(xs).astype(np.int32)
    y1 = y0 + 1
    x1 = x0 + 1

    y0c = np.clip(y0, 0, h - 1)
    y1c = np.clip(y1, 0, h - 1)
    x0c = np.clip(x0, 0, w - 1)
    x1c = np.clip(x1, 0, w - 1)

    wy = (ys - y0)[..., None]
    wx = (xs - x0)[..., None]
    w00 = (1 - wy) * (1 - wx)
    w01 = (1 - wy) * wx
    w10 = wy * (1 - wx)
    w11 = wy * wx

    out = (
        arr[y0c, x0c] * w00
        + arr[y0c, x1c] * w01
        + arr[y1c, x0c] * w10
        + arr[y1c, x1c] * w11
    )
    out[~valid] = 0
    return out


def content_bbox(arr: np.ndarray, thr: int = 10) -> tuple[int, int, int, int]:
    a = arr[:, :, 3]
    ys, xs = np.where(a > thr)
    if len(xs) == 0:
        h, w = a.shape
        return 0, 0, w - 1, h - 1
    return int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max())


def warp_stand(
    arr: np.ndarray,
    *,
    breath: float,
    sway: float,
    hair: float,
) -> np.ndarray:
    """
    breath: -1..1  + = inhale (shoulders rise, slight chest widen)
    sway:   -1..1  lean shear from feet
    hair:   -1..1  extra upper-strand drift
    Feet stay planted.
    """
    h, w = arr.shape[:2]
    x0, y0, x1, y1 = content_bbox(arr)
    foot_y = float(y1)
    cx = 0.5 * (x0 + x1)

    yy, xx = np.mgrid[0:h, 0:w].astype(np.float64)
    height = max(1.0, foot_y - y0)
    t = np.clip((foot_y - yy) / height, 0.0, 1.2)

    foot_lock = np.clip((t - 0.05) / 0.10, 0.0, 1.0)
    torso = np.clip((t - 0.22) / 0.48, 0.0, 1.0)
    torso = torso * torso
    hair_w = np.clip((t - 0.55) / 0.40, 0.0, 1.0)
    hair_w = hair_w * hair_w

    # Vertical breathe. Base art's hair tips already touch y=0, so favor
    # gentle lift; slight tip clip is preferable to asymmetric inhale/exhale.
    dy = breath * BREATH_PX * torso * foot_lock

    expand = breath * 0.006 * torso * foot_lock
    src_x_body = cx + (xx - cx) / (1.0 + expand + 1e-6)

    dx_sway = sway * SWAY_PX * t * foot_lock
    dx_hair = hair * HAIR_PX * hair_w * foot_lock

    src_x = src_x_body - dx_sway - dx_hair
    src_y = yy + dy

    out = sample_bilinear(arr, src_y, src_x)
    out[out[:, :, 3] < 1.5] = 0
    return out


def to_png(arr: np.ndarray) -> Image.Image:
    arr = np.clip(np.nan_to_num(arr, nan=0.0), 0, 255).astype(np.uint8)
    return Image.fromarray(arr, "RGBA")


def make_cycle(
    base: np.ndarray,
    n: int,
    *,
    breath_amp: float,
    sway_amp: float,
    hair_amp: float,
) -> list[Image.Image]:
    """
    Seamless loop. Frame 0 is bit-exact base (all drives zero at θ=0).

    Breath is *exhale-only* (always ≤ 0):
      breath = amp * (cosθ - 1) / 2   →  0 → -amp → 0
    The base sprite's hair already touches y=0; lifting on inhale would clip
    tips and make the cycle lopsided. Settling the torso down then returning
    reads as a calm breathe while feet stay planted.

      sway ~ sinθ (+ tiny sin2θ)
      hair ~ sin2θ   (secondary, period-closes)
    """
    frames: list[Image.Image] = []
    for i in range(n):
        if i == 0:
            # Exact neutral — matches other actions' default stand
            frames.append(to_png(base.copy()))
            continue
        ang = 2.0 * math.pi * i / n
        # 0 at i=0 and i=n, peak exhale (-amp) at i=n/2
        breath = breath_amp * (math.cos(ang) - 1.0) * 0.5
        sway = sway_amp * (0.88 * math.sin(ang) + 0.12 * math.sin(2 * ang))
        hair = hair_amp * math.sin(2.0 * ang)
        frames.append(to_png(warp_stand(base, breath=breath, sway=sway, hair=hair)))
    return frames


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
    print(f"  {name}: {len(frames)} frames → {d}")
    return paths


def patch_manifest(idle_paths: list[str], breathe_paths: list[str]) -> None:
    man_path = OUT / "manifest.json"
    data = json.loads(man_path.read_text(encoding="utf-8"))
    data["actions"]["idle"] = {
        "frames": idle_paths,
        # 8 frames @ 2.5fps ≈ 3.2s/cycle — calm, natural breathing
        "fps": 2.5,
        "loop": True,
        "duration": None,
        "holdLast": False,
    }
    data["actions"]["breathe"] = {
        "frames": breathe_paths,
        "fps": 2,
        "loop": True,
        "duration": 4500,
        "holdLast": False,
    }
    man_path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    anim_js = ROOT / "src" / "character" / "anim-manifest.js"
    lines = [
        "/** Auto-generated — idle/breathe via scripts/build_idle_stand.py */",
        "export const ANIM_MANIFEST = "
        + json.dumps(data, ensure_ascii=False, indent=2)
        + ";",
        "",
    ]
    anim_js.write_text("\n".join(lines), encoding="utf-8")
    print(f"  patched {man_path.relative_to(ROOT)}")
    print(f"  patched {anim_js.relative_to(ROOT)}")


def verify(frames: list[Image.Image], label: str, base_ref: np.ndarray) -> None:
    print(f"  verify [{label}]:")
    # frame0 must match default
    f0 = np.array(frames[0], dtype=np.int16)
    ref = base_ref.astype(np.int16)
    if not np.array_equal(f0, ref):
        d = np.abs(f0 - ref).sum(axis=2)
        print(f"    ⚠ frame0 ≠ default (max channel-sum diff {d.max()})")
    else:
        print("    frame0 == default.png  ✓")

    prev = None
    first_arr = f0
    for i, im in enumerate(frames):
        arr = np.array(im, dtype=np.int16)
        a = arr[:, :, 3]
        ys, xs = np.where(a > 10)
        bbox = (int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max()))
        if prev is None:
            print(f"    [{i:02d}] bbox={bbox} opaque={(a > 10).sum()}")
            prev = arr
            continue
        d = np.abs(arr - prev).sum(axis=2)
        mask = (a > 10) | (prev[:, :, 3] > 10)
        mean_d = float(d[mask].mean()) if mask.any() else 0.0
        pys, pxs = np.where(prev[:, :, 3] > 10)
        pb = (int(pxs.min()), int(pys.min()), int(pxs.max()), int(pys.max()))
        bbox_shift = max(abs(bbox[j] - pb[j]) for j in range(4))
        foot_shift = abs(bbox[3] - pb[3])
        flag = " ⚠ FOOT" if foot_shift else ""
        print(
            f"    [{i:02d}] bbox={bbox} mean_diff={mean_d:.1f} "
            f"bbox_shift={bbox_shift} foot_dy={foot_shift}{flag}"
        )
        prev = arr

    last = np.array(frames[-1], dtype=np.int16)
    d = np.abs(first_arr - last).sum(axis=2)
    mask = (first_arr[:, :, 3] > 10) | (last[:, :, 3] > 10)
    loop_d = float(d[mask].mean()) if mask.any() else 0.0
    a1 = np.array(frames[1], dtype=np.int16)
    d01 = np.abs(a1 - first_arr).sum(axis=2)
    m01 = (a1[:, :, 3] > 10) | (first_arr[:, :, 3] > 10)
    step01 = float(d01[m01].mean()) if m01.any() else 0.0
    ratio = loop_d / step01 if step01 > 1e-6 else 0.0
    ok = "OK" if ratio < 1.35 else "⚠ LOOP GAP"
    print(f"    loop last→first={loop_d:.1f} vs 0→1={step01:.1f} ratio={ratio:.2f} {ok}")


def main() -> None:
    if not DEFAULT.exists():
        raise SystemExit(f"missing base sprite: {DEFAULT}")

    im = Image.open(DEFAULT).convert("RGBA")
    if im.size != CANVAS:
        raise SystemExit(f"default.png must be {CANVAS}, got {im.size}")
    base = np.array(im, dtype=np.float32)
    x0, y0, x1, y1 = content_bbox(base)
    print(f"base bbox=({x0},{y0},{x1},{y1}) feet_y={y1}")

    print("Building idle (default stand)…")
    idle = make_cycle(base, 8, breath_amp=1.0, sway_amp=1.0, hair_amp=0.85)
    verify(idle, "idle", base)
    idle_paths = save_seq("idle", idle)

    print("Building breathe (deeper stand breath)…")
    breathe = make_cycle(base, 6, breath_amp=1.2, sway_amp=0.35, hair_amp=0.55)
    verify(breathe, "breathe", base)
    breathe_paths = save_seq("breathe", breathe)

    patch_manifest(idle_paths, breathe_paths)
    print("Done.")


if __name__ == "__main__":
    main()
