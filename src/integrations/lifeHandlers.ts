/**
 * 生活资讯 handlers：股价 · 节假日 · 今日诗词（接入清单梯队 02，零 Key）。
 *
 * 机制归这里：解析参数 → 查询 → 上卡 → 给人话 message。
 * 判断"用户问的是哪只股票"不在这——名字解析交给 smartbox 搜索（数据查询），
 * 代码形状直查的判据是**数据形状**（sh/sz/hk/us/wh 前缀），不是意图。
 */
import type { Desk } from '../cards/desk'
import type { ToolResult } from '../tools/registry'
import type { StockClient } from './qtstock'
import type { HolidayClient } from './holiday'
import type { PoemClient } from './poem'

const CODE_SHAPE = /^(sh|sz|hk|us|wh)[A-Za-z0-9.]+$/

const weekday = (date: string) => '日一二三四五六'[new Date(date + 'T00:00:00').getDay()]

export function createLifeHandlers(
  desk: () => Desk | undefined,
  stocks: () => StockClient | undefined,
  holiday: () => HolidayClient | undefined,
  poem: () => PoemClient | undefined,
  clock: () => number,
) {
  return {
    stockQuery: async (args: any): Promise<ToolResult> => {
      const cp = stocks()
      if (!cp) return { status: 'unavailable', code: 'NO_CP', message: '行情服务没接' }
      const q = String(args.query ?? '').trim()
      if (!q) return { status: 'rejected', code: 'INVALID_PARAMS', message: '要查哪只股票或指数？' }
      try {
        let code = q
        if (!CODE_SHAPE.test(q)) {
          const hits = await cp.search(q)
          if (!hits.length)
            return { status: 'unavailable', code: 'NOT_FOUND',
              message: `没搜到「${q}」这只股票`, suggestion: '换个名字或直接给代码（如 sh600519）' }
          code = hits[0].code
        }
        const [quote] = await cp.quote([code])
        if (!quote) return { status: 'unavailable', code: 'NO_DATA', message: '行情数据没取到' }
        const up = quote.change >= 0
        const sign = up ? '+' : ''
        desk()?.render({
          key: `stock-${quote.code}`, template: 'metric', kind: 'task', ttl: 'untilDismissed',
          data: {
            title: quote.name, value: quote.price,
            trend: `${sign}${quote.change} (${sign}${quote.pct}%)`,
            ...(quote.high !== undefined && { sub: `高 ${quote.high} · 低 ${quote.low}` }),
          },
        })
        return { status: 'ok', data: { quote },
          message: `${quote.name}现价 ${quote.price}，${up ? '涨' : '跌'} ${Math.abs(quote.change)}（${sign}${quote.pct}%），已上屏` }
      } catch (e) {
        return { status: 'failed', code: 'STOCK_ERROR', message: `行情没查成：${e instanceof Error ? e.message : e}` }
      }
    },

    holidayQuery: async (): Promise<ToolResult> => {
      const cp = holiday()
      if (!cp) return { status: 'unavailable', code: 'NO_CP', message: '节假日服务没接' }
      try {
        const today = new Date(clock()).toISOString().slice(0, 10)
        const r = await cp.query(today)
        const parts: string[] = []
        if (r.today.kind === 'holiday') parts.push(`今天${r.today.name}放假`)
        if (r.today.kind === 'workday') parts.push(`今天是${r.today.name}，要上班`)
        if (r.next) parts.push(`下一个假期是${r.next.name}，${r.next.date.slice(5).replace('-', '月')}日（周${weekday(r.next.date)}），还有 ${r.next.days} 天`)
        // 调休上班在假期之前才值得提——过了假期的补班等下次查再说
        if (r.makeup && (!r.next || r.makeup.days < r.next.days))
          parts.push(`注意 ${r.makeup.date.slice(5).replace('-', '月')}日（周${weekday(r.makeup.date)}）调休要上班`)
        return { status: 'ok', data: r, message: parts.join('；') || '近期没有假期安排' }
      } catch (e) {
        return { status: 'failed', code: 'HOLIDAY_ERROR', message: `节假日没查成：${e instanceof Error ? e.message : e}` }
      }
    },

    poemToday: async (): Promise<ToolResult> => {
      const cp = poem()
      if (!cp) return { status: 'unavailable', code: 'NO_CP', message: '诗词服务没接' }
      try {
        const p = await cp.today()
        return { status: 'ok', data: p,
          message: `${p.content}——${p.author}${p.origin ? `《${p.origin}》` : ''}` }
      } catch (e) {
        return { status: 'failed', code: 'POEM_ERROR', message: `诗词没取到：${e instanceof Error ? e.message : e}` }
      }
    },
  }
}
