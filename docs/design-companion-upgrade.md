# 改造蓝图 · 从桌宠到长期陪伴伴侣

> **2026-10-30 更新**：本蓝图里的 P2「接入 LLM」已**整体移除**——`persona.js` / `config-store.js` / `llm-engine.js` 删除，`llm:*` 与 `chat:stream` IPC 下线，聊天统一走本地规则引擎。原因：LLM 需要自备 API Key 并按量付费，项目不再承担这笔开销。下文关于 LLM 的描述仅作历史记录。

- **日期**：2026-10-20
- **前置**：`docs/analysis-2026-10-20.md`（代码走查）
- **定位变更**：v0.4.0 是「VPet 帧动画桌宠」——本质是动画播放器 + 随机台词池。新定位：**长期陪伴伴侣**，核心能力 = 记忆 / 智能 / 可沟通 / 有主动性。旧代码大规模重构，帧动画体系作为「身体」保留复用。
- **总原则**：离线永远可用；每一步都可运行；记忆数据可读、可迁移、可导出；不引入需要原生编译的依赖。

---

## 1. 新架构：四层

```
┌─────────────────────────────────────────────┐
│ 表达层（她说什么、怎么做）                     │  dialogue 管线 → 情绪/动作选择
├─────────────────────────────────────────────┤
│ 沟通层（你怎么跟她说话）                       │  chat 面板（输入/流式逐字/记住这句）
├─────────────────────────────────────────────┤
│ 引擎层（她怎么想）                             │  本地规则引擎 + 可选 LLM 引擎
├─────────────────────────────────────────────┤
│ 记忆层（她经历过什么）                         │  事件流/事实卡/约定跟进/情绪状态/日记
├─────────────────────────────────────────────┤
│ 身体层（保留复用）⭐ 不推翻                   │  frame animation + zone/wander + 窗口锚点
└─────────────────────────────────────────────┘
```

关键判断：**现有帧动画系统是她最好的资产，是「身体」而不是「玩具」**——118 帧、行为链、分区姿势、拖拽拎起全部保留，新增的一切都通过「这句话配什么表情」来驱动员已有动作。

## 2. 各层设计

### 2.1 记忆层（新增 `src/memory/`）

存储位置从 renderer localStorage 迁到主进程 `userData/saya/`（可备份、可迁移、不受 localStorage 配额限制）：

| 文件 | 内容 | 说明 |
|------|------|------|
| `events.jsonl` | 事件流：每次互动的 `{ts, role, text, action, affinityDelta}` | 追加写，压缩的分母 |
| `facts.json` | 事实卡：关于你的事（名字、生日、喜好、在做的项目） | 可由对话提取，或「记住这句」按钮手动 |
| `followups.json` | 约定跟进：`{text, dueAt, done}` | "周末去看流星雨" → 周末她主动提 |
| `mood.json` | 她的状态：亲密度、心情（精力/想念/害羞）、最后互动时间 | 由互动派生 |
| `journal.jsonl` | 她写的日记：定期生成的她视角日常记录 | 面板可翻 |

- **压缩**：事件流超过阈值（如 200 条）时生成时段摘要并截断窗口，上下文有界。
- **检索**：最近 N 轮 + 关键词命中 facts/followups + 到期约定，注入对话上下文。
- **迁移**：v0.4 的 affinity / userName / totalInteractions 自动迁入新存储。

### 2.2 引擎层（新增 `src/engine/`）

统一接口，两个实现：

- **LocalEngine（离线，默认兜底）**：记忆检索 + 模板生成 + 情绪机。基于现有 `dialogue.js` 词库扩展，回答会用上 name / facts / followups。**永远可跑，零依赖。**
- **LLMEngine（可选）**：OpenAI 兼容协议（DeepSeek / Kimi / GLM / 豆包 均可），用户自备 key。
  - key 经 Electron `safeStorage`（Windows DPAPI）加密存于主进程；**API 请求全部走主进程**，renderer 只发 IPC——key 不出主进程，CSP 不用放开。
  - 人设卡：system prompt 固化她的语气（轻声、内敛、星空联想、会害羞、不端着）+ 注入记忆块 + 最近对话。
  - 出厂前过一遍风格校正（模板兜底改写），防角色漂移。
- **对话管线**：输入 → 记忆检索 → 情绪/亲密度更新 → 生成（本地或 LLM）→ 记忆写入 → 选表情 → 逐字输出。

### 2.3 沟通层（新增 chat 面板）

- dock 面板新增输入框（Enter 发送 / Shift+Enter 换行 / Esc 收起），新增 `chat` 窗口模式（约 420×380，锚点规则复用现有 setMode）。
- 输出改为**逐字打字机**（按标点停顿），比整段弹出更「在场」。
- 动作联动：回复带 `expression`（开心→giggle/smile 链，回想→think，被夸→shy，深夜→sleep 语境），直接驱动 motion。
- 「记住这句话」按钮：把输入显式存为事实卡。
- 快捷短语保留（摸摸头、夸夸等一键互动），作为不愿意打字时的入口。

### 2.4 主动性（她先开口）

把现有 15% 概率的随机气泡升级为**触发式事件队列**：
- 约定到期（followups due）＞ 久别重逢（>6h）＞ 时段场景（boot/深夜）＞ 区域低姿态＞ 随机漫游碎嘴。
- 优先级互斥，同一时间只发起一个，冷却期防轰炸。

## 3. 实施阶段（每阶段独立可跑）

| 阶段 | 内容 | 规模预估 |
|------|------|---------|
| **P1 骨架** | 记忆层文件存储 + 迁移 + chat 面板 UI + LocalEngine（词库+记忆模板） | 新 4 个模块，改 app.js/dock 渲染 |
| **P2 接入 LLM** | 引擎抽象 + 主进程 API 客户端 + safeStorage key + 配置面板 + 流式 IPC | 新 3 个模块 |
| **P3 记忆深化** | 事实提取（LLM/手动）、压缩摘要、followups、mood 机、日记生成 | 记忆层增强 |
| **P4 融合润色** | 表情联动打磨、主动性队列、打字机音效/字体细节 | 体验收尾 |

P1 结束时你就能打字跟她 offline 对话、她有记忆、她记得你名字和你说过的事——**LLM 是可选项不是前提**。

## 4. 风险与对策

| 风险 | 对策 |
|------|------|
| LLM 角色漂移（说着不像她） | 人设卡 + 输出风格校正 + 本地兜底；可随时切纯本地 |
| 上下文无限增长 | 事件流压缩 + facts 限量 + 检索注入而非全量 |
| key 泄露 | 只在主进程、safeStorage 加密、不进渲染层 |
| API 挂/欠费 | 自动降级 LocalEngine，体验不掉线 |
| 原生依赖 | 存储用 JSONL，零原生编译，`npm ci` 干净 |
| 数据只在本机 | 定位就是个人伴侣，不做云同步；提供导出/导入脚本 |

## 5. 需要你拍板的四件事

1. **智能来源**：本地规则起步 / 直接 LLM / 混合（本地兜底+LLM 可选）？
2. **实施节奏**：四阶段一次推完 / 先 P1 当天可跑再继续？
3. **记忆范围**：全量对话都记 / 只记事实与约定（隐私更轻）？
4. **package 定位**：改名 `amanogawa-saya-companion`、version 1.0.0 起（README/描述同步重写）？

---

## 6. 实施记录

- **2026-10-20 · P1 骨架**：记忆层（memory-store）、本地引擎（local-engine）、聊天面板（chat-panel + 打字机）落地。
- **2026-10-20 · P2 + P4-lite**：本日完成——
  - `src/engine/persona.js`：人设卡 + 记忆块组装（纯函数，已测）。
  - `src/engine/config-store.js`：引擎配置存储，Key 走 safeStorage（DPAPI）加密，安全视图不含明文。
  - `src/engine/llm-engine.js`：OpenAI 兼容客户端（SSE 流式 / 非流式 / 超时取消）。
  - `main.js`：`llm:*` / `chat:stream` IPC（key 只在主进程）；dockStats 加高到 412。
  - `app.js`：聊天分流（LLM 流式 → 打字机增量；失败自动降级本地引擎）；星语设置卡；主动性队列（约定>久别>时段>回忆，8 分钟冷却）；每 6 轮 LLM 自动提炼事实卡。
  - `chat-panel.js`：打字机支持流式 `append`。
  - 修复 memory-store `eventsCompacked` 拼写（压缩计数重启后丢失）。
  - 待办（P3 余量）：日记生成、事件流 LLM 摘要压缩、心情机（energy/missing/shyness 派生）。
- **2026-10-20 · P5 直播感（stream presence）**：从「桌宠」到「像开直播的 vtuber」——
  - `src/character/motion-improv.js`：即兴动作合成器。语义五组（观察/温度/活跃/低位/困倦）× 骨架概率（45% 单步 / 30% 双步 / 25% 三步）× 时段/区域/亲密度权重 × holdMs ±25% 抖动 × 15% 微插入。纯函数可注入 rng；实测 400 次合成 400 种不同链、覆盖 21 个动作。
  - `src/character/stream-presence.js`：直播感引擎。8 类碎碎念 shuffle-bag 池（musing/curious/noticing/astro/recallish/clingy/tinyAction/selfPlay），亲密度分层权重（clingy ≥45 解锁、recallish 随事实卡数加权）；调度三档密度（活动 18–42s / 自娱 ×2.8 / 深夜 ×1.6）；反应接口（hover/注视 3s/连戳 ≥3/拖拽 >900px/用户去留 via powerMonitor.getSystemIdleTime/锁屏解锁/夜猫子每晚一次）；LLM 即兴（35% 概率 + 5 分钟冷却 + 失败静默回退）。反应类各自独立冷却，与 proactive 队列通过 isBusy/bubble 互斥。
  - `motion.js`：`improvFidget` 钩子——idle 微序列优先走即兴合成（带时段/区域语境），放弃时回退固定 idleFidget 行为。
  - `dialogue.js`：新增 8 个反应场景池（gaze/hoverPeek/pokeRapid/dragDizzy/userBack/userAwayQuiet/unlock/nightOwl），全部加入 NAMEABLE_SCENES。
  - `main.js`/`preload.js`：`pet:idle-seconds`（powerMonitor.getSystemIdleTime）+ `pet:system-event`（lock/unlock/suspend/resume 转发）。
  - `app.js`：hover/静止注视跟踪（pointermove + 8px 静止阈值）、连戳 2.5s 窗口计数、拖拽 pathLen 累计、showStreamLine 显示出口（气泡逐字 + 即兴链非 force 播放，漫游锁活跃时只说话不打断）、maybeNightOwl（localStorage 记日期）。
  - 测试：`scripts/test-stream-presence.mjs`（合成多样性/抖动范围/调度/反应冷却/忙碌互斥），修复 noteSystemEvent 冷却条件写反的 bug；`npm test` 同时跑引擎测试。
