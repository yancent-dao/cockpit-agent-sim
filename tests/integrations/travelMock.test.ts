import { describe, it, expect } from 'vitest'
import { mockSource, MOCK_NOTE } from '../../src/integrations/travelMock'
import type { TravelWatch } from '../../src/state/travel'

/**
 * 机酒的示例数据源（2026-08-20）。
 *
 * ## 为什么允许 mock，以及 mock 必须守什么
 *
 * 机酒在 RapidAPI 上的候选全是非官方封装、免费层 50 次/月，而整条链路
 * （建任务→配委托→采样→到价→趋势卡→播报）用**汇率**就能完整演——
 * 汇率零 Key、有真历史、全是真的。所以 mock 机酒损失的是"机票价格是
 * 真的"这一个点，不是 Demo 的真实性。
 *
 * 但 mock 要守两条，否则就变成自欺：
 *   ① **必须标明自己是示例数据**（PRD 5.6「不冒充实时数据」同一条纪律）——
 *     quote 带 note，模型和卡片都看得见，不许悄悄冒充真价
 *   ② **必须可重放**：同一条委托每次得到同一条曲线。演示者能预判结果
 *     比"看起来更真"重要（同卡片布局那条"不追求最优解，追求可预测解"）
 *
 * 这个文件同时是**录制槽**：等拿到 Key，真打一次把 FIXTURE 覆盖掉，
 * 上层一行不用改——PriceSource 的契约两边一样。
 */

const w = (over: Partial<TravelWatch> = {}): TravelWatch => ({
  id: 'w1', taskId: 't1', kind: 'flight', label: '成都→首尔',
  status: 'active', ...over,
})

const NOW = 1_756_000_000_000

describe('诚实：不许冒充真数据', () => {
  it('每个报价都带示例数据标记——模型看得见，才不会说成实时价', async () => {
    const s = mockSource(() => NOW)
    expect((await s.quote(w())).note).toContain(MOCK_NOTE)
  })

  it('历史点也是示例——曲线不能一半真一半假', async () => {
    const s = mockSource(() => NOW)
    const h = await s.history!(w(), 30)
    expect(h.length).toBeGreaterThan(0)
  })
})

describe('可重放：演示者能预判结果', () => {
  it('同一条委托两次取值完全相同——同一场 Demo 演两遍长得一样', async () => {
    const a = await mockSource(() => NOW).quote(w())
    const b = await mockSource(() => NOW).quote(w())
    expect(a.value).toBe(b.value)
  })

  it('不同委托的曲线不同——两张卡不能长成一个样', async () => {
    const s = mockSource(() => NOW)
    const a = await s.quote(w({ id: 'w1' }))
    const b = await s.quote(w({ id: 'w2' }))
    expect(a.value).not.toBe(b.value)
  })

  it('机票和酒店的量级不同——1800 的机票和 600 的酒店不该在一个区间', async () => {
    const s = mockSource(() => NOW)
    const f = await s.quote(w({ id: 'x', kind: 'flight' }))
    const h = await s.quote(w({ id: 'x', kind: 'hotel' }))
    expect(f.value).toBeGreaterThan(h.value)
  })
})

describe('数据形状：喂得动趋势分析', () => {
  it('30 天历史给满，按时间正序', async () => {
    const h = await mockSource(() => NOW).history!(w(), 30)
    expect(h.length).toBeGreaterThanOrEqual(28)
    for (let i = 1; i < h.length; i++) expect(h[i].at).toBeGreaterThan(h[i - 1].at)
  })

  it('价格都是正的整数，没有负数没有小数分——机票不会卖 -3 块或 1868.4237 块', async () => {
    const h = await mockSource(() => NOW).history!(w(), 30)
    for (const p of h) {
      expect(p.value).toBeGreaterThan(0)
      expect(Number.isInteger(p.value)).toBe(true)
    }
  })

  it('最新一个历史点接得上当前报价——曲线末端不该跟大数字对不上', async () => {
    const s = mockSource(() => NOW)
    const h = await s.history!(w(), 30)
    const q = await s.quote(w())
    const last = h[h.length - 1].value
    expect(Math.abs(q.value - last) / last).toBeLessThan(0.15)
  })

  it('机票整体是走低的——演示要能跌破提醒线，不然触发那一段没法演', async () => {
    const h = await mockSource(() => NOW).history!(w({ kind: 'flight' }), 30)
    expect(h[h.length - 1].value).toBeLessThan(h[0].value)
  })
})
