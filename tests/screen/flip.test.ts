import { describe, it, expect } from 'vitest'
import { flipDelta, posKey, isNoop } from '../../src/screen/flip'

/**
 * CSS Grid 的 grid-row/grid-column **不能 transition** ——
 * renderDesk() 改完位置卡片是瞬移的，导航卡一来天气卡直接从左上闪到右下。
 *
 * FLIP：更新前记 first rect，更新后记 last rect，用反向 transform 把元素
 * "拉回"旧位置，再动画归零。
 */
describe('FLIP 位移计算', () => {
  const R = (left: number, top: number, width = 100, height = 100) => ({ left, top, width, height })

  it('位置没变时 dx/dy 为 0', () => {
    const d = flipDelta(R(10, 20), R(10, 20), 1)
    expect(d.dx).toBe(0)
    expect(d.dy).toBe(0)
  })

  it('往右下挪，反向 transform 要把它拉回左上（负值）', () => {
    const d = flipDelta(R(0, 0), R(100, 50), 1)
    expect(d.dx).toBe(-100)
    expect(d.dy).toBe(-50)
  })

  /**
   * 坑 ①：舞台是 scale() 过的。getBoundingClientRect() 返回**缩放后**像素，
   * 而 transform 作用在元素**本地**坐标系 —— dx/dy 必须先除以舞台缩放比，
   * 否则 0.5 倍缩放下卡片会飞出去两倍距离。
   */
  it('舞台缩放过：dx/dy 除以缩放比', () => {
    const d = flipDelta(R(0, 0), R(100, 50), 0.5)
    expect(d.dx).toBe(-200)
    expect(d.dy).toBe(-100)
  })

  // sx/sy 是**比值**，缩放比在分子分母上抵消了，不受影响
  it('缩放比不影响 sx/sy —— 它是比值', () => {
    const a = flipDelta(R(0, 0, 200, 100), R(0, 0, 100, 100), 1)
    const b = flipDelta(R(0, 0, 200, 100), R(0, 0, 100, 100), 0.5)
    expect(a.sx).toBe(b.sx)
    expect(a.sx).toBe(2)
    expect(a.sy).toBe(1)
  })

  it('档位缩放：宽高一起插值', () => {
    const d = flipDelta(R(0, 0, 400, 200), R(0, 0, 800, 400), 1)
    expect(d.sx).toBe(0.5)
    expect(d.sy).toBe(0.5)
  })

  it('新宽高为 0（卡还没布局完）时退回 1，不产生 Infinity', () => {
    const d = flipDelta(R(0, 0, 100, 100), R(0, 0, 0, 0), 1)
    expect(Number.isFinite(d.sx)).toBe(true)
    expect(d.sx).toBe(1)
  })

  it('缩放比为 0 或非法时按 1 处理', () => {
    expect(flipDelta(R(0, 0), R(100, 0), 0).dx).toBe(-100)
    expect(flipDelta(R(0, 0), R(100, 0), NaN).dx).toBe(-100)
  })
})

/**
 * 坑 ②：车窗过渡动画**每帧**调 renderDesk()。FLIP 每帧跑会打架 ——
 * 卡片会抖得像坏掉的。只在栅格坐标真变化时触发。
 */
describe('只在栅格坐标真变化时触发', () => {
  it('posKey 只由行列跨度决定，跟数据无关', () => {
    const a = posKey({ row: 0, col: 8, rowSpan: 2, colSpan: 4 })
    const b = posKey({ row: 0, col: 8, rowSpan: 2, colSpan: 4 })
    expect(a).toBe(b)
  })

  it('位置一样就是 noop —— 车窗每帧刷新不触发 FLIP', () => {
    const k = posKey({ row: 0, col: 0, rowSpan: 2, colSpan: 4 })
    expect(isNoop(k, k)).toBe(true)
  })

  it('挪了位置不是 noop', () => {
    expect(isNoop(
      posKey({ row: 0, col: 0, rowSpan: 2, colSpan: 4 }),
      posKey({ row: 2, col: 0, rowSpan: 2, colSpan: 4 }))).toBe(false)
  })

  it('只改了跨度（档位缩放）也要动画', () => {
    expect(isNoop(
      posKey({ row: 0, col: 0, rowSpan: 2, colSpan: 4 }),
      posKey({ row: 0, col: 0, rowSpan: 4, colSpan: 8 }))).toBe(false)
  })

  // 卡刚建出来时没有旧位置，直接播进场动画，不要 FLIP
  it('没有旧位置时算 noop —— 新卡走进场动画不走 FLIP', () => {
    expect(isNoop(undefined, posKey({ row: 0, col: 0, rowSpan: 1, colSpan: 2 }))).toBe(true)
  })
})
