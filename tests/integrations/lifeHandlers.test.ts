import { describe, it, expect, beforeEach } from 'vitest'
import { createStore } from '../../src/core/store'
import { createRegistry } from '../../src/tools/registry'
import { createDesk } from '../../src/cards/desk'
import { SIGNALS } from '../../src/config/signals'
import { CONSTRAINTS } from '../../src/config/constraints'
import { TOOLS } from '../../src/config/tools'

/**
 * 生活资讯三件套（接入清单梯队 02）：股价/节假日/诗词。
 * handler 只做机制：解析→查询→上卡→给人话 message，一个 if 都不解析意图。
 */

let store: ReturnType<typeof createStore>
let desk: ReturnType<typeof createDesk>

const stocks = {
  search: async (q: string) => q.includes('茅台') ? [{ code: 'sh600519', name: '贵州茅台', kind: 'GP-A' }] : [],
  quote: async (codes: string[]) => codes.map(c => ({
    code: c, name: c === 'sh600519' ? '贵州茅台' : '恒生指数',
    price: 1286.21, change: -6.88, pct: -0.53, high: 1298.86, low: 1285.17,
  })),
}
const holiday = {
  query: async () => ({
    today: { kind: 'normal' as const },
    next: { name: '国庆节', date: '2026-10-01', days: 44 },
    makeup: { name: '国庆节前调休', date: '2026-09-27', days: 40 },
  }),
}
const poem = { today: async () => ({ content: '万里不惜死，一朝得成功。', origin: '塞下曲', author: '高适' }) }

beforeEach(() => {
  store = createStore(SIGNALS, CONSTRAINTS)
  desk = createDesk()
})

const mk = () => createRegistry(store, TOOLS, Date.now, { desk, stocks, holiday, poem } as any)

describe('stock.query', () => {
  it('名字先搜代码再查价，指标卡上屏，message 报人话涨跌', async () => {
    const r = await mk().invoke('stock.query', { query: '茅台' })
    expect(r.status).toBe('ok')
    expect(r.message).toContain('贵州茅台')
    expect(r.message).toContain('1286.21')
    expect(r.message).toMatch(/跌|-0\.53/)
    const card = desk.layout().cards.find(c => c.template === 'metric')
    expect(card, '指标卡该上屏').toBeTruthy()
    expect(card!.data.value).toBe(1286.21)
  })
  it('代码形状的输入直查，不浪费一次搜索', async () => {
    const r = await mk().invoke('stock.query', { query: 'hkHSI' })
    expect(r.status).toBe('ok')
    expect(r.message).toContain('恒生指数')
  })
  it('搜不到给人话拒绝', async () => {
    const r = await mk().invoke('stock.query', { query: '不存在的股票' })
    expect(r.status).toBe('unavailable')
    expect(r.message).not.toContain('undefined')
  })
})

describe('holiday.query', () => {
  it('下一个假期 + 调休提醒都在 message 里', async () => {
    const r = await mk().invoke('holiday.query', {})
    expect(r.status).toBe('ok')
    expect(r.message).toContain('国庆节')
    expect(r.message).toContain('44')
    expect(r.message, '周末要上班必须提前说').toContain('调休')
  })
})

describe('poem.today', () => {
  it('诗句带出处，直接可播报', async () => {
    const r = await mk().invoke('poem.today', {})
    expect(r.status).toBe('ok')
    expect(r.message).toContain('万里不惜死')
    expect(r.message).toContain('高适')
  })
})
