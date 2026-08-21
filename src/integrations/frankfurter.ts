/**
 * 汇率客户端（frankfurter.dev，2026-08-20，旅行助手四类监控项之一）。
 *
 * ## 为什么是它
 *
 * 跟 Open-Meteo 同一条选型逻辑，三个特性正好踩中本项目的第一性约束：
 *   · **零 Key 零注册** —— .env.local 不多一行，单文件版 `import.meta.env`
 *     读不到的坑直接绕开
 *   · **官方 CORS**（实测 `access-control-allow-origin: *`）—— 零后端硬约束满足
 *   · **自带日级历史时序** —— 这条是它比别家值钱的地方：「近 30 天走势」
 *     不用等自己攒一个月，接上第一天就有真曲线，「建议必须带依据」
 *     那条 PRD 红线当天就能兑现
 *
 * 数据源是欧洲央行参考汇率。已知短板照实记：**只有工作日**（外汇市场
 * 周末休市），且是日级不是实时——对"要不要现在换汇"这个决策粒度够用。
 *
 * ## 边界
 *
 * 这一层只做协议适配：日期排序、缺口容忍、单位换算。什么时候采、
 * 到什么值提醒、话怎么说，全在上面——handler 和模型的事。
 */
import type { Fetcher } from './amap'
import { api } from '../config/upstream'

/** per-request 超时。跟 radio(5s)/itunes(4s) 同思路：fetch 先抛，副作用走不到 */
const TIMEOUT_MS = 6000

export class FxError extends Error {
  constructor(message: string, readonly code?: string) { super(message) }
}

export interface FxPoint {
  date: string
  /** 1 单位基准币兑多少目标币（接口原值） */
  rate: number
  /**
   * 100 单位基准币兑多少目标币。**人说汇率说的是这个**——「100 块换两万韩元」，
   * 没人说「1 比 207.68」。换算放客户端不放 handler：它是这个 CP 的
   * 表达习惯与人的表达习惯之间的差，属于协议适配。
   */
  per100: number
}

const point = (date: string, rate: number): FxPoint =>
  ({ date, rate, per100: Math.round(rate * 100 * 100) / 100 })

export function createFxClient(fetcher: Fetcher = fetch) {
  const get = async (path: string): Promise<any> => {
    let res: Awaited<ReturnType<Fetcher>>
    try {
      res = await fetcher(`${api('frankfurter')}${path}`, { signal: AbortSignal.timeout(TIMEOUT_MS) } as any)
    } catch (e) {
      throw new FxError(`汇率服务连不上：${e instanceof Error ? e.message : String(e)}`, 'FX_NETWORK')
    }
    if (!res.ok) throw new FxError('汇率服务没接受这次请求', 'FX_HTTP')
    return res.json()
  }

  return {
    /** 当前汇率 */
    async latest(base: string, symbol: string): Promise<FxPoint> {
      const j = await get(`/v1/latest?base=${encodeURIComponent(base)}&symbols=${encodeURIComponent(symbol)}`)
      const rate = j?.rates?.[symbol]
      if (typeof rate !== 'number')
        throw new FxError(`查不到 ${base} 兑 ${symbol} 的汇率`, 'FX_NO_DATA')
      return point(String(j.date ?? ''), rate)
    },

    /**
     * 区间历史，按日期正序。
     *
     * 两处刻意的宽容，都是实测出来的：
     *   · **对象键的顺序不能信**，自己排
     *   · **周末必然缺口**（问 5 天回 4 天），缺的那天不是错误，
     *     一天都没有也只是空数组，不抛——新币种、超早日期都是合法的空
     */
    async series(base: string, symbol: string, from: string, to: string): Promise<FxPoint[]> {
      const j = await get(`/v1/${from}..${to}?base=${encodeURIComponent(base)}&symbols=${encodeURIComponent(symbol)}`)
      const rates = j?.rates ?? {}
      return Object.keys(rates)
        .filter(d => typeof rates[d]?.[symbol] === 'number')
        .sort()
        .map(d => point(d, rates[d][symbol]))
    },
  }
}

export type FxClient = ReturnType<typeof createFxClient>
