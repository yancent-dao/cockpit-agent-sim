# 自动化任务:向用户开放的规则引擎(替代情景模式)

2026-08-18 产品决策。对标理想任务大师(条件×动作组合、边沿触发、手动任务、
运行前询问、任务码分享)与小鹏智慧场景。CLAUDE.md 已知待办里的落地路径
(「触发器 = 向用户开放的规则引擎,CardRule 形状 + src/state/ 存储」)就此兑现。

## 数据形状(用户数据,不是代码)

```ts
AutomationRule {
  id, name: string
  when: Cond[]          // 空数组 = 手动任务(点卡片/语音 run)
  do: Action[]          // 顺序执行
  ask?: boolean         // 运行前询问(触发时确认卡,点了才执行)
  enabled: boolean
  lastRun?: number
}
Cond = ['signal', path, op, value]   // 复用约束引擎三元组语法
     | ['time', 'HH:MM']             // 每天定时(分钟级)
Action = { tool: string, args: {} }  // 工具直调:机制执行,零模型
       | { prompt: string }          // 委托:叫醒慢层跑一句(如"推荐当天股票")
```

存 `src/state/automation.ts`(localStorage,域仓同款形状)。

## 引擎(src/core/automation.ts,约束引擎的姐妹)

- **边沿触发**(任务大师同款语义):条件整体从"不满足→全满足"的那一刻 fire 一次,
  持续满足不重复;时间条件按分钟比对,同一分钟只 fire 一次。
- 引擎只做判定与 emit,**不执行动作**——core 不认识 registry/pipeline。
  装配层(director)接 fire 事件:tool 动作 → registry.invoke;prompt 动作 →
  pipeline.run('[自动任务·名]…');ask 规则 → 先出确认卡,点「执行」再跑(直调,
  不叫醒模型)。
- **后台运行**:引擎常驻装配层,`store.subscribe` + 30s 时钟 tick,与对话世代无关。
  零后端边界如实声明:车机窗口在,任务就在;关浏览器即停(等同真车熄火)。

## Tools(5 个,handlers < 40 行/个)

automation.create(name/when/do/ask,ParamDef.items 带完整 JSON Schema——
story.begin 的教训)· list · toggle · delete · run(手动任务)。
创建成功即回执卡:用户要**看见**"我理解成了这样",错了当场改。

## HMI

- 专用 `automation` 模板(box/tower/court):每条规则一行——名称、启停状态点、
  条件摘要/下次触发、上次运行。交互声明**操控类直调**(点行 = automation.toggle,
  valueParam 传规则 id,不叫醒模型——stagedlist 先例)。
- 触发执行后:横幅回执「自动任务·雨天模式 已执行(3 项动作)」;
  prompt 委托的产出走正常语音/卡片通道。
- ask 确认卡复用 confirm 模板,「执行/这次跳过」。

## 特色

任务码分享:导出/导入 JSON(automation.list 的 data 就是任务码)。

## 明确不做(v1)

手机同步(无后端)· 条件里的位置围栏(有坐标但先不做几何判定)·
规则间依赖/嵌套 · 自动学习建议("你常在16点开空调要不要建个任务"——踩自动学习红线)。
