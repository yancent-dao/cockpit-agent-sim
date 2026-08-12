# HMI 重设计 · 实施设计

> 2026-08-12 ｜ 上游：[2026-08-11 HMI 重设计](./2026-08-11-hmi-redesign-design.md)（设计决策的唯一事实来源）
>
> 这份不重做设计，只把它翻译成**改哪个文件的哪一行、接口长什么样、哪条测试会红**。
> 上游文档没覆盖或与现状冲突的地方，判断记在这里。

## 0. 基线（实测，不是记忆）

| 项 | 值 |
|---|---|
| 测试 | **409 全绿**（上游文档写的 398 是媒体域接入前的数字） |
| `screen.html` | 279 行，60 处 `font-size`，22 条 `.sz-*` |
| 栅格常量抄了几份 | **5 份**：`desk.ts:21` `ROWS/COLS`、`desk.ts:22` `SHAPES`、`desk.ts:25` `CELLS`、`main.ts:253` `occupied[2][3]`、`screen.html:35` `repeat(3,1fr)` |
| 坐标断言集中在 | `tests/cards/desk.test.ts`（14 处 row/col/span/free/cellsOf） |

## 1. 未决事项的处置（上游 §15）

按上游 §15 的建议值执行，两条都记在这里备查：

1. **`tokens.ts` 算数据**，不计 `src/screen/` 代码预算。它是 CSS 文本常量不是逻辑，跟 `signals.ts` 同理。→ 写进 CLAUDE.md 规模预算表。
2. **电台卡底部那行 `◎ 说「换一台」「大点声」都可以` 保留**。上游 §10 自己给了理由：控制条画成图标就有诱导点击的风险，这行字是把它标成语音能力的对冲，顺带填了「能力曝光度未做」的一半。

## 2. 新增/改动文件总表

| 文件 | 动作 | 预估行 | 步骤 |
|---|---|---|---|
| `src/design/tokens.ts` | 新增（数据） | ~150 | 1 |
| `src/config/grid.ts` | 新增 —— 栅格与档位常量的**唯一出处** | ~70 | 4 |
| `src/config/priority.ts` | 新增 —— urgency 权重表 | ~40 | 6 |
| `src/screen/layout.ts` | 3 个形态函数 → 11 个，签名换 `(cols,rows)` | 47 → ~270 | 3 |
| `src/screen/sanitize.ts` | 新增 | ~120 | 8 |
| `src/screen/flip.ts` | 新增 —— 纯函数，可测 | ~45 | 7 |
| `src/screen/main.ts` | 渲染改栅格 + 块状均分 + canvas | 748 → ~900 | 4·5·8 |
| `src/cards/desk.ts` | 栅格参数化 + urgency + summary 改写 | 399 → ~470 | 4·6 |
| `src/config/cards.ts` | 10 档位 + `canvas` 模板 + urgency 默认值 | +30 | 4·6·8 |
| `screen.html` | 删 22 条 `.sz-*` 与 60 处 font-size，改用 token | 279 → ~230 | 1·5 |
| `index.html` / `director/main.ts` | 接 token + 卡片检查器 + 消毒日志 | +80 | 1·9 |

## 3. 档位表（唯一出处 `src/config/grid.ts`）

```ts
export const GRID = { cols: 12, rows: 4 } as const

export interface Tier { w: number; h: number; alias?: string }
export const TIERS = {
  chip:   { w: 2,  h: 1 },
  strip:  { w: 4,  h: 1 },
  bar:    { w: 6,  h: 1 },
  card:   { w: 4,  h: 2, alias: '1/6' },
  wide:   { w: 6,  h: 2 },
  panel:  { w: 8,  h: 2, alias: '1/3' },
  banner: { w: 12, h: 2, alias: '1/2' },
  tower:  { w: 4,  h: 4 },
  stage:  { w: 8,  h: 4, alias: '2/3' },
  full:   { w: 12, h: 4, alias: 'full' },
} as const

/** 降级阶梯。tower/stage/full 是专用档，不进阶梯 */
export const LADDER = ['chip', 'strip', 'bar', 'card', 'wide', 'panel', 'banner'] as const
```

**别名双向解析**（这是 409 个测试能继续绿的关键）：`'1/6' → card`、`'2/3' → stage`，
`Size` 类型变成 `TierName | LegacyName` 的联合，`normalizeTier()` 在 `desk.show/resize`、
`registry.checkSize`、`cardRules` 三个入口做归一。**对外仍可用老名字，内部一律新名字。**

### 不变量（写进 `src/core/` 的断言）

1. 所有档位宽度为偶数 → 表里 2/4/6/8/12，无例外
2. 列起点 ∈ {0,2,4,6,8,10}
3. 全高档行起点必须 0；半高档 ∈ {0,2}；单行档 ∈ {0,1,2,3}

⇒ 空隙必为偶数宽，`chip` 宽 2 永远填得上，**不出现死缝**。这条要有穷举测试（6 列位 × 4 行位 = 24 个位置，可枚举）。

## 4. 上游没说清、我按现状定的六处

**① `cellsOf()` 的返回值变了。** 现在返回 1/2/3/4/6（3×2 网格的格数），新栅格下 `card` 是 8 单元（4×2）。
`sizedDesk` 用它算 minSize、`layout().free` 用它算余量。
→ **保留 `cellsOf` 但改为返回新单元数**，同时新增 `tierOf(size)` 返回档位名。测试 `desk.cellsOf('1/6')` 从 1 改成 8（红→绿）。

**② `layout().free` 的语义。** 48 单元下"剩余 40 格"对人和模型都没意义。
→ `free` 字段**保留数值**（内部仲裁在用），但 `summary()` 改成上游 §4 的人话格式。
两者分开，不要为了 summary 改 free 的类型——那会波及一堆调用点。

**③ 单行档（chip/strip/bar）与半高档并排会产生"错落"**，上游 §4 说"这是刻意的"。
但现有 `tryPlace` 是行优先扫描，单行档会优先落在 row 0，导致半高卡被挤到 row 2。
→ 放置顺序补一条：**全高 → 半高 → 单行**（上游只写了"全高档最先"）。理由：单行档最灵活，让它最后填缝，否则它会把半高档的位置切碎。这是对上游算法的补充，不是改动。

**④ `minSize` 的默认值。** 现在默认 `'1/6'`（最小档）。新档位下最小是 `chip`。
→ 默认改 `chip`。但 `list` 模板实测 1/6（现 card）能放四条，`chip` 只有 393×237 放不下 → **`list`/`confirm` 的模板 `sizes` 下限设为 `card`**，靠现有的 `sizes` 机制表达，不新增字段。

**⑤ FLIP 触发判据。** 上游说"比较节点上存的 row/col"。
→ 具体做法：`node.dataset.pos = ${row},${col},${rowSpan},${colSpan}`，`renderDesk` 里先读旧值再写新值，**只有字符串不等才进 FLIP 队列**。车窗过渡每帧 render 时 pos 不变，天然不触发。

**⑥ canvas 溢出检测上报路径。** 上游 §9 要求 pilot 加硬伤，但 pilot 跑在 Node 里没 DOM，量不了 `scrollHeight`。
→ 车机屏渲染后检测，走**已有的 `bus.mediaEvent` 同类通道**新增 `type:'canvasOverflow'` 上报，落进控制面板 trace；pilot 那条改为检查 `card.show` 返回里的 `overflowHint`。两边都做，但机制不同——这是对上游的落地补充。

## 5. 形态函数签名（步骤 3）

```ts
export interface Form {
  blocks: string[]              // 显示哪些块，按顺序
  maxItems?: number             // 列表类：最多显示几条
  overflow?: 'more' | 'count' | 'none'
  cols?: number                 // 内容分几列
}
export type FormFn = (cols: number, rows: number) => Form
export const CARD_FORMS: Record<string, FormFn>
```

11 个模板：`nav` `control` `confirm` `feedback` `notice` `list` `info` `media` `weather` `capability` `generic`（+ `canvas` 在步骤 8 加）。

**按阈值判断而不是查表**——宽度只有 5 种取值（2/4/6/8/12）、高度 3 种（1/2/4），每个模板实际只关心 2–3 个阈值。11×10=110 组手写不可行。

现有 `navForm/capForm/weatherForm` 的 `(size)` 签名要改，**它们的 7 个测试会红** → 先改测试到新签名，再改实现。

## 6. 测试计划（先红后绿，逐步）

| 步骤 | 新增测试 | 会变红的现有测试 |
|---|---|---|
| 1 tokens | `tokens.test.ts`：字阶 7 阶齐全、档位 `--u` 全覆盖、CSS 文本可解析 | 无 |
| 2 generic/截断 | `overflow.test.ts`：items 渲染、「还有 N 条」进 summary | 无 |
| 3 layout | `layout.test.ts` 扩到 11 模板 × 阈值 | **7 个**（navForm/capForm/weatherForm 签名） |
| 4 栅格 | `grid.test.ts`：24 位置穷举、偶数不变量、7 档阶梯、死局 | **14 处坐标断言** + `cellsOf` |
| 5 填充 | 块状均分的 DOM 结构（纯函数部分） | 无 |
| 6 priority | `priority.test.ts`：critical 不被挤、ambient 先被挤、同级 LRU | 抢占相关的行为断言（预计 2–3 个） |
| 7 FLIP | `flip.test.ts`：dx/dy 除缩放比、pos 不变不触发 | 无 |
| 8 canvas | `sanitize.test.ts`：7 条攻击用例 + 消毒后为空退回 generic | 无 |
| 9 收尾 | pilot 新硬伤 | 无 |

**红阶段必须亲眼看到**，尤其步骤 4 —— 先把 `desk.test.ts` 的 14 处坐标改成 12×4 下的期望值跑到红，再动 `desk.ts`。反过来就是"实现驱动测试"，等于没测。

## 7. 风险与对策

| 风险 | 对策 |
|---|---|
| 步骤 4 一次改动面太大 | 先落 `grid.ts` 常量并让 `desk.ts` 从它读（行为不变、测试全绿），再改网格尺寸。拆成两个提交 |
| `desk.summary()` 改写会改变模型看到的世界 | 步骤 4 完成后**立刻单跑 nav 组**对比，不等到步骤 9 |
| 22 条 `.sz-*` 删除后小尺寸形态丢失 | 删除前先让步骤 3 的形态函数接管，顺序不能反 |
| 别名解析漏一个入口 → 老测试红 | 三个入口（desk/registry/cardRules）各写一条别名测试 |
| 单文件版丢样式 | 步骤 1 完成后立刻 `node build-single.mjs` 并在浏览器验证双击版 |

## 8. 提交粒度

九步九个提交（步骤 4 拆两个，共十个）。每个提交：
- 测试全绿（409 + 新增）
- `npx tsc --noEmit` 干净
- 提交信息写清**改了什么 · 为什么 · 踩到什么**

步骤 1 和 4 完成后各跑一次 `node build-single.mjs` + 浏览器实测，因为这两步动的是全局机制。
