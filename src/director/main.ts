import { createStore } from '../core/store'
import { createRegistry } from '../tools/registry'
import { createAgent } from '../agent/runtime'
import { createOpenRouter, FALLBACK_MODELS, pickFastModels, type ModelInfo } from '../agent/llm'
import { createBus } from '../bus'
import { createDesk } from '../cards/desk'
import { SIGNALS } from '../config/signals'
import { CONSTRAINTS } from '../config/constraints'
import { TOOLS } from '../config/tools'
import { MAIN_AGENT } from '../../agents/main-agent/manifest'

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T
const POS = ['driver', 'passenger', 'rearLeft', 'rearRight'] as const

/* ══════════ 底层装配 ══════════ */
const store = createStore(SIGNALS, CONSTRAINTS)
const desk = createDesk()
const registry = createRegistry(store, TOOLS, Date.now, { desk })

let apiKey: string = (import.meta as any).env?.VITE_OPENROUTER_KEY || ''
let modelId = ''
const llm = createOpenRouter(() => apiKey, () => modelId)
const agent = createAgent({
  manifest: MAIN_AGENT, registry, store, llm,
  desktopSummary: () => desk.summary(),
})

/* ══════════ 桌面：固定区两张常驻卡（用户配置的） ══════════ */
const WIN_LABEL: Record<string, string> = { driver: '主驾', passenger: '副驾', rearLeft: '左后', rearRight: '右后' }
const winItems = () => POS.map(k => ({
  key: k, label: WIN_LABEL[k], unit: '%',
  value: store.getTarget(`cabin.window.${k}.position`) as number,
}))

const seedDesk = () => {
  const w = desk.render({ key: 'windows', template: 'control', size: '1/6',
    ttl: 'persistent', kind: 'persistent', data: { title: '车窗', items: winItems() } })
  desk.pin(w.cardId!)
  const v = desk.show({ key: 'vehicle', template: 'vehicle', size: '1/6',
    ttl: 'persistent', kind: 'persistent', data: { title: '车辆' } })
  desk.pin(v.cardId!)
  const i = desk.show({ key: 'info', template: 'info', size: '1/6',
    ttl: 'persistent', kind: 'persistent', data: { title: '车况', text: '一切正常' } })
  desk.pin(i.cardId!)
}
seedDesk()

const brief = (c: any) => ({ id: c.id, template: c.template, size: c.size, kind: c.kind,
  title: c.data?.title ?? c.template, data: c.data })
function pushDesk() {
  const l = desk.layout()
  bus.send({ type: 'cards', desk: {
    agent: l.agent.map(brief), fixed: l.fixed.map(brief),
    overlay: l.overlay ? brief(l.overlay) : undefined, agentFree: l.agentFree,
  } } as any)
}
desk.subscribe(pushDesk)
setInterval(() => desk.tick(), 500)

/**
 * 四级反馈由 state.changed 自动驱动，Agent 不需要为基础反馈额外调 Tool。
 * 规则：优先复用桌面上已有的卡 → 其次放大 → 最后才新建。
 */
store.subscribe('cabin.window.*.position', () => {
  const r = desk.render({
    key: 'windows', template: 'control', size: '1/6', ttl: 30, kind: 'task',
    data: { title: '车窗', items: winItems() },
  })
  if (r.level && r.level !== lastLevel) {
    lastLevel = r.level
    const how = { L1: 'L1 复用桌面已有卡片，不新建', L2: 'L2 放大已有卡片', L3: 'L3 新建卡片' }[r.level]
    log('p', `  ▪ 反馈 ${how}`)
  }
  if (r.note) log('r', '  ▪ ' + r.note)
})
let lastLevel = ''

$('toolCount').textContent = `${registry.list(MAIN_AGENT.tools).length} tools`

/* ══════════ 跨窗口 ══════════ */
const bus = createBus(m => { if (m.type === 'hello') setConn(true) })
const setConn = (ok: boolean) => {
  $('dot').classList.toggle('on', ok)
  $('connTxt').textContent = ok ? '车机屏已连接' : '车机屏未连接'
}
$('openScreen').onclick = () => {
  const w = open(new URL('screen.html', location.href).href, 'cockpitScreen', 'width=1440,height=880')
  bus.setPeer(w)
  log('p', '已打开车机屏 · 拖到外接屏后按 F 全屏')
}

function push() {
  const target: Record<string, number> = {}
  for (const k of POS) target[k] = store.getTarget(`cabin.window.${k}.position`) as number
  bus.send({
    type: 'state', target,
    meta: {
      speed: store.get('vehicle.speed'), childLock: store.get('cabin.childLock'),
      weather: store.get('env.weather'), outTemp: store.get('cabin.temperature.outside'),
      soc: store.get('powertrain.soc'),
    },
  })
  for (const k of POS) $(`m-${k}`).textContent = String(Math.round(store.getTarget(`cabin.window.${k}.position`) as number))
  const v = store.checkInvariants()
  $('invar').innerHTML = v.length
    ? `<span style="color:#FF5C5C">⚠ 不变量违规：${v.join('；')}</span>`
    : '状态不变量：正常'
}
setInterval(() => { store.tick(200); push() }, 200)
pushDesk()

/* ══════════ 追踪面板 ══════════ */
const traceEl = $('trace')
function log(cls: string, text: string) {
  const div = document.createElement('div')
  div.className = cls; div.textContent = text
  traceEl.appendChild(div); traceEl.scrollTop = traceEl.scrollHeight
}
$('clr').onclick = () => (traceEl.innerHTML = '')
$('resetSess').onclick = () => { agent.reset(); log('p', '── 会话已重置 ──') }

/* ══════════ Agent 事件 → 车机屏 ══════════ */
agent.on(e => {
  switch (e.type) {
    case 'thinking':
      bus.send({ type: 'voice', s: 'thinking', text: null }); break
    case 'executing':
      bus.send({ type: 'voice', s: 'executing' }); break
    case 'speaking':
      bus.send({ type: 'voice', s: 'speaking', text: e.text, who: 'agent' }); break
    case 'confirming':
      bus.send({ type: 'voice', s: 'confirming', text: e.text, who: 'agent' })
      bus.send({ type: 'card', action: 'show', id: 'confirm', title: '需要确认', body: e.text })
      break
    case 'rejected':
      bus.send({ type: 'voice', s: 'rejected' })
      bus.send({ type: 'reject', on: true, title: '已拒绝执行', desc: e.text })
      break
    case 'done':
      setTimeout(() => bus.send({ type: 'voice', s: 'idle', text: '' }), 3000); break
    case 'error':
      log('e', '✗ ' + e.message)
      bus.send({ type: 'voice', s: 'rejected', text: '出错了：' + e.message, who: 'agent' })
      break
  }
})

/* ══════════ 发起一轮对话 ══════════ */
let busy = false
async function ask(text: string) {
  if (busy) return
  if (!apiKey) { log('e', '✗ 请先填入 OpenRouter API Key'); return }
  if (!modelId) { log('e', '✗ 请先选择模型'); return }
  busy = true; $('busy').textContent = '思考中…'
  bus.send({ type: 'reject', on: false })
  bus.send({ type: 'card', action: 'dismiss', id: 'confirm' })
  bus.send({ type: 'voice', s: 'listening', text, who: 'user' })
  log('u', `\n▸ ${text}`)

  const t0 = performance.now()
  const r = await agent.run(text)

  for (const s of r.trace) {
    if (s.type === 'prompt') log('p', `  · 注入 ${s.system.length} 字符 / ${s.toolCount} 个工具`)
    if (s.type === 'toolCall') log('t', `  → ${s.name}(${JSON.stringify(s.args)})  [${s.permission}]`)
    if (s.type === 'toolResult') {
      const res: any = s.result
      const cls = res.status === 'ok' ? 'k' : res.status === 'inputRequired' ? 'r' : res.status === 'failed' ? 'e' : 'r'
      log(cls, `  ← ${res.status}${res.code ? ' · ' + res.code : ''}${res.message ? ' · ' + res.message : ''}  (${s.ms}ms)`)
      if (res.status === 'ok' && res.changed?.length) {
        const ids = res.changed
          .filter((p: string) => p.startsWith('cabin.window.'))
          .map((p: string) => p.split('.')[2])
        if (ids.length) bus.send({ type: 'highlight', ids })
        if (res.code === 'SPEED_LIMITED') bus.send({ type: 'reject', on: true, title: '已限位', desc: `${res.message} · <code>${res.code}</code>` })
        const cid = (res.data as any)?.cardId
        if (cid) bus.send({ type: 'highlight', ids: [], cards: [cid] } as any)
      }
    }
  }
  log('a', `  ⟵ ${r.reply || '(无话术)'}`)
  log('p', `  ${r.rounds} 轮 · ${Math.round(performance.now() - t0)}ms · ${r.stopReason}`)
  push()
  busy = false; $('busy').textContent = ''
}

$('send').onclick = () => { const v = $<HTMLInputElement>('say').value.trim(); if (v) { $<HTMLInputElement>('say').value = ''; ask(v) } }
$<HTMLInputElement>('say').onkeydown = e => { if (e.key === 'Enter') $('send').click() }

/* ══════════ Golden Case ══════════ */
const CASES = [
  { n: 1, g: 1, t: '打开主驾车窗', m: '基础链路 State→Tool→UI' },
  { n: 2, g: 1, t: '开一半', m: '参数化 + 多轮承接（承接上一条）' },
  { n: 3, g: 1, t: '把窗户都关了', m: 'all 枚举 + 并行调用' },
  { n: 4, g: 2, t: '开个窗', m: '说话人指代消解（先把说话人切到左后）', pre: () => setSrc('rearLeft') },
  { n: 5, g: 2, t: '算了关上', m: '中间态打断反向（趁动画未完成时点）' },
  { n: 6, g: 2, t: '开窗', m: '情境注入（先切雨天，看模型会不会先问）', pre: () => setRain(true) },
  { n: 7, g: 3, t: '窗户开到底', m: '约束引擎 SPEED_LIMITED', pre: () => setSpeed(120) },
  { n: 8, g: 3, t: '把后窗打开', m: '拒绝契约 CHILD_LOCK_ON', pre: () => setLock(true) },
  { n: 9, g: 3, t: '开一下天窗', m: 'NOT_EQUIPPED · 反幻觉必测' },
  { n: 10, g: 4, t: '开窗', m: '桌面已有车窗卡 → 走 L1 复用，不新建',
    pre: () => { if (!desk.findByKey('windows')) seedWindowCard() } },
  { n: 11, g: 4, t: '开窗', m: '桌面无车窗卡 → 走 L3 新建，ttl 到期自动消失',
    pre: () => { const c = desk.findByKey('windows'); if (c) { desk.unpin(c.id); desk.dismiss(c.id) } } },
  { n: 12, g: 4, t: '帮我找个充电桩，再放首歌', m: 'Agent 区满载 → 降尺寸/挤出并告知用户',
    pre: () => fillAgentZone() },
  { n: 13, g: 4, t: '（模拟来电）', m: '系统卡抢占，任务卡让位', pre: () => incomingCall(), noAsk: true },
]
for (const g of [1, 2, 3, 4]) {
  $(`g${g}`).innerHTML = CASES.filter(c => c.g === g).map(c =>
    `<button class="case" data-c="${c.n}"><span class="no">${c.n}</span>
      <span><b>${c.t}</b><span class="m">${c.m}</span></span></button>`).join('')
}
document.querySelectorAll('[data-c]').forEach(b => (b as HTMLElement).onclick = () => {
  const c: any = CASES.find(x => x.n === Number((b as HTMLElement).dataset.c))!
  c.pre?.()
  if (!c.noAsk) ask(c.t)
})

function seedWindowCard() {
  const w = desk.render({ key: 'windows', template: 'control', size: '1/6',
    ttl: 'persistent', kind: 'persistent', data: { title: '车窗', items: winItems() } })
  desk.pin(w.cardId!)
}
function fillAgentZone() {
  desk.show({ template: 'list', size: '1/2', ttl: 60, data: { title: '附近餐厅', items: [{ label: '示例结果' }] } })
  log('p', 'Agent 区已被一张 1/2 卡占满，下一张卡会触发降尺寸')
}
function incomingCall() {
  const r = desk.show({ template: 'notice', size: '1/3', ttl: 20, kind: 'system',
    data: { title: '来电', text: '张伟 · 手机', suggestion: '接听 / 挂断' } })
  log('r', `系统卡抢占 → ${r.status}${r.note ? ' · ' + r.note : ''}`)
}

/* ══════════ 车辆状态控件 ══════════ */
const setSpeed = (v: number) => { store.setDirect('vehicle.speed', v); $<HTMLInputElement>('spd').value = String(v); $('spdV').textContent = `${v} km/h`; push() }
const setSrc = (v: string) => { store.setDirect('perception.voiceSource', v); $<HTMLSelectElement>('vsrc').value = v }
const setLock = (v: boolean) => { store.setDirect('cabin.childLock', v); const b = $('bLock'); b.textContent = '儿童锁 ' + (v ? '开' : '关'); b.classList.toggle('on', v); push() }
const setRain = (v: boolean) => { store.setDirect('env.weather', v ? 'rain' : 'cloudy'); const b = $('bRain'); b.textContent = '天气 ' + (v ? '小雨' : '多云'); b.classList.toggle('on', v); push() }

$<HTMLInputElement>('spd').oninput = e => setSpeed(Number((e.target as HTMLInputElement).value))
$<HTMLInputElement>('tmp').oninput = e => { const v = Number((e.target as HTMLInputElement).value); store.setDirect('cabin.temperature.outside', v); $('tmpV').textContent = `${v} °C`; push() }
$<HTMLInputElement>('soc').oninput = e => { const v = Number((e.target as HTMLInputElement).value); store.setDirect('powertrain.soc', v); $('socV').textContent = `${v} %`; push() }
$<HTMLSelectElement>('vsrc').onchange = e => setSrc((e.target as HTMLSelectElement).value)
$('bLock').onclick = () => setLock(!store.get('cabin.childLock'))
$('bRain').onclick = () => setRain(store.get('env.weather') !== 'rain')

const SCENES: Record<string, () => void> = {
  park: () => { setSpeed(0); setRain(false); setLock(false) },
  highway: () => { setSpeed(120); setRain(false); setLock(false) },
  rain: () => { setSpeed(45); setRain(true); setLock(false) },
  kids: () => { setSpeed(30); setRain(false); setLock(true) },
}
document.querySelectorAll('[data-sc]').forEach(b => (b as HTMLElement).onclick = () => {
  SCENES[(b as HTMLElement).dataset.sc!]()
  log('p', `场景切换 → ${(b as HTMLElement).textContent}`)
})

/* ══════════ 模型选择 ══════════ */
let allModels: ModelInfo[] = []
let fastOnly = true

function renderModels() {
  const list = fastOnly
    ? pickFastModels(allModels)
    : allModels.slice().sort((a, b) => (a.promptPrice ?? 0) - (b.promptPrice ?? 0))
  const sel = $<HTMLSelectElement>('model')
  sel.innerHTML = list.map(m =>
    `<option value="${m.id}">${m.name}${m.promptPrice ? `　·　$${(m.promptPrice * 1e6).toFixed(2)}/M` : ''}</option>`).join('')
  $('modelCount').textContent = `${list.length} / ${allModels.length}`
  if (list.length) { modelId = list[0].id; sel.value = modelId }
}
$<HTMLSelectElement>('model').onchange = e => { modelId = (e.target as HTMLSelectElement).value; log('p', `模型切换 → ${modelId}`) }
$('fastOnly').onclick = () => { fastOnly = !fastOnly; $('fastOnly').classList.toggle('on', fastOnly); renderModels() }

async function loadModels() {
  if (!apiKey) { allModels = FALLBACK_MODELS; renderModels(); return }
  try {
    allModels = await llm.models()
    log('k', `✓ 已加载 ${allModels.length} 个支持 function calling 的模型`)
  } catch (err) {
    allModels = FALLBACK_MODELS
    log('e', `✗ 模型列表拉取失败，使用兜底列表：${err}`)
  }
  renderModels()
}
$('reload').onclick = loadModels
$<HTMLInputElement>('key').oninput = e => { apiKey = (e.target as HTMLInputElement).value.trim() }
$<HTMLInputElement>('key').onchange = loadModels

if (apiKey) { $<HTMLInputElement>('key').value = apiKey }
loadModels()
push()
log('p', '控制面板就绪 · 先「打开车机屏」，选好模型后即可对话')
