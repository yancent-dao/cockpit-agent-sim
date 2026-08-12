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
    expect(desk.findByKey('websearch')!.data.text).toContain('44 万辆')
  })

  // 答案会被车载助手念出来，Markdown 是噪音
  it('给搜索模型的指令里写死了不要 Markdown', async () => {
    let sys = ''
    const r = mk('答案', s => { sys = s })
    await r.invoke('web.search', { query: 'x' })
    expect(sys).toMatch(/Markdown/)
    expect(sys).toMatch(/开车|车载|语音/)
  })

  /**
   * 实测：给 Agent 全文，它就整段念——四轮话术 122/144/165/185 字，
   * 改完 Tool 描述再跑，变成 284/363/366 字，不降反升。
   * 光靠嘱咐没用，得让它根本看不到长文。
   */
  it('只把一句话结论返回给 Agent，长文只进卡片', async () => {
    const long = '零跑B01性价比最高。\n\n车身四米七七，轴距两米七三五，后备厢四百六十升。'
      + '续航三个版本，四百三、五百五、六百五公里。激光雷达只有高配两款才有。'
    const r = mk(long)
    const res = await r.invoke('web.search', { query: '新电动车' })
    const answer = (res.data as any).answer
    expect(answer).toBe('零跑B01性价比最高。')
    expect(answer).not.toContain('轴距')          // 细节没进 Agent 上下文
    expect(desk.findByKey('websearch')!.data.text).toContain('轴距')  // 但屏幕上有
  })

  it('结论过长也截断——搜索模型不听话时兜底', async () => {
    const r = mk('一'.repeat(200) + '\n\n详细内容')
    const res = await r.invoke('web.search', { query: 'x' })
    expect(String((res.data as any).answer).length).toBeLessThanOrEqual(80)
  })

  it('搜索模型没分段时不至于丢内容', async () => {
    const r = mk('就一段话没有空行')
    const res = await r.invoke('web.search', { query: 'x' })
    expect((res.data as any).answer).toBe('就一段话没有空行')
    expect(desk.findByKey('websearch')!.data.text).toBe('就一段话没有空行')
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
