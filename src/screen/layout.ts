/**
 * 尺寸 → 形态。卡片尺寸放开之后，"支持某个尺寸"要落到"在那个尺寸下能看"。
 *
 * 这里只回答"显示哪些块"，具体排版在 CSS 里。抽成纯函数是为了能测——
 * 车机屏那边是 DOM 操作，跑不了单测。
 */

export interface NavForm {
  /** 地图。一格宽的地图看不出路，不如把空间让给转向指令 */
  map: boolean
  /** 转向条：还有多远 · 做什么 · 上哪条路。任何尺寸都保留，这是导航的命根子 */
  turnbar: boolean
  /** 底部的 ETA / 剩余里程 / 目的地 */
  foot: boolean
}

export function navForm(size: string): NavForm {
  if (size === '2/3' || size === '1/2' || size === 'full')
    return { map: true, turnbar: true, foot: true }
  if (size === '1/3') return { map: false, turnbar: true, foot: true }
  return { map: false, turnbar: true, foot: false }   // 1/6
}

export interface CapForm {
  /** grid 铺开 · list 一列 · count 只报数量 */
  mode: 'grid' | 'list' | 'count'
}

export function capForm(size: string): CapForm {
  if (size === 'full') return { mode: 'grid' }
  if (size === '1/6') return { mode: 'count' }
  return { mode: 'list' }
}
