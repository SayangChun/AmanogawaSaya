/**
 * 天之川沙夜 · 角色设定（贴合《仰望夜空的星辰》气质）
 * 桌宠形态：VPet 风格全身立绘 + 差分切换
 */

export const CHARACTER = {
  id: "amanogawa-saya",
  name: "天之川沙夜",
  shortName: "沙夜",
  series: "《仰望夜空的星辰》",
  titles: {
    default: "天文社的学妹",
    close: "一起看星星的人",
  },
  colors: {
    hair: "#e8eef8",
    eyeGold: "#c9a227",
    eyeBlue: "#4a9fd4",
    ribbon: "#5ec8e8",
    uniform: "#2a3d6b",
    accent: "#9bbdff",
    night: "#0b1220",
  },
  /**
   * 全身立绘默认帧（VPet 帧动画见 assets/animations/ + anim-manifest.js）。
   */
  bodies: {
    default: "./assets/animations/default.png",
    smile: "./assets/animations/default_smile.png",
    soft: "./assets/animations/soft/00.png",
    coat: "./assets/animations/coat/00.png",
    calm: "./assets/animations/calm/00.png",
    excite: "./assets/animations/celebrate/01.png",
    happy: "./assets/animations/smile/01.png",
  },
};

export const AFFINITY_RANKS = [
  { min: 0, id: "stranger", title: "偶尔遇见的同窗", stars: 1 },
  { min: 20, id: "clubmate", title: "天文社的学妹", stars: 2 },
  { min: 40, id: "familiar", title: "会记得你名字的人", stars: 3 },
  { min: 60, id: "stargazer", title: "可以一起观星的人", stars: 4 },
  { min: 80, id: "constellation", title: "最想分享夜空的人", stars: 5 },
  { min: 100, id: "orbit", title: "永远的星轨", stars: 6 },
];

export function getAffinityRank(affinity) {
  const value = Math.max(0, Math.min(100, Number(affinity) || 0));
  let current = AFFINITY_RANKS[0];
  for (const rank of AFFINITY_RANKS) {
    if (value >= rank.min) current = rank;
  }
  return { ...current, value };
}
