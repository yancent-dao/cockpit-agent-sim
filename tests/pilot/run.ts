/**
 * Pilot 跑批器 —— 用户机器人对着真实 Agent 跑场景，落盘结构化快照供人工评审。
 *
 * 不进 npm test：会消耗真实 OpenRouter/高德额度。
 * 用法：npx tsx tests/pilot/run.ts [场景id...]
 */
import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs'
import { createStore } from '../../src/core/store'
import { createDesk } from '../../src/cards/desk'
import { createOrchestrator } from '../../src/cards/orchestrator'
import { createRegistry } from '../../src/tools/registry'
import { createAmapClient } from '../../src/integrations/amap'
import { createAgent } from '../../src/agent/runtime'
import { createOpenRouter } from '../../src/agent/llm'
import { SIGNALS } from '../../src/config/signals'
import { CONSTRAINTS } from '../../src/config/constraints'
import { TOOLS } from '../../src/config/tools'
import { CARD_RULES, DATA_BUILDERS } from '../../src/config/cardRules'
import { MAIN_AGENT } from '../../agents/main-agent/manifest'
import { SCENARIOS, type Scenario } from './scenarios'
import { createUserBot, soundsLikeAssistant } from './userBot'

/** .env.local 是 Vite 的前端机制，Node 里读不到，手动解析一下 */
/** import.meta.url 是 URL，中文路径会被百分号编码，落盘前必须解回来 */
const localPath = (rel: string) => decodeURIComponent(new URL(rel, import.meta.url).pathname)

function loadEnvLocal() {
  const p = localPath('../../.env.local')
  if (!existsSync(p)) return
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(/^\s*([\w.]+)\s*=\s*(.*)\s*$/)
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
  }
}
loadEnvLocal()

const OPENROUTER_KEY = process.env.VITE_OPENROUTER_KEY ?? ''
const AMAP_KEY = process.env.VITE_AMAP_WEB_KEY ?? ''
const AGENT_MODEL = process.env.PILOT_AGENT_MODEL ?? 'minimax/minimax-m3'
const BOT_MODEL = process.env.PILOT_BOT_MODEL ?? 'minimax/minimax-m3'

if (!OPENROUTER_KEY) { console.error('缺 VITE_OPENROUTER_KEY'); process.exit(1) }
if (!AMAP_KEY) console.warn('缺 VITE_AMAP_WEB_KEY，导航/天气类场景会报 unavailable')

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

/** 用户机器人用的裸 LLM 调用——不带 tools，跟被测 Agent 完全独立。429 退避重试，别让跑批半路挂 */
async function botChat(system: string, messages: Array<{ role: 'user' | 'assistant'; content: string }>) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${OPENROUTER_KEY}`, 'Content-Type': 'application/json', 'X-Title': 'Cockpit Pilot Bot' },
      body: JSON.stringify({ model: BOT_MODEL, messages: [{ role: 'system', content: system }, ...messages], temperature: 0.8 }),
    })
    if (res.ok) return (await res.json()).choices?.[0]?.message?.content ?? ''
    if (res.status === 429 && attempt < 4) { await sleep(2000 * (attempt + 1)); continue }
    throw new Error(`用户机器人调用失败 ${res.status}: ${await res.text()}`)
  }
}

/** 每张卡只留判断需要的字段，避免快照被 data 撑爆 */
const digest = (c: any) => {
  const d = c.data ?? {}
  const keep: Record<string, unknown> = {}
  for (const k of ['title', 'destination', 'eta', 'distance', 'question', 'text']) if (d[k] !== undefined) keep[k] = d[k]
  if (Array.isArray(d.items)) keep.items = d.items.slice(0, 6).map((i: any) => i.label ?? i)
  if (d.now) keep.now = `${d.now.weather} ${d.now.temperature}°C`
  if (d.mapUrl) keep.mapUrl = '有图'
  return keep
}

/** 确定性硬伤检测——不靠模型判断，规则见 RUBRIC.md 第 3 维 */
function detectIssues(store: any, desk: any, calls: any[], reply: string): string[] {
  const out: string[] = []
  const layout = desk.layout()
  const keys = layout.cards.map((c: any) => c.key)

  for (const c of calls) {
    const code = c.result?.code
    if (['DESKTOP_FULL', 'DATA_SHAPE_MISMATCH', 'SIZE_NOT_SUPPORTED', 'NO_HANDLER', 'HANDLER_ERROR'].includes(code))
      out.push(`Tool ${c.name} 返回 ${code}：${c.result?.message ?? ''}`)
  }
  if (store.get('navigation.active') === true && !keys.includes('nav'))
    out.push('导航进行中但桌面没有导航卡')
  if (keys.includes('nav-candidates') && keys.includes('ask'))
    out.push('候选列表卡与问题卡同时在场（同一件事出了两张选择卡）')
  const dup = keys.filter((k: string, i: number) => k && keys.indexOf(k) !== i)
  if (dup.length) out.push(`同 key 卡片重复：${[...new Set(dup)].join('、')}`)

  // 反幻觉：声称屏幕上有东西，但桌面确实空着（CAR-bench "宁可编造也不认怂"）
  if (/屏幕上|屏上|已(经)?(全屏)?显示|看屏幕|清单已/.test(reply) && layout.cards.length === 0 && !layout.overlay)
    out.push(`话术声称屏幕上有内容，但桌面是空的：「${reply.slice(0, 40)}」`)
  // 思考标签泄漏进播报
  if (/<\/?\w*:?think>/.test(reply)) out.push(`话术含思考标签泄漏：「${reply.slice(0, 40)}」`)
  // 语音播报不该有 Markdown
  if (/^\s*[-*#]\s|\*\*/.test(reply)) out.push(`话术含 Markdown 标记（语音场景是噪音）：「${reply.slice(0, 40)}」`)
  // 车机屏是纯展示，用户在开车只能说话——让用户"点"是骗人
  // "随你点"（点播）不算，只抓真正指向屏幕操作的说法
  if (/点一下|点击|点选|按一下|点[这那]个|在屏幕上[点按选]/.test(reply))
    out.push(`话术让用户点屏幕，但车机屏不可交互：「${reply.slice(0, 40)}」`)
  // 车载产品不该报底层模型身份
  if (/我是\s*(MiniMax|GPT|Claude|Gemini|Qwen|通义|文心|豆包|DeepSeek)/i.test(reply))
    out.push(`话术泄漏底层模型身份：「${reply.slice(0, 40)}」`)
  // 经纬度念出来是噪音
  if (/东经|北纬|\d{2,3}\.\d{4,}/.test(reply))
    out.push(`话术念了坐标数字（语音场景是噪音）：「${reply.slice(0, 40)}」`)
  // 语音播报念一百字要二十多秒，人设写的是"一般不超过两句"
  if (reply.length > 100)
    out.push(`话术 ${reply.length} 字，语音播报太长：「${reply.slice(0, 40)}…」`)
  // 屏幕上已经摆出对比列表，话术再把每条的数字念一遍就是重复劳动
  if (layout.cards.some((c: any) => Array.isArray(c.data?.items) && c.data.items.length >= 3)
      && (reply.match(/\d+/g) ?? []).length >= 5)
    out.push(`屏幕已有列表卡，话术还逐条复述了数字：「${reply.slice(0, 40)}…」`)
  return out
}

async function runScenario(s: Scenario) {
  const store = createStore(SIGNALS, CONSTRAINTS)
  const desk = createDesk()
  const amap = AMAP_KEY ? createAmapClient(fetch as any, { webKey: AMAP_KEY }) : undefined
  const registry = createRegistry(store, TOOLS, Date.now, { desk, amap })
  createOrchestrator({ store, desk, rules: CARD_RULES, builders: DATA_BUILDERS, deps: { store, amap } }).start()

  for (const [path, value] of Object.entries(s.initial ?? {})) store.setDirect(path, value as any)

  const llm = createOpenRouter(() => OPENROUTER_KEY, () => AGENT_MODEL)
  const agent = createAgent({ manifest: MAIN_AGENT, registry, store, llm,
    desktopSummary: () => desk.summary(), onTurnStart: () => desk.endTask() })
  const bot = createUserBot({ chat: botChat })

  const history: Array<{ role: 'user' | 'assistant'; content: string }> = []
  const turns: any[] = []

  for (let i = 1; i <= s.maxTurns; i++) {
    const { say, done } = await bot.next(s.goal, history)
    if (!say.trim()) { console.log(`  [${i}] 用户机器人没话说了，收尾`); break }
    history.push({ role: 'user', content: say })

    const t0 = Date.now()
    const r = await agent.run(say)
    const calls = r.trace.filter(x => x.type === 'toolCall').map((x: any) => {
      const res = r.trace.find((y: any) => y.type === 'toolResult' && y.name === x.name)
      return { name: x.name, args: x.args, result: (res as any)?.result }
    })
    history.push({ role: 'assistant', content: r.reply || '(无话术)' })

    const layout = desk.layout()
    turns.push({
      turn: i,
      userSaid: say,
      toolCalls: calls.map(c => ({
        name: c.name, args: c.args,
        status: c.result?.status, code: c.result?.code, message: c.result?.message,
      })),
      desk: {
        cards: layout.cards.map((c: any) => ({
          key: c.key, template: c.template, size: c.size,
          pos: `r${c.row}c${c.col}`, data: digest(c),
        })),
        overlay: layout.overlay ? { template: layout.overlay.template, data: digest(layout.overlay) } : null,
        free: layout.free,
      },
      agentReply: r.reply,
      rounds: r.rounds,
      ms: Date.now() - t0,
      issues: [
        ...detectIssues(store, desk, calls, r.reply ?? ''),
        // 用户机器人串戏会污染整场对话，得标出来，不然人工评审会当成产品问题
        ...(soundsLikeAssistant(say) ? [`用户机器人串戏演了助手：「${say.slice(0, 40)}」（这轮结论不可信）`] : []),
      ],
    })

    console.log(`  [${i}] 用户：${say}`)
    console.log(`      Agent：${(r.reply || '(无话术)').slice(0, 80)}`)
    console.log(`      卡片：${layout.cards.map((c: any) => `${c.data?.title ?? c.template}(${c.size})`).join('、') || '空'}`)
    const iss = turns.at(-1)!.issues
    if (iss.length) console.log(`      ⚠ ${iss.join(' / ')}`)

    if (done) break
  }
  return { scenario: s.id, name: s.name, goal: s.goal, turns }
}

async function main() {
  // 参数可以是场景 id，也可以是组名（nav / ctrl / chat）
  const only = process.argv.slice(2)
  const list = only.length
    ? SCENARIOS.filter(s => only.includes(s.id) || only.includes(s.group))
    : SCENARIOS
  const outDir = localPath('./runs/')
  mkdirSync(outDir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')

  const results: any[] = []
  for (const s of list) {
    console.log(`\n▸ ${s.name}（${s.id}）`)
    try {
      results.push(await runScenario(s))
    } catch (e) {
      console.log(`  ✗ 跑挂了：${e}`)
      results.push({ scenario: s.id, name: s.name, error: String(e) })
    }
  }

  const file = `${outDir}${stamp}.json`
  writeFileSync(file, JSON.stringify(results, null, 2))
  const allIssues = results.flatMap((r: any) => (r.turns ?? []).flatMap((t: any) => t.issues.map((i: string) => `${r.scenario} T${t.turn}: ${i}`)))
  console.log(`\n快照已写入 ${file}`)
  console.log(allIssues.length ? `\n自动检出硬伤 ${allIssues.length} 条：\n${allIssues.map(i => '  · ' + i).join('\n')}` : '\n自动检测：无硬伤')
}

main()
