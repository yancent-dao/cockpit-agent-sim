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

export interface WeatherForm {
  /** 温度当主角，大字号 */
  bigTemp: boolean
  /** 放几天预报。0 = 不放 */
  forecast: number
  /** 预报横向排（宽卡才这么干，不然内容全缩在左上角） */
  forecastRow: boolean
}

export function weatherForm(size: string): WeatherForm {
  if (size === '1/6') return { bigTemp: true, forecast: 0, forecastRow: false }
  if (size === '1/3') return { bigTemp: true, forecast: 3, forecastRow: false }
  return { bigTemp: true, forecast: 3, forecastRow: true }   // 1/2 及以上
}
