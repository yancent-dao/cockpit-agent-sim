import { describe, it, expect } from 'vitest'
import { seekSeconds, barRatio, dominantColor } from '../../src/screen/mediaMath'

/**
 * 播放器卡的点按定位与取色——纯算术，不碰 DOM。
 * 拖拽 v1 降级为点按定位（行驶中本来就要降级，同滚动禁令判据）。
 */

describe('barRatio：点击横坐标 → 0..1', () => {
  it('按元素内相对位置折算，两端夹住', () => {
    expect(barRatio(150, 100, 200)).toBeCloseTo(0.25)
    expect(barRatio(90, 100, 200)).toBe(0)
    expect(barRatio(400, 100, 200)).toBe(1)
  })
  it('零宽（还没布局）回 0，不除出 NaN', () => {
    expect(barRatio(100, 100, 0)).toBe(0)
  })
})

describe('seekSeconds：比例 × 时长 → 目标秒', () => {
  it('正常折算并取整', () => {
    expect(seekSeconds(0.5, 182)).toBe(91)
  })
  it('时长未知（直播/未加载）回 null——调用方据此不发 seek', () => {
    expect(seekSeconds(0.5, NaN)).toBeNull()
    expect(seekSeconds(0.5, 0)).toBeNull()
    expect(seekSeconds(0.5, Infinity)).toBeNull()
  })
})

describe('dominantColor：像素采样 → 主色（饱和度加权）', () => {
  const px = (rgbs: number[][]) => new Uint8ClampedArray(rgbs.flatMap(([r, g, b]) => [r, g, b, 255]))
  it('鲜艳色压过大片灰色——封面的"主色"是色彩不是底灰', () => {
    // 3 像素灰 + 1 像素品蓝：加权后主色应显著偏蓝
    const c = dominantColor(px([[128, 128, 128], [128, 128, 128], [128, 128, 128], [30, 80, 220]]))
    expect(c).toBeTruthy()
    const [r, , b] = c!
    expect(b).toBeGreaterThan(r + 40)
  })
  it('空数据回 null（图跨域污染时调用方退源色）', () => {
    expect(dominantColor(new Uint8ClampedArray(0))).toBeNull()
  })
})
