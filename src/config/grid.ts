/**
 * 栅格与形状常量 —— **唯一出处**。
 *
 * 之前同一套数字抄了 5 份（desk 的 ROWS/COLS、SHAPES、CELLS，main.ts 的 occupied[2][3]，
 * screen.html 的 repeat(3,1fr)）。改栅格要同时改 5 处，漏一处就是"算得下但画不出来"。
 *
 * ## 为什么是 12×8（2026-08-14 从 12×4 改过来）
 *
 * **12 列是对的**：能被 2/3/4/6 整除，`6+6`、`4+4+4`、`2×6` 三种分栏同时成立。
 * 换 16 列丢掉三栏（16 不能被 3 整除），换 10 列丢掉对半分（一半是 5 列，奇数）。
 *
 * **4 行是错的**：横轴有 6 个宽度档，纵轴只有 3 个高度档（231/486/996），
 * 纵向粒度比横向粗一倍，而且 486 → 996 是个整整 2 倍的跳跃，中间什么都没有。
 * 具体后果能指出来 —— 宽高比 1.63 那一族只有 box(4×2) 和 stage(8×4) 两级：
 *
 *     4×2   797×486   1.64
 *     ????              ← 中间这级不存在
 *     8×4  1619×996   1.63
 *
 * 于是"播放器中档不合理""导航中档太空""大量空白"三个抱怨其实是同一件事：
 * **中档没有合适的形状可选**，只能在"压扁"和"高度翻倍留白"之间二选一。
 * 这不是排版没做好，是栅格没给出这个形状。
 *
 * **为什么偏偏是 8**：8 = 2×4，旧的每个高度都被整除保留（231/486/996 一个像素不差），
 * 白捡一档 741px。12×5 单元格能变正方（181×180）但 5 是奇数没法对半分；
 * 12×6 高度档只有 316/656/996 三级，数量没多还跟已有像素全对不上；
 * 12×12 太细，偶数跨度下反而拿不到 231 和 741。
 * **8 是唯一既向后兼容又真正加档的行数。**
 *
 * ## 不变量（改完反而变简单了）
 *
 * 以前列是「偶数宽 + 偶数起点」、行是「高度只取 1/2/4 且按自身高度对齐」两套规则。
 * 现在**两个轴同一条**：
 *
 *   ① 跨度取偶数（宽 2/4/6/8/12，高 2/4/6/8）
 *   ② 起点取偶数（列 {0,2,…,10}，行 {0,2,4,6}）
 *
 * ⇒ 任何空隙的宽和高都是偶数，最小的 2×2 永远填得上，**不出现死缝**。
 */

export const GRID = { cols: 12, rows: 8 } as const

export interface Tier {
  /** 占几列 */
  w: number
  /** 占几行 */
  h: number
}

/**
 * 十四个形状。名字说的是**形状**不是比例 —— `panel` 到底占屏幕几分之几取决于栅格，
 * 叫 `1/3` 就把栅格写死在名字里了，而且"三分之一"既可能是横的（panel 8×4）
 * 也可能是竖的（tower 4×8），名字里带比例反而丢了最关键的信息。
 * 老尺寸名仍可用，见 ALIAS。
 *
 * 24 种合法组合（6 宽 × 4 高）里启用这 14 个，排除的理由：
 *   8/10/12 × 2  比 7:1 还扁，只是把一行字拉散；通栏一行字是**横幅通道**的活
 *   10 × 任意    跟 12 只差 400px 却留下一个 2 宽的孤格
 *   2 × 6/8      387 宽的通高竖缝，图旁边放不下任何说明
 *   8/12 × 6     跟 stage 只差 34%，地图场景 stage 更好
 *
 * 声明顺序 = 占用单元数升序，`tierNames()` 直接用它。
 */
export const TIERS = {
  // ── 高 2 · 231px —— 一行 ──
  chip: { w: 2, h: 2 },      // 387×231  · 1.67 一个数字
  strip: { w: 4, h: 2 },     // 797×231  · 3.45 一行字
  // ── 高 4 · 486px —— 标准 ──
  tile: { w: 2, h: 4 },      // 387×486  · 0.80 小竖块：通知、提示、单指标
  bar: { w: 6, h: 2 },       // 1208×231 · 5.23 一行字 + 进度
  box: { w: 4, h: 4 },       // 797×486  · 1.64 基准卡（旧名 card）
  // ── 高 6 · 741px —— 中高，本轮新增的一整档 ──
  frame: { w: 4, h: 6 },     // 797×741  · 1.08 全表最接近正方：方形图
  wide: { w: 6, h: 4 },      // 1208×486 · 2.49 宽卡：左图右文
  panel: { w: 8, h: 4 },     // 1619×486 · 3.33 长卡：横向对比、轮播
  tower: { w: 4, h: 8 },     // 797×996  · 0.80 竖塔：单栏列表、车身图
  hall: { w: 6, h: 6 },      // 1208×741 · 1.63 缺的那个中档
  // ── 高 8 · 996px —— 通高 ──
  band: { w: 12, h: 4 },     // 2440×486 · 5.02 通栏卡（旧名 banner）
  court: { w: 6, h: 8 },     // 1208×996 · 1.21 竖版大块：双栏列表、竖版播放器
  stage: { w: 8, h: 8 },     // 1619×996 · 1.63 大台：导航主卡、视频
  full: { w: 12, h: 8 },     // 2440×996 · 2.45 铺满：能力目录、覆盖层
} as const satisfies Record<string, Tier>

export type TierName = keyof typeof TIERS

/** 声明顺序即从小到大，`tierNames()` 直接用它 */
export const tierNames = (): TierName[] => Object.keys(TIERS) as TierName[]

/**
 * 老名字 → 新形状。对外仍可写 '1/6'、'2/3'、'card'、'banner'，内部一律新名字。
 *
 * 这是几百个老测试和已有 cardRules 能继续跑的关键，三个入口
 * （desk.show/resize、registry.checkSize、cardRules）都要过一遍 normalizeTier。
 * **分数名从配置里清掉了**，但别名表得留着 —— 清掉的是"新代码还这么写"，
 * 不是"老写法立刻失效"。
 */
export const ALIAS: Record<string, TierName> = {
  '1/6': 'box',
  '1/3': 'panel',
  '1/2': 'band',
  '2/3': 'stage',
  card: 'box',       // 改名：卡片系统里一个档位叫 card 太泛
  banner: 'band',    // 改名：跟**横幅通道**（三条显示通道之一）撞名
}

/** 认不出来的退到基准档 —— 不能因为一个错名字整张卡不显示 */
export function normalizeTier(size: string): TierName {
  if (size in TIERS) return size as TierName
  return ALIAS[size] ?? 'box'
}

/** 形状 → [列数, 行数]。形态函数的入参就是它 */
export function dimsOf(size: string): [number, number] {
  const t = TIERS[normalizeTier(size)]
  return [t.w, t.h]
}

/** 占几个单元。仲裁算余量、模板算 minSize 都用它 */
export function cellsOfTier(size: string): number {
  const t = TIERS[normalizeTier(size)]
  return t.w * t.h
}

/**
 * 内容分几栏。只看宽度 —— 高度再大也不该把一列拆成两列。
 *
 * 用于**非列表类**：对比卡、逐时预报、能力网格这些"从左往右比"的内容，
 * 栏数越多越好。列表类走 `listCols`，上限 2 栏。
 */
export const contentCols = (c: number) => (c >= 12 ? 4 : c >= 8 ? 3 : c >= 6 ? 2 : 1)

/**
 * 列表类分几栏 —— **最多 2 栏**。
 *
 * 横向多栏的编号列表反而更难扫：眼睛要在几列之间来回跳，而列表的阅读方向
 * 本来就是从上往下。原来 12 列铺 4 栏、每条 600px 宽却只有 100px 高，
 * 比例失调（2026-08-14 实拍反馈）。**阅读方向决定分栏上限。**
 */
export const listCols = (c: number) => (c >= 6 ? 2 : 1)

/**
 * 给定栏数和行数能放几条。
 *
 * 一个 row 单元（103.5px + gap）大约放一条带副标题的条目。
 * `r < 4` 是 231px 的单行档，连一条都放不下。
 *
 * **栏数由调用方传进来**，不在这里自己算 —— 以前容量按 `contentCols` 算、
 * 排版按另一个数分栏，同一张卡两套账（当前数值恰好相等纯属侥幸）。
 */
export const capacityOf = (cols: number, r: number) => (r < 4 ? 0 : cols * r)

/**
 * 列表类能显示几条。
 *
 * 放这里而不是 `screen/layout.ts`：`desk.summary()` 也要用它算"还有 N 条没显示"，
 * 而 desk 不该反向依赖车机屏。两边共用一个公式，屏上显示几条和告诉模型几条才不会打架。
 */
export const listCapacity = (c: number, r: number): number => capacityOf(listCols(c), r)

/**
 * 屏幕几何。跟 screen.html 的 `#stage` / `#desk` 一一对应 ——
 * 改这里要同步改那边，反过来也一样。
 *
 * 存在的理由只有一个：生成式卡必须把**真实像素**告诉模型。
 * 不给这个数字它必然溢出，因为它没有别的办法知道自己有多大。
 */
export const SCREEN = {
  w: 2560, h: 1440,
  statusH: 96,        // 状态栏
  voiceH: 300,        // 底部留白带（横幅+呼吸感）。语音带 2026-08-18 退役进顶栏角标，
                      // 但这 300 是像素契约的地基（996 由它算出）——名字留着，数值不动
  padX: 60, padY: 24, // #desk 的内边距
  gap: 24,
  /** 卡片自己的内边距（左右各一次，上下各一次），--u 取 1 的基准值 */
  cardPadX: 26, cardPadY: 22,
} as const

/**
 * 形状 → **卡片外框**像素（未减内边距）。
 *
 * 跨列的卡片把中间的 gap 也吃掉了 —— 一张 4 列的卡宽度是 `4 列宽 + 3 个 gap`，
 * 不算 gap 的话数字会偏小一大截。
 *
 * 跟 `pixelsOf` 是**两个不同的真实量**，别混：这是卡片占多大地方（决定形状、
 * 决定宽高比、决定「这一档看起来是横的还是竖的」），`pixelsOf` 是内容能画多大。
 * 内边距是常量，所以小卡的两个比例差得远（chip 外框 1.67、画布 1.79），
 * 判断形状必须用这个。
 */
export function boxOf(size: string): { w: number; h: number } {
  const [cw, ch] = dimsOf(size)
  const deskW = SCREEN.w - SCREEN.padX * 2
  const deskH = SCREEN.h - SCREEN.statusH - SCREEN.voiceH - SCREEN.padY * 2
  const colW = (deskW - SCREEN.gap * (GRID.cols - 1)) / GRID.cols
  const rowH = (deskH - SCREEN.gap * (GRID.rows - 1)) / GRID.rows
  return {
    w: Math.round(cw * colW + (cw - 1) * SCREEN.gap),
    h: Math.round(ch * rowH + (ch - 1) * SCREEN.gap),
  }
}

/**
 * 形状 → 画布可用像素（已减掉卡片内边距）。
 *
 * 存在的理由只有一个：生成式卡必须把**真实像素**告诉模型。
 * 不给这个数字它必然溢出，因为它没有别的办法知道自己有多大。
 */
export function pixelsOf(size: string): { w: number; h: number } {
  const b = boxOf(size)
  return { w: b.w - SCREEN.cardPadX * 2, h: b.h - SCREEN.cardPadY * 2 }
}
