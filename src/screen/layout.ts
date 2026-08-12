import { listCapacity, contentCols } from '../config/grid'
/**
 * 尺寸 → 形态。卡片尺寸放开之后，"支持某个尺寸"要落到"在那个尺寸下能看"。
 *
 * 这里只回答"显示哪些块、放几条、分几栏"，具体排版在 CSS 里。抽成纯函数是为了能测——
 * 车机屏那边是 DOM 操作，跑不了单测。
 *
 * ## 为什么签名是 `(cols, rows)` 而不是 `(size)`
 *
 * 档位从 4 个涨到 10 个之后，按档位名查表要写 11 模板 × 10 档 = 110 组，没法维护，
 * 而且加一个档位就要把 11 个表全补一遍——正好踩中"加能力 = 加代码"。
 * 改成按**几何阈值**判断：宽度只有 5 种取值（2/4/6/8/12）、高度 3 种（1/2/4），
 * 每个模板实际只关心 2–3 个阈值。以后加档位只改 `TIERS` 表，这个文件一行不动。
 *
 * ## 阈值都用面积（cols × rows）还是分开用
 *
 * 分情况，写在各函数里：
 *   · "放不放得下这块内容" → 看**面积**（12 单元 ≈ 屏幕 1/4）
 *   · "排成几栏 / 横着排还是竖着排" → 只看**宽度**
 *   · "地图会不会被压成一条缝" → 宽高都要看
 */

export interface Form {
  /** 显示哪些块，按渲染顺序 */
  blocks: string[]
  /** 列表类：最多显示几条 */
  maxItems?: number
  /** 放不下的处理：截断并写明还剩几条 / 只报个数 / 不会溢出 */
  overflow?: 'more' | 'count' | 'none'
  /** 内容分几栏 */
  cols?: number
  /** 互斥的渲染方式（能力目录的 grid/list/count）。跟 blocks 不同——它不是叠加的 */
  mode?: string
}

export type FormFn = (cols: number, rows: number) => Form

export { listCapacity, contentCols } from '../config/grid'

/** 一屏 12×4 = 48 单元。12 单元 ≈ 屏幕 1/4，是"放得下一段解释"的分界 */
const area = (c: number, r: number) => c * r


/**
 * 导航卡。转向条（还有多远 · 做什么 · 上哪条路）是命根子，任何档位都保。
 * 先砍地图后砍 ETA —— 一格宽的地图看不出路，不如把空间让给转向指令。
 */
export const navForm: FormFn = (c, r) => {
  const blocks = ['turn']
  // 地图要"看得出路"：面积够 **且** 不能是竖条（tower 4×4 面积 16 但宽只有 4）
  if (area(c, r) >= 24 && c >= 8) blocks.splice(1, 0, 'map')
  if (area(c, r) >= 12) blocks.push('foot')
  return { blocks }
}

/** 车控反馈卡。车身图要竖向空间，半高档给不了，退成纯文字状态列表 */
export const controlForm: FormFn = (c, r) => {
  const blocks: string[] = []
  if (r >= 4 && c >= 4) blocks.push('vehicle')
  blocks.push('items')
  return { blocks, maxItems: Math.max(2, listCapacity(c, r)), overflow: 'more', cols: contentCols(c) }
}

/**
 * MRTR 确认卡。"要做什么"和"怎么答"任何档位都得说清 ——
 * 少了前者用户不知道在确认什么，少了后者他不知道该说"确认"还是"好"。
 * "为什么要确认"是解释性内容，小档先砍。
 */
export const confirmForm: FormFn = (c, r) => {
  const blocks = ['what']
  if (area(c, r) >= 16) blocks.push('why')
  blocks.push('hint')
  return { blocks }
}

/** 执行结果 / 提醒。正文永远在，细节按空间加 */
const textDetail: FormFn = (c, r) => {
  const blocks = ['text']
  if (area(c, r) >= 12) blocks.push('detail')
  return { blocks }
}

/** 候选列表。截断策略在这里定，车机屏和 desk.summary() 都读它 */
export const listForm: FormFn = (c, r) => {
  const n = listCapacity(c, r)
  return { blocks: ['items'], maxItems: n, overflow: n > 0 ? 'more' : 'count', cols: contentCols(c) }
}

/** 通用信息卡（info / generic）。三段都在契约里，别再静默丢数据 */
const genericForm: FormFn = (c, r) => {
  const blocks = ['text']
  if (area(c, r) >= 8) blocks.push('items', 'actions')
  return { blocks, maxItems: Math.max(2, listCapacity(c, r)), overflow: 'more', cols: contentCols(c) }
}

/**
 * 播放器卡。封面最先让位——它占的是能写字的地方，而歌名比封面重要。
 * `hint` 是那行「说『换一台』『大点声』都可以」：控制条画成图标就有诱导点击的风险
 * （屏幕不可交互），这行字把它标回语音能力。
 */
export const mediaForm: FormFn = (c, r) => {
  const a = area(c, r)
  const blocks: string[] = []
  if (a >= 8) blocks.push('art')
  blocks.push('title')
  if (a >= 8) blocks.push('sub')
  if (c >= 6) blocks.push('bar')
  if (r >= 2 && a >= 12) blocks.push('hint')
  return { blocks }
}

/** 天气卡。温度当主角，预报按空间加；横排只看宽度，竖着的卡横排预报会挤成一团 */
export const weatherForm: FormFn = (c, r) => {
  const a = area(c, r)
  const days = a >= 32 ? 5 : a >= 12 ? 3 : 0
  const blocks = ['temp']
  if (days > 0) blocks.push('forecast')
  return { blocks, maxItems: days, cols: c >= 12 ? days : 1 }
}

/**
 * 能力目录。33 项塞进一格是不可能的，老实报个数。
 * grid/list/count 是三种**互斥的渲染方式**，走 `mode` 不走 `blocks` ——
 * blocks 那条"档位变大不掉块"的单调性才管得住。
 */
export const capForm: FormFn = (c, r) => {
  const a = area(c, r)
  const mode = a >= 32 ? 'grid' : a >= 12 ? 'list' : 'count'
  // 按**实际列数**算容量。list 模式只有一列，照三列的容量给就会切掉半行——
  // 用户看到一条被拦腰截断的能力比不显示更糟，他会以为那就是全部
  const cols = mode === 'grid' ? contentCols(c) : 1
  return {
    blocks: ['groups'], mode, cols,
    maxItems: mode === 'count' ? 0 : cols * r * 2,
    overflow: mode === 'count' ? 'count' : 'more',
  }
}

/** 11 个模板的形态函数。加模板 = 加一条，不改调用方 */
export const CARD_FORMS: Record<string, FormFn> = {
  nav: navForm,
  control: controlForm,
  confirm: confirmForm,
  feedback: textDetail,
  notice: textDetail,
  list: listForm,
  info: genericForm,
  media: mediaForm,
  weather: weatherForm,
  capability: capForm,
  generic: genericForm,
}

/** 查不到就按 generic 走——白卡比不显示更糟 */
export const formOf = (template: string, c: number, r: number): Form =>
  (CARD_FORMS[template] ?? genericForm)(c, r)
