import { describe, it, expect } from 'vitest'
import { createFxClient, FxError } from '../../src/integrations/frankfurter'
import type { Fetcher } from '../../src/integrations/amap'

/**
 * 汇率客户端（frankfurter.dev，2026-08-20）。四类监控项里最先接的一个——
 * 零 Key 零注册、官方 ACAO:*、**自带日级历史时序**，机酒还在选型时它就能
 * 先把「采样 → 攒曲线 → 判阈值 → 出趋势卡」整条链路跑通。
 *
 * 实测（2026-08-20 真调）挖到的两件事，测试里都钉住：
 *   ① 外汇市场周末休市，时序**必然有缺口**——问 5 天可能只回 4 天，
 *     缺的那天不是错误，不许当失败处理
 *   ② 接口按 1 单位基准币给数（1 CNY = 207.68 KRW），而人说汇率习惯说
 *     「100 块换两万韩元」——换算成人话的位置在客户端，不在 handler
 */

const fake = (body: unknown, ok = true): Fetcher =>
  (async () => ({ ok, json: async () => body })) as unknown as Fetcher

describe('latest()：当前汇率', () => {
  it('按 100 单位给出——人说汇率不说「1 比 207」', async () => {
    const c = createFxClient(fake({ amount: 1.0, base: 'CNY', date: '2026-08-20', rates: { KRW: 207.68 } }))
    const r = await c.latest('CNY', 'KRW')
    expect(r.per100).toBeCloseTo(20768, 0)
    expect(r.rate).toBeCloseTo(207.68, 2)
    expect(r.date).toBe('2026-08-20')
  })

  it('目标币种不在返回里 → 抛人话错误，不是 undefined 往下传', async () => {
    const c = createFxClient(fake({ amount: 1.0, base: 'CNY', date: '2026-08-20', rates: {} }))
    await expect(c.latest('CNY', 'XYZ')).rejects.toBeInstanceOf(FxError)
  })

  it('HTTP 失败 → FxError，带得上人话', async () => {
    const c = createFxClient(fake({}, false))
    await expect(c.latest('CNY', 'KRW')).rejects.toBeInstanceOf(FxError)
  })
})

describe('series()：30 天历史，接上第一天就有曲线', () => {
  const body = {
    amount: 1.0, base: 'CNY', start_date: '2026-07-21', end_date: '2026-07-24',
    rates: {
      '2026-07-23': { KRW: 217.53 },
      '2026-07-21': { KRW: 218.5 },
      '2026-07-24': { KRW: 215.74 },
      '2026-07-22': { KRW: 218.57 },
    },
  }

  it('按日期正序给出——对象键的顺序不能信', async () => {
    const c = createFxClient(fake(body))
    const s = await c.series('CNY', 'KRW', '2026-07-21', '2026-07-25')
    expect(s.map(p => p.date)).toEqual(['2026-07-21', '2026-07-22', '2026-07-23', '2026-07-24'])
  })

  it('周末缺口不算失败——问 5 天回 4 天是外汇市场的常态', async () => {
    const c = createFxClient(fake(body))
    const s = await c.series('CNY', 'KRW', '2026-07-21', '2026-07-25')
    expect(s).toHaveLength(4)
    expect(s.every(p => Number.isFinite(p.per100))).toBe(true)
  })

  it('历史点也按 100 单位，跟 latest 同一个口径——曲线和当前值不能两套刻度', async () => {
    const c = createFxClient(fake(body))
    const s = await c.series('CNY', 'KRW', '2026-07-21', '2026-07-25')
    expect(s[0].per100).toBeCloseTo(21850, 0)
  })

  it('一天数据都没有 → 空数组，不抛——新币种或超早日期是合法的空', async () => {
    const c = createFxClient(fake({ amount: 1, base: 'CNY', rates: {} }))
    expect(await c.series('CNY', 'KRW', '2026-07-21', '2026-07-25')).toEqual([])
  })
})
