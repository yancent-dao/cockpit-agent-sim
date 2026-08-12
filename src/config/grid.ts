/**
 * 栅格与档位常量 —— **唯一出处**。
 *
 * 之前同一套数字抄了 5 份（desk 的 ROWS/COLS、SHAPES、CELLS，main.ts 的 occupied[2][3]，
 * screen.html 的 repeat(3,1fr)）。改栅格要同时改 5 处，漏一处就是"算得下但画不出来"。
 *
 * ## 为什么是 12×4
 *
 * 3×2 的老栅格只有 6 格，一张 2/3 卡占掉 4 格后剩下的是一条竖缝，
 * 横向的 1/3 卡放不进去——**几何死局**，跑批时整张导航卡出不来。
 * 12×4 之后最小档 chip 只占 2×1，配合下面两条不变量，空隙永远填得上。
 *
 * ## 两条不变量（组合起来才有意义）
 *
 *   ① 所有档位**宽度为偶数**（表里 2/4/6/8/12，无例外）
 *   ② 列起点只取偶数 {0,2,4,6,8,10}
 *
 * ⇒ 任何空隙的宽度必为偶数，chip 宽 2 一定填得上，**不出现死缝**。
 *   高度同理只取 1/2/4——取 3 会跟半高档错位出一条高 1 的横缝。
 */

export const GRID = { cols: 12, rows: 4 } as const

export interface Tier {
  /** 占几列 */
  w: number
  /** 占几行 */
  h: number
}

/**
 * 十个档位。名字是形状不是比例——`panel` 到底占屏幕几分之几取决于栅格，
 * 叫 `1/3` 就把栅格写死在名字里了（老尺寸名仍可用，见 ALIAS）。
 */
export const TIERS = {
  chip: { w: 2, h: 1 },      // 一个数字，比如车速、剩余电量
  strip: { w: 4, h: 1 },     // 一行字
  bar: { w: 6, h: 1 },       // 一行字 + 一条进度
  card: { w: 4, h: 2 },      // 基准档：天气、单条反馈
  wide: { w: 6, h: 2 },
  panel: { w: 8, h: 2 },     // 导航小卡、候选列表
  banner: { w: 12, h: 2 },   // 横跨整屏的提醒
  tower: { w: 4, h: 4 },     // 竖着的：车身图、电台节目单
  stage: { w: 8, h: 4 },     // 导航主卡
  full: { w: 12, h: 4 },     // 铺满
} as const satisfies Record<string, Tier>

export type TierName = keyof typeof TIERS

/** 声明顺序即从小到大，`tierNames()` 直接用它 */
export const tierNames = (): TierName[] => Object.keys(TIERS) as TierName[]

/**
 * 降级阶梯：放不下时按这个顺序往小退。
 * tower/stage/full 是专用档（导航要 stage、车身图要 tower），不该被自动降级路过——
 * 一张导航卡退成 tower 会变成一条竖缝，比退成 card 还难看。
 */
export const LADDER = ['chip', 'strip', 'bar', 'card', 'wide', 'panel', 'banner'] as const

/**
 * 老尺寸名 → 新档位。对外仍可写 '1/6'、'2/3'，内部一律新名字。
 * 这是几百个老测试和已有 cardRules 能继续跑的关键，三个入口
 * （desk.show/resize、registry.checkSize、cardRules）都要过一遍 normalizeTier。
 */
export const ALIAS: Record<string, TierName> = {
  '1/6': 'card',
  '1/3': 'panel',
  '1/2': 'banner',
  '2/3': 'stage',
  full: 'full',
}

/** 认不出来的退到基准档——不能因为一个错名字整张卡不显示 */
export function normalizeTier(size: string): TierName {
  if (size in TIERS) return size as TierName
  return ALIAS[size] ?? 'card'
}

/** 档位 → [列数, 行数]。形态函数的入参就是它 */
export function dimsOf(size: string): [number, number] {
  const t = TIERS[normalizeTier(size)]
  return [t.w, t.h]
}

/** 占几个单元。仲裁算余量、模板算 minSize 都用它 */
export function cellsOfTier(size: string): number {
  const t = TIERS[normalizeTier(size)]
  return t.w * t.h
}

/** 内容分几栏。只看宽度——高度再大也不该把一列拆成两列 */
export const contentCols = (c: number) => (c >= 12 ? 3 : c >= 8 ? 2 : 1)

/**
 * 列表能显示几条。
 *
 * 一个 row 单元大约放两行带副标题的条目，乘上栏数。
 * `card`（4×2）算出来正好是 4 —— 这是实测过的数字（2560px 屏上四条候选刚好），
 * 别为了公式好看去调系数。
 *
 * 放这里而不是放 `screen/layout.ts`：`desk.summary()` 也要用它算"还有 N 条没显示"，
 * 而 desk 不该反向依赖车机屏。两边共用一个公式，屏上显示几条和告诉模型几条才不会打架。
 */
export function listCapacity(c: number, r: number): number {
  if (r < 2) return 0          // 单行档连一条带副标题的候选都放不下
  return contentCols(c) * r * 2
}

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
  voiceH: 300,        // 语音区（待机时收到 148，按大的算才不会撑破）
  padX: 60, padY: 24, // #desk 的内边距
  gap: 24,
  /** 卡片自己的内边距（左右各一次，上下各一次），--u 取 1 的基准值 */
  cardPadX: 26, cardPadY: 22,
} as const

/**
 * 档位 → 画布可用像素（已减掉卡片内边距）。
 *
 * 跨列的卡片把中间的 gap 也吃掉了 —— 一张 4 列的卡宽度是 `4 列宽 + 3 个 gap`，
 * 不算 gap 的话报给模型的数字会偏小一大截，它就会把内容排得过于保守。
 */
export function pixelsOf(size: string): { w: number; h: number } {
  const [cw, ch] = dimsOf(size)
  const deskW = SCREEN.w - SCREEN.padX * 2
  const deskH = SCREEN.h - SCREEN.statusH - SCREEN.voiceH - SCREEN.padY * 2
  const colW = (deskW - SCREEN.gap * (GRID.cols - 1)) / GRID.cols
  const rowH = (deskH - SCREEN.gap * (GRID.rows - 1)) / GRID.rows
  return {
    w: Math.round(cw * colW + (cw - 1) * SCREEN.gap - SCREEN.cardPadX * 2),
    h: Math.round(ch * rowH + (ch - 1) * SCREEN.gap - SCREEN.cardPadY * 2),
  }
}
