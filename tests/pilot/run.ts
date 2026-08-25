/**
 * Pilot 跑批器 —— 用户机器人对着真实 Agent 跑场景，落盘结构化快照供人工评审。
 *
 * 不进 npm test：会消耗真实 OpenRouter/高德额度。
 * 用法：npx tsx tests/pilot/run.ts [场景id...]
 */
import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs'
import { createStore } from '../../src/core/store'
import { createDesk } from '../../src/cards/desk'
import { createDomainState } from '../../src/state/domain'
import { createPrefs } from '../../src/state/prefs'
import { recentSummary } from '../../src/state/session'
import { sanitize } from '../../src/screen/sanitize'
import { createOrchestrator } from '../../src/cards/orchestrator'
import { createRegistry } from '../../src/tools/registry'
import { createAmapClient } from '../../src/integrations/amap'
import { createPipeline } from '../../src/agent/pipeline'
import { createOpenRouter, createOnlineChat } from '../../src/agent/llm'
import { createItunesClient } from '../../src/integrations/itunes'
import { createStockClient } from '../../src/integrations/qtstock'
import { createHolidayClient } from '../../src/integrations/holiday'
import { createPoemClient } from '../../src/integrations/poem'
import { createPodcastClient } from '../../src/integrations/podcast'
import { createAutomationStore } from '../../src/state/automation'
import { createTravelStore } from '../../src/state/travel'
import { mockSource } from '../../src/integrations/travelMock'
import { fxSource } from '../../src/integrations/travelSources'
import { createOpenMeteoClient } from '../../src/integrations/openmeteo'
import { createFxClient } from '../../src/integrations/frankfurter'
import { createRadioClient } from '../../src/integrations/radio'
import { createNewsClient } from '../../src/integrations/news'
import { createPexelsClient } from '../../src/integrations/pexels'
import { createWebSearch } from '../../src/integrations/websearch'
import { SIGNALS } from '../../src/config/signals'
import { CONSTRAINTS } from '../../src/config/constraints'
import { TOOLS } from '../../src/config/tools'
import { CARD_RULES, DATA_BUILDERS } from '../../src/config/cardRules'
import { MAIN_AGENT } from '../../agents/main-agent/manifest'
import { FAST_AGENT } from '../../agents/main-agent/fast'
import { SKILLS } from '../../agents/main-agent/skills'
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
const NEWS_KEY = process.env.VITE_NEWSAPI_KEY ?? ''
const PEXELS_KEY = process.env.VITE_PEXELS_KEY ?? ''
const AGENT_MODEL = process.env.PILOT_AGENT_MODEL ?? 'minimax/minimax-m3'
// 快层：过滤器小模型。qwen-flash 真实负载 2.5-3.6s 并行调用最准（话术轮已 maxTokens 封顶）
const FAST_MODEL = process.env.PILOT_FAST_MODEL ?? 'qwen/qwen3.7-flash'
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
    if (res.ok) {
      // 偶尔回 200 但 body 是空的，直接 res.json() 会抛 SyntaxError 把整个场景搞挂
      const text = await res.text()
      if (text.trim()) {
        try { return JSON.parse(text).choices?.[0]?.message?.content ?? '' }
        catch { /* 当成空响应重试 */ }
      }
      if (attempt < 4) { await sleep(1000 * (attempt + 1)); continue }
      return ''
    }
    if ((res.status === 429 || res.status >= 500) && attempt < 4) { await sleep(2000 * (attempt + 1)); continue }
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

/**
 * 确定性检测——不靠模型判断，规则见 RUBRIC.md 第 3 维。
 * 分两级：硬伤是"一定错了"，提示是"值得我人工看一眼"。
 * 混在一起报会让真问题被淹掉——比如话术长，多半是用户问了个复杂问题，
 * 模型在老实解释不确定性，那不是缺陷。
 */
function detectIssues(store: any, desk: any, calls: any[], reply: string): string[] {
  const out: string[] = []
  const layout = desk.layout()
  const keys = layout.cards.map((c: any) => c.key)

  for (const c of calls) {
    const code = c.result?.code
    // DESKTOP_FULL 从硬伤名单移除（2026-08-13）：桌面满了不再是失败，是进等位区
    // 排队（status 仍是 ok），CARD_STAGED 是正常告知不是错误
    if (['DATA_SHAPE_MISMATCH', 'SIZE_NOT_SUPPORTED', 'NO_HANDLER', 'HANDLER_ERROR'].includes(code))
      out.push(`Tool ${c.name} 返回 ${code}：${c.result?.message ?? ''}`)
  }
  // 等位区滞留：排太久说明这场景桌面压力大，值得人看一眼排版，不是错误
  if ((layout.staged?.length ?? 0) >= 3)
    out.push(`提示 · 等位区排了 ${layout.staged.length} 张卡（${
      layout.staged.map((c: any) => c.data?.title ?? c.template).join('、')}），桌面压力大`)
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
  // 触控落地（2026-08-12）：屏幕可点选，"点一下也行"不再是硬伤。
  // 但语音是主通道，**催促**用户去点仍然要看一眼——他可能在开车
  if (/必须点|只能点|请点击.*才能/.test(reply))
    out.push(`提示 · 话术在催用户点屏幕（语音才是主通道）：「${reply.slice(0, 40)}」`)
  // 说"你说第几个"就得真有编号可数。实测出现过问是非题却让用户报序号
  if (/第几个|说编号|报个号/.test(reply)
      && !layout.cards.some((c: any) => (c.data?.items?.length ?? c.data?.options?.length ?? 0) >= 2)
      && !((layout.overlay?.data?.items?.length ?? 0) >= 2))
    out.push(`话术让用户"说第几个"，但屏幕上没有可数的编号项：「${reply.slice(0, 40)}」`)
  // 车载产品不该报底层模型身份
  if (/我是\s*(MiniMax|GPT|Claude|Gemini|Qwen|通义|文心|豆包|DeepSeek)/i.test(reply))
    out.push(`话术泄漏底层模型身份：「${reply.slice(0, 40)}」`)
  // 经纬度念出来是噪音
  if (/东经|北纬|\d{2,3}\.\d{4,}/.test(reply))
    out.push(`话术念了坐标数字（语音场景是噪音）：「${reply.slice(0, 40)}」`)
  /**
   * 空壳卡。跑批（nav-cross-province T3）撞出来的：搜服务区返回 0 条，
   * 屏上留着一张「附近的服务区」标题下面什么都没有的卡。
   * 用户看到标题会以为在加载，或者以为真的一个都没有。
   * desk 层已经拦了，这条是防它从别的路径漏回来。
   */
  for (const c of layout.cards) {
    if (['list', 'capability'].includes(c.template) && (c.data?.items?.length ?? 0) === 0)
      out.push(`「${c.data?.title ?? c.template}」是张空壳卡，一条内容都没有`)
  }

  /* ── 生成式卡（2026-08-12 HMI 重设计新增）── */
  for (const c of layout.cards) {
    if (c.template !== 'canvas') continue
    // 消毒后为空 = 模型写的全被剥了。用户看到的是纯文字兜底，
    // 那还不如一开始就用 generic —— 这次 canvas 白开了
    const r = sanitize(String(c.data?.html ?? ''))
    if (r.empty)
      out.push(`生成式卡消毒后为空（剥了 ${r.stripped.join(' ') || '全部'}），等于白开了一张 canvas`)
    else if (r.stripped.length)
      out.push(`提示 · 生成式卡被剥离 ${r.stripped.join(' ')}，模型可能不知道哪些不让写`)
    // text 是必填的纯文字兜底。缺了就等于赌消毒器不会剥空
    if (!String(c.data?.text ?? '').trim())
      out.push('生成式卡没给 text 兜底，消毒剥空时会白屏')
  }
  // 能用 list 表达的内容用了 canvas —— 每次长得不一样，跟"可预测优先"正面冲突
  if (layout.cards.some((c: any) => c.template === 'canvas'
      && !/<(svg|table)\b/i.test(String(c.data?.html ?? ''))))
    out.push('提示 · 生成式卡里既没有图也没有表，这种内容 list/generic 就够了')

  /* ── urgency 滥用（新增）──
     往高了报能让卡活得久，模型有动机这么干。真出安全事件时就没有更高一档了 */
  for (const c of layout.cards) {
    if (c.urgency === 'critical' && c.kind === 'task')
      out.push(`卡片「${c.data?.title ?? c.template}」自报 critical —— 那一档是留给安全事件的`)
  }

  // 语音播报念一百字要二十多秒，人设写的是"一般不超过两句"。
  // 只提示不判死：复杂问题的诚实回答本来就长
  if (reply.length > 100)
    out.push(`提示 · 话术 ${reply.length} 字，语音播报偏长：「${reply.slice(0, 40)}…」`)
  // 屏幕上已经摆出对比列表，话术再把每条的数字念一遍就是重复劳动。
  // 只认 list 模板：车控卡的 items 是四个座位/车窗，那种场景下报数字是在解释边界，不是复述。
  // 即便如此也只提示不判死——屏上是航站楼候选、话术在说电量续航，这种同框不算复述
  if (layout.cards.some((c: any) => c.template === 'list' && (c.data?.items?.length ?? 0) >= 3)
      && (reply.match(/\d+/g) ?? []).length >= 5)
    out.push(`提示 · 屏幕已有列表卡，话术里数字偏多，看看是不是在复述：「${reply.slice(0, 40)}…」`)
  return out
}

async function runScenario(s: Scenario) {
  const store = createStore(SIGNALS, CONSTRAINTS)
  const desk = createDesk()
  const amap = AMAP_KEY ? createAmapClient(fetch as any, { webKey: AMAP_KEY }) : undefined
  const state = createDomainState()
  const prefs = createPrefs()
  const registry = createRegistry(store, TOOLS, Date.now, {
    desk, amap, state, prefs,
    // iTunes 走 JSONP（浏览器 script 标签），Node 里没有 document——
    // 这里用 fetch 直连，它对服务端请求是放行的，只有浏览器才被 CORS 挡
    itunes: createItunesClient(),
    stocks: createStockClient(fetch as any), holiday: createHolidayClient(fetch as any),
    poem: createPoemClient(fetch as any), podcast: createPodcastClient(fetch as any),
    automation: { store: createAutomationStore({ get: () => null, set: () => {} }) },
    // 旅行助手（2026-08-25 pilot 实拍补）：漏接这个仓，模型第二轮建任务
    // 盯价全炸 HANDLER_ERROR——pilot 的装配必须跟 director 一样全
    travel: createTravelStore({ get: () => null, set: () => {} }),
    travelSources: { flight: mockSource(), hotel: mockSource(), fx: fxSource(createFxClient(fetch as any)) },
    travelWeather: async (city: string, days: number) => {
      if (!amap) throw new Error('amap 未配置')
      const g = await amap.geocode(city)
      if (!g?.location) throw new Error('定位不到 ' + city)
      const [lng, lat] = g.location.split(',').map(Number)
      return createOpenMeteoClient(fetch as any).daily(lat, lng, days)
    },
    radio: createRadioClient(fetch as any),
    ...(NEWS_KEY && { news: createNewsClient(fetch as any, () => NEWS_KEY) }),
    ...(PEXELS_KEY && { pexels: createPexelsClient(fetch as any, () => PEXELS_KEY) }),
    websearch: createWebSearch(createOnlineChat(() => OPENROUTER_KEY, () => AGENT_MODEL)),
  })
  createOrchestrator({ store, desk, rules: CARD_RULES, builders: DATA_BUILDERS, deps: { store, amap, state } }).start()

  // 兜底给个车位置。忘了设的场景会用信号默认值（北京），于是"导航去双流机场"
  // 规划出 1800 公里，看起来像产品 bug 其实是场景没写全。场景自己写了就覆盖掉
  const initial = { 'vehicle.location': '104.065861,30.657401', ...s.initial }
  for (const [path, value] of Object.entries(initial)) store.setDirect(path, value as any)

  const llm = createOpenRouter(() => OPENROUTER_KEY, () => AGENT_MODEL)
  const fastLlm = createOpenRouter(() => OPENROUTER_KEY, () => FAST_MODEL)
  // 分层计时：快层第一声何时出——过滤器架构的核心验收指标
  let firstSpeakMs = 0, fastSaid = false, slowSilent = true, turnT0 = 0
  const agent = createPipeline({
    fastEnabled: () => false,   // 2026-08-25 产品决策：主路径全走慢层
    registry, store, fastLlm, slowLlm: llm,
    fastManifest: FAST_AGENT, slowManifest: { ...MAIN_AGENT, skills: SKILLS },
    desktopSummary: () => desk.summary(),
    prefsList: () => prefs.list().map(x => x.text),
    recentSummary: () => recentSummary(state), onTurnStart: () => desk.endTask() })
  agent.on(e => {
    if (e.type === 'speaking') {
      if (!firstSpeakMs) firstSpeakMs = Date.now() - turnT0
      if (e.layer === 'fast') fastSaid = true
      if (e.layer === 'slow') slowSilent = false
    }
  })
  const bot = createUserBot({ chat: botChat })

  const history: Array<{ role: 'user' | 'assistant'; content: string }> = []
  const turns: any[] = []

  for (let i = 1; i <= s.maxTurns; i++) {
    const { say, done } = await bot.next(s.goal, history)
    if (!say.trim()) { console.log(`  [${i}] 用户机器人没话说了，收尾`); break }
    history.push({ role: 'user', content: say })

    const t0 = Date.now()
    turnT0 = t0; firstSpeakMs = 0; fastSaid = false; slowSilent = true
    const r = await agent.run(say)
    /**
     * 调用↔结果按**出现次序**配对（2026-08-25 实拍破案）：以前 find 按 name
     * 配第一个，同名工具连调三次会把三条都显示成第一次的结果——travel.create
     * 第三次明明成功了，快照却显示三连拒，白追了一轮"假 bug"。
     * 快照显示错误比没有快照更糟：它会把评审引向不存在的问题。
     */
    const seen = new Map<string, number>()
    const calls = r.trace.filter(x => x.type === 'toolCall').map((x: any) => {
      const nth = seen.get(x.name) ?? 0
      seen.set(x.name, nth + 1)
      const res = r.trace.filter((y: any) => y.type === 'toolResult' && y.name === x.name)[nth]
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
      // 过滤器架构指标：首声延迟 / 快层是否开口 / 慢层是否静默（速度维度评审用）
      firstSpeakMs, fastSaid, slowSilent,
      issues: [
        ...detectIssues(store, desk, calls, r.reply ?? ''),
        // 用户机器人串戏会污染整场对话，得标出来，不然人工评审会当成产品问题
        ...(soundsLikeAssistant(say) ? [`用户机器人串戏演了助手：「${say.slice(0, 40)}」（这轮结论不可信）`] : []),
      ],
    })

    console.log(`  [${i}] 用户：${say}`)
    console.log(`      Agent：${(r.reply || '(无话术)').slice(0, 80)}`)
    // overlay（full 尺寸的卡，如能力目录）不在 cards 里，漏打会让人误判成"屏幕空的"
    const shown = [
      ...layout.cards.map((c: any) => `${c.data?.title ?? c.template}(${c.size})`),
      ...(layout.overlay ? [`${layout.overlay.data?.title ?? layout.overlay.template}(全屏)`] : []),
    ]
    console.log(`      卡片：${shown.join('、') || '空'}`)
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
  const all = results.flatMap((r: any) => (r.turns ?? []).flatMap((t: any) => t.issues.map((i: string) => `${r.scenario} T${t.turn}: ${i}`)))
  const crashed = results.filter((r: any) => r.error).map((r: any) => `${r.scenario}: 跑挂了 ${r.error}`)
  const hard = [...crashed, ...all.filter((i: string) => !i.includes('提示 · '))]
  const soft = all.filter((i: string) => i.includes('提示 · '))
  console.log(`\n快照已写入 ${file}`)
  console.log(hard.length ? `\n硬伤 ${hard.length} 条：\n${hard.map(i => '  · ' + i).join('\n')}` : '\n自动检测：无硬伤')
  if (soft.length) console.log(`\n值得看一眼 ${soft.length} 条：\n${soft.map(i => '  · ' + i).join('\n')}`)
}

main()
