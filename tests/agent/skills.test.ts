import { describe, it, expect, beforeEach } from 'vitest'
import { createStore } from '../../src/core/store'
import { createRegistry } from '../../src/tools/registry'
import { createPipeline } from '../../src/agent/pipeline'
import { SIGNALS } from '../../src/config/signals'
import { CONSTRAINTS } from '../../src/config/constraints'
import { TOOLS } from '../../src/config/tools'
import { MAIN_AGENT } from '../../agents/main-agent/manifest'
import { FAST_AGENT } from '../../agents/main-agent/fast'
import { SKILLS } from '../../agents/main-agent/skills'
import type { LLM, LLMRequest, LLMReply } from '../../src/agent/llm'

/**
 * Skill（设计文档 §9）：过程性知识的第三个家。
 * 二级渐进披露：目录行常驻（name+whenToUse）→ skill.use 点名注入正文（≤40 行）。
 * 判断 100% 在模型；命中率靠 whenToUse 文案。快层永不挂；子 Agent 也挂。
 */

function scriptedLLM(fn: (req: LLMRequest, n: number) => LLMReply | Promise<LLMReply>) {
  const seen: LLMRequest[] = []
  return {
    seen,
    async chat(req: LLMRequest) { seen.push(req); return fn(req, seen.length) },
    async models() { return [] },
  } as LLM & { seen: LLMRequest[] }
}
const call = (name: string, args: any, id = 'c' + Math.random().toString(36).slice(2, 6)) =>
  ({ id, name, args })

let store: ReturnType<typeof createStore>
let reg: ReturnType<typeof createRegistry>
beforeEach(() => {
  store = createStore(SIGNALS, CONSTRAINTS)
  reg = createRegistry(store, TOOLS)
})

const mk = (slowFn: (req: LLMRequest, n: number) => LLMReply | Promise<LLMReply>) => {
  const fast = scriptedLLM(() => ({ text: '' }))
  const slow = scriptedLLM(slowFn)
  const p = createPipeline({
    registry: reg, store, fastLlm: fast, slowLlm: slow,
    fastManifest: FAST_AGENT, slowManifest: { ...MAIN_AGENT, skills: SKILLS },
  })
  return { p, fast, slow }
}

describe('skill 全是数据', () => {
  it('导航、媒体、生成卡片，正文 ≤40 行、whenToUse ≤20 字', () => {
    const names = SKILLS.map(s => s.name)
    expect(names).toContain('导航')
    expect(names).toContain('媒体')
    expect(names).toContain('生成卡片')
    // 产品红线：不许有场景专属的卡片 skill（"调研报告"这类）——
    // 规范跟着"卡"走不跟着"场景"走，任何意料之外的需求同一条路
    expect(names).not.toContain('调研报告')
    for (const s of SKILLS) {
      expect(s.whenToUse.length, `${s.name} whenToUse 超长`).toBeLessThanOrEqual(20)
      expect(s.inject.split('\n').length, `${s.name} 正文超 40 行`).toBeLessThanOrEqual(40)
      // 技能点的工具必须真实存在——剧本引用幽灵工具，模型照着调只会撞 UNKNOWN_TOOL
      for (const t of s.tools ?? [])
        expect(TOOLS.some(x => x.name === t), `${s.name} 引用了不存在的工具 ${t}`).toBe(true)
    }
  })

  it('新三件（晨报/天气应对/氛围导演）在目录里', () => {
    const names = SKILLS.map(s => s.name)
    for (const n of ['出发晨报', '天气应对', '氛围导演']) expect(names).toContain(n)
    // 天气应对的核心论点：贴心逻辑在剧本不在代码——剧本里必须真提到联动件
    const w = SKILLS.find(s => s.name === '天气应对')!
    for (const t of ['wiper.set', 'defrost.set', 'light.set']) expect(w.tools).toContain(t)
  })

  it('「生成卡片」是场景无关的设计规范：配色/图标/图表/代码规范/输出格式全齐', () => {
    const g = SKILLS.find(s => s.name === '生成卡片')!
    expect(g.tools).toContain('card.show')
    // 2026-08-18 方案三：规范从"文字条款"改成"现成 HMI 类 + 填空骨架"——
    // 断言跟着换：类清单、骨架、负面清单、svg、兜底文字都得在
    for (const kw of ['.hd', '.hero', '.rows', '骨架', '负面清单', '#DB4045', 'svg', 'emoji', 'text'])
      expect(g.inject, `规范缺 ${kw}`).toContain(kw)
    // 场景词不许出现——出现就是又在偷偷绑场景
    for (const banned of ['股价', '调研', '报告', '天气', '新闻'])
      expect(g.inject, `规范里不许有场景词「${banned}」`).not.toContain(banned)
  })
})

describe('二级披露', () => {
  it('目录行常驻慢层 system；正文不在', async () => {
    const { p, slow } = mk(() => ({ text: '' }))
    await p.run('你好')
    const sys = slow.seen[0].system
    expect(sys).toContain('技能目录')
    for (const s of SKILLS) expect(sys).toContain(s.whenToUse)
    expect(sys, '正文命中才注入').not.toContain(SKILLS[0].inject.slice(0, 20))
  })

  it('skill.use 点名 → 正文以工具结果注入，附带工具进下一轮', async () => {
    const { p, slow } = mk((req, n) => {
      if (n === 1) return { toolCalls: [call('skill.use', { name: '导航' })] }
      return { text: '照剧本办' }
    })
    await p.run('帮我顺路找个充电站')
    const toolMsg = p.thread.find(m => m.role === 'tool' && m.content.includes(SKILLS[0].inject.slice(0, 12)))
    expect(toolMsg, '正文进了 thread').toBeTruthy()
    const r2names = slow.seen[1].tools.map((t: any) => t.function.name)
    expect(r2names, 'skill 附带的工具已装载').toContain('navigation_searchAlong')
  })

  it('点了不存在的 skill → rejected', async () => {
    const { p } = mk((req, n) => {
      if (n === 1) return { toolCalls: [call('skill.use', { name: '不存在的' })] }
      return { text: '好吧' }
    })
    await p.run('随便')
    expect(p.thread.some(m => m.role === 'tool' && m.content.includes('UNKNOWN_SKILL'))).toBe(true)
  })
})

describe('谁挂谁不挂', () => {
  it('快层永不挂：system 无技能目录，工具无 skill_use', async () => {
    const { p, fast } = mk(() => ({ text: '' }))
    await p.run('开窗')
    expect(fast.seen[0].system).not.toContain('技能目录')
    expect(fast.seen[0].tools.map((t: any) => t.function.name).join(',')).not.toContain('skill')
  })

  it('子 Agent 也挂：委托的子任务里能 skill.use', async () => {
    const { p } = mk((req, n) => {
      if (req.messages[0]?.content === '做个调研') {
        if (!req.messages.some(m => m.role === 'tool'))
          return { toolCalls: [call('skill.use', { name: '媒体' })] }
        return { text: '完成' }
      }
      if (!req.messages.some(m => m.role === 'tool')) return { toolCalls: [call('task.delegate', { goal: '做个调研' })] }
      return { text: '好了' }
    })
    const r = await p.run('去调研吧')
    expect(r.stopReason).toBe('reply')
  })
})
