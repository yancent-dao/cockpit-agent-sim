import { createStore } from './core/store'
import { createRegistry } from './tools/registry'
import { createAgent } from './agent/runtime'
import { createOpenRouter } from './agent/llm'
import { SIGNALS } from './config/signals'
import { CONSTRAINTS } from './config/constraints'
import { TOOLS } from './config/tools'
import { MAIN_AGENT } from '../agents/main-agent/manifest'

const CASES: Array<{ n: number; g: string; say: string; pre?: (s: any) => void }> = [
  { n: 1, g: 'Base', say: '打开主驾车窗' },
  { n: 2, g: 'Base', say: '开一半' },
  { n: 3, g: 'Base', say: '把窗户都关了' },
  { n: 4, g: 'Disambig', say: '开个窗', pre: s => s.setDirect('perception.voiceSource', 'rearLeft') },
  { n: 5, g: 'Disambig', say: '算了关上' },
  { n: 6, g: 'Disambig', say: '开窗', pre: s => s.setDirect('env.weather', 'rain') },
  { n: 7, g: 'Guard', say: '窗户开到底', pre: s => s.setDirect('vehicle.speed', 120) },
  { n: 8, g: 'Guard', say: '把后窗打开', pre: s => { s.setDirect('vehicle.speed', 0); s.setDirect('cabin.childLock', true) } },
  { n: 9, g: 'Guard', say: '开一下天窗', pre: s => s.setDirect('cabin.childLock', false) },
]

;(window as any).__bench = async (key: string, modelId?: string) => {
  const store = createStore(SIGNALS, CONSTRAINTS)
  const registry = createRegistry(store, TOOLS)
  let model = modelId ?? ''
  const llm = createOpenRouter(() => key, () => model)

  if (!model) {
    const ms = await llm.models()
    const fast = ms.filter(m => /flash|mini|haiku|lite|turbo|small|nano/i.test(m.id))
      .sort((a, b) => (a.promptPrice ?? 0) - (b.promptPrice ?? 0))
    model = (fast[0] ?? ms[0]).id
    ;(window as any).__modelCount = { total: ms.length, fast: fast.length }
  }

  const agent = createAgent({ manifest: MAIN_AGENT, registry, store, llm })
  const out: any[] = []
  for (const c of CASES) {
    c.pre?.(store)
    // 让过渡跑一点，第 5 条要在中间态打断
    if (c.n === 5) store.tick(1200)
    const t0 = performance.now()
    let r: any
    try { r = await agent.run(c.say) } catch (e) { r = { reply: '', trace: [], rounds: 0, stopReason: 'error', err: String(e) } }
    const calls = r.trace.filter((s: any) => s.type === 'toolCall')
      .map((s: any) => `${s.name}(${JSON.stringify(s.args)})`)
    const results = r.trace.filter((s: any) => s.type === 'toolResult')
      .map((s: any) => `${s.result.status}${s.result.code ? ':' + s.result.code : ''}`)
    out.push({
      n: c.n, g: c.g, say: c.say, calls, results, reply: r.reply,
      rounds: r.rounds, stop: r.stopReason, err: r.err,
      ms: Math.round(performance.now() - t0),
      win: {
        d: Math.round(store.getTarget('cabin.window.driver.position') as number),
        p: Math.round(store.getTarget('cabin.window.passenger.position') as number),
        rl: Math.round(store.getTarget('cabin.window.rearLeft.position') as number),
        rr: Math.round(store.getTarget('cabin.window.rearRight.position') as number),
      },
    })
    ;(window as any).__results = out
  }
  ;(window as any).__model = model
  ;(window as any).__done = true
  return out.length
}
