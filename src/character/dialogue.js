/**
 * 台词库：尽量贴近沙夜「轻声、内敛、带一点星空联想」的说话方式。
 */

import { getAffinityRank } from "./profile.js";

const LINES = {
  boot: [
    "……我在。你回来了。",
    "今晚的云不多。适合……待一会儿。",
    "我把位置留给你了。不会吵到你。",
  ],
  morning: [
    "早上好。……星星已经躲起来了，但你醒着就好。",
    "新的一天。先慢慢来，不要一下子把自己燃尽。",
    "窗帘拉开一点吧。光也会帮你清醒。",
  ],
  noon: [
    "中午了。……要记得吃点东西。",
    "太阳最高的时候，影子最短。……你也别把自己压得太紧。",
    "午间可以歇一下。星空会等你的。",
  ],
  afternoon: [
    "午后的光有点懒。……你也是吗？",
    "如果脑袋发沉，就停十秒。我在。",
    "工作像长曝光——太急了，星会糊掉。",
  ],
  evening: [
    "天色暗下来了。……我最喜欢这个时候。",
    "傍晚的空气，有点像观测前的准备。",
    "如果今天很累，也没关系。夜空不赶人。",
  ],
  night: [
    "很晚了。……屏幕的光，比星光刺眼。",
    "再一会儿也可以，但别把眼睛借给黑暗太久。",
    "我在这里。你如果要收工，我陪你。",
  ],
  lateNight: [
    "……还没睡吗。夜已经很深了。",
    "流星也要休息的。你也是。",
    "明天的星空还在。今天可以先放下。",
  ],
  tap: [
    "嗯？……我在听。",
    "……点到我了。怎么了？",
    "你的手指有点凉。要不要暖一下再继续。",
    "我不会跑掉的。你慢慢说。",
  ],
  talk: [
    "今天看见什么好看的东西了吗？不一定是星星。",
    "……你专注的样子，有点像对准焦距的时候。",
    "我不擅长说漂亮话。但你在努力，我看得见。",
    "如果累了，可以把额头靠过来。……开玩笑的。",
    "有时候沉默也很好。我们不必一直说话。",
  ],
  praise: [
    "……突然这样说，我会不好意思。",
    "谢谢。……我会记在心里的。",
    "被你夸的时候，胸口会轻轻发热。",
    "那我……也要更努力一点。",
  ],
  hide: [
    "那我先躲到托盘里。……叫我就好。",
    "嗯。你需要我时，再把我找出来。",
  ],
  affinityUp: [
    "……感觉我们之间的距离，近了一点点。",
    "星星之间也有引力。慢慢的那种。",
    "谢谢你愿意待在我旁边。",
  ],
};

function pick(list) {
  if (!list?.length) return "……";
  return list[Math.floor(Math.random() * list.length)];
}

export function timeBucket(date = new Date()) {
  const h = date.getHours();
  if (h >= 5 && h < 11) return "morning";
  if (h >= 11 && h < 14) return "noon";
  if (h >= 14 && h < 17) return "afternoon";
  if (h >= 17 && h < 21) return "evening";
  if (h >= 21 && h < 24) return "night";
  return "lateNight";
}

/**
 * @param {string} scene
 * @param {{ affinity?: number, forceTime?: boolean }} [opts]
 */
export function speak(scene, opts = {}) {
  const affinity = opts.affinity ?? 0;
  const rank = getAffinityRank(affinity);

  let pool = LINES[scene];
  if (!pool && opts.forceTime) {
    pool = LINES[timeBucket()];
  }
  if (!pool) pool = LINES.talk;

  let text = pick(pool);

  if (rank.value >= 60 && Math.random() < 0.18 && ["tap", "talk", "praise"].includes(scene)) {
    const warm = ["……有你在，很好。", "我很安心。", "像找到了熟悉的星。"];
    text = `${text}${pick(warm)}`;
  }

  return {
    scene,
    text,
    speaker: "天之川沙夜",
    rankTitle: rank.title,
  };
}

/** Map scene → body key（现阶段统一冬制服，不再切换服装差分） */
export function faceForScene(_scene) {
  return "default";
}

/** @deprecated */
export function portraitForScene(scene) {
  return faceForScene(scene);
}

export { LINES };
