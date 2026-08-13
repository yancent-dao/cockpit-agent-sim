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
  // 产品裁定（实拍"非常丑"）：查证是过程不是交付——原始材料**永不上屏**，
  // 全文返给模型当成文原料，用户只看模型加工后的最终卡/话术
  it('拿到答案，不建任何卡', async () => {
    const r = mk('特斯拉 2026 年第二季度交付 44 万辆。')
    const res = await r.invoke('web.search', { query: '特斯拉最新交付量' })
    expect(res.status).toBe('ok')
    expect((res.data as any).answer).toContain('44 万辆')
    expect(desk.findByKey('websearch'), '查证原料不上屏').toBeUndefined()
    expect(desk.layout().cards).toHaveLength(0)
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
  it('结论与全文分开返回：answer 一句话（播报用），detail 全文（成文原料）', async () => {
    const long = '零跑B01性价比最高。\n\n车身四米七七，轴距两米七三五，后备厢四百六十升。'
      + '续航三个版本，四百三、五百五、六百五公里。激光雷达只有高配两款才有。'
    const r = mk(long)
    const res = await r.invoke('web.search', { query: '新电动车' })
    expect((res.data as any).answer).toBe('零跑B01性价比最高。')
    // 原料必须回到模型手里——不上屏之后这是它成文的唯一来源
    expect((res.data as any).detail).toContain('轴距')
    expect(res.message, '播报纪律随结果带回').toContain('结论')
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
    expect((res.data as any).detail).toBe('就一段话没有空行')
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
