import { describe, it, expect, beforeEach } from 'vitest'
import { createStore } from '../../src/core/store'
import { createRegistry } from '../../src/tools/registry'
import { createDesk } from '../../src/cards/desk'
import { createWebSearch } from '../../src/integrations/websearch'
import { SIGNALS } from '../../src/config/signals'
import { CONSTRAINTS } from '../../src/config/constraints'
import { TOOLS } from '../../src/config/tools'

let store: ReturnType<typeof createStore>
let desk: ReturnType<typeof createDesk>

beforeEach(() => {
  store = createStore(SIGNALS, CONSTRAINTS)
  desk = createDesk()
})

const mk = (answer: string | (() => Promise<string>), onCall?: (s: string, p: string) => void) =>
  createRegistry(store, TOOLS, Date.now, {
    desk,
    websearch: createWebSearch(async (s, p) => {
      onCall?.(s, p)
      return typeof answer === 'string' ? answer : answer()
    }),
  } as any)

/**
 * 它不发 HTTP 给某个 CP，而是让模型带着联网能力再想一遍。
 * 对 Agent 来说仍然是个普通 Tool——这样就不需要任何"这问题要不要联网"的
 * 意图判断，那种判断是硬约束禁止的。
 */
describe('web.search', () => {
  it('拿到答案并上屏', async () => {
    const r = mk('特斯拉 2026 年第二季度交付 44 万辆。')
    const res = await r.invoke('web.search', { query: '特斯拉最新交付量' })
    expect(res.status).toBe('ok')
    expect((res.data as any).answer).toContain('44 万辆')
    const card = desk.findByKey('websearch')!
    expect(card.data.text).toContain('44 万辆')
  })

  // 答案会被车载助手念出来，Markdown 是噪音
  it('给搜索模型的指令里写死了不要 Markdown', async () => {
    let sys = ''
    const r = mk('答案', s => { sys = s })
    await r.invoke('web.search', { query: 'x' })
    expect(sys).toMatch(/Markdown/)
    expect(sys).toMatch(/开车|车载|语音/)
  })

  it('搜了个空 → unavailable，不能假装有答案', async () => {
    const r = mk('   ')
    const res = await r.invoke('web.search', { query: 'x' })
    expect(res.status).toBe('unavailable')
  })

  it('模型调用炸了也要翻译成人话', async () => {
    const r = mk(async () => { throw new Error('402 余额不足') })
    const res = await r.invoke('web.search', { query: 'x' })
    expect(res.status).toBe('unavailable')
    expect(res.message).toContain('余额不足')
  })
})
