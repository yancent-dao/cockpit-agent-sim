import type { Store } from '../core/store'
import type { Registry } from '../tools/registry'
import type { AgentManifest } from '../../agents/main-agent/manifest'

/** 枚举值的中文说法一律来自信号定义的 valueLabels，这里不留硬编码表 */
const cn = (store: Store, alias: string) => {
  const v = store.get(alias)
  return store.signals.find(s => s.alias === alias)?.valueLabels?.[String(v)] ?? v
}

/** 状态裁剪的常驻底：不管挂了什么工具，车速/挡位/电量这类全局事实都得在 */
const CORE_PREFIXES = ['vehicle.', 'powertrain.']

/**
 * 上下文三层化（2026-08-25，Hermes 对照拍板）。原来稳定与易变段拼在同一份
 * system 里靠"稳定在前"保缓存前缀，但车辆状态每秒在变，同一份字符串每轮都不同，
 * provider prompt cache 事实上只能命中到第一段易变内容为止。现在切成两份：
 *
 * - **buildSystemPrompt = 稳定层**：persona/协作段/未配备/目录——会话内不变，
 *   整份 system 逐字稳定，缓存整段命中。
 * - **buildStateNote = 易变层**：车辆状态/桌面/说话人/偏好/议程——以 system 角色
 *   贴在**消息数组末尾**，每轮重拼。它永远是最后一条，前面的消息前缀不被它打破。
 *
 * 注意 stateNote 是**临时拼接**：每轮调用时现拼现贴，不进 thread/view 本体——
 * 进了本体它就成了历史消息，下一轮又贴一条，旧状态会堆着误导模型。
 */
export function buildSystemPrompt(
  manifest: AgentManifest,
  store: Store,
  registry: Registry,
  extras: {
    /** 全走慢层（快层开关关）：协作段不注入——别描述一个不存在的分身 */
    soloSlow?: boolean
    /** 工具目录（brief 行）。慢层常驻，快层用于勾选转交 */
    catalog?: string
    /** 目录段的使用说明。快慢两层的目录用途不同：慢层补载、快层只许勾选 */
    catalogHint?: string
  } = {},
): string {
  const parts: string[] = [manifest.persona]
  // 协作段按快层开关注入（2026-08-25 审计）：快层关闭时这 912 字在描述
  // 一个不存在的"快手分身"——纯死重还可能误导。判据是系统配置状态
  if (manifest.role && !extras.soloSlow) parts.push(manifest.role)
  const want = new Set(manifest.context)

  if (want.has('capabilities')) {
    const missing = store.signals.filter(s => s.equipped === false)
    if (missing.length)
      parts.push(`\n## 本车型未配备（绝对不要假装能操作）\n${missing.map(s => `- ${s.label}`).join('\n')}`)
  }

  if (extras.catalog)
    parts.push(`\n## 工具目录（${extras.catalogHint ?? '一行一能力。schema 不在手边的能力先用 tools.load 点名取，别硬调'}）\n${extras.catalog}`)

  if (manifest.skills?.length)
    parts.push(`\n## 技能目录（有剧本的活先用 skill.use 点名取剧本再动手）\n${
      manifest.skills.map(s => `- ${s.name}：${s.whenToUse}`).join('\n')}`)

  if (want.has('capabilities'))
    parts.push(`\n你当前可用的能力共 ${registry.list(manifest.tools).length} 项。目录之外的能力一律不存在。`)

  return parts.join('\n')
}

/**
 * 易变层（见上）。空态返回空串——没有任何状态可注入时调用方别贴空消息。
 */
export function buildStateNote(
  manifest: AgentManifest,
  store: Store,
  extras: {
    desktop?: string; prefs?: string[]; recent?: string
    /** 状态注入白名单（signalsFor 的输出）。缺省 = 全量（老行为） */
    signalFilter?: string[]
    /** 议程位：模型自己用 agenda.set 记下的跨轮主线 */
    agenda?: string
    /** 长流程活跃提示（flow 声明的 hint）——铁律不经压缩每轮回到眼前 */
    flowHints?: string[]
  } = {},
): string {
  const want = new Set(manifest.context)
  const g = (p: string) => store.get(p)
  const parts: string[] = []

  // 流程提示最先：它是"此刻必须遵守的铁律"，比议程和环境事实都硬
  if (extras.flowHints?.length)
    parts.push(`## 进行中的流程\n${extras.flowHints.map(h => `- ${h}`).join('\n')}`)

  // 议程置顶：它是模型自己留给自己的主线备忘，比环境事实更该先被看到
  if (extras.agenda)
    parts.push(`## 当前议程（你自己记下的跨轮主线：照着推进，每前进一步就 agenda.set 更新，全部做完 agenda.clear）\n${extras.agenda}`)

  // 长期记忆注入：用户明说要记的偏好，整包给策略层。封顶 10 条取最近——
  // 每个字都在挤别的东西
  if (extras.prefs?.length) {
    const shown = extras.prefs.slice(-10)
    parts.push(`## 用户偏好（用户让你记住的，落实靠你）\n${shown.map(t => `- ${t}`).join('\n')}`)
  }
  // 会话摘要：最近放过/查过的**结论**。细节走 Tool，不在这堆原始数据
  if (extras.recent) parts.push(`## 最近\n${extras.recent}`)

  if (want.has('vehicleState')) {
    const filter = extras.signalFilter
    const lines: string[] = []
    for (const sig of store.signals) {
      if (sig.equipped === false) continue
      if (sig.alias.startsWith('perception.') || sig.alias.startsWith('env.')) continue
      // 按工具面裁剪：挂了车窗工具才注入车窗信号；车速/挡位这类核心事实常驻
      if (filter && !filter.includes(sig.alias) && !CORE_PREFIXES.some(p => sig.alias.startsWith(p))) continue
      let v = g(sig.alias)
      if (sig.changeMode === 'CONTINUOUS' && typeof v === 'number') v = Math.round(v)
      if (typeof v === 'number') v = Math.round(v as number)
      if (sig.valueLabels) v = sig.valueLabels[String(v)] ?? v
      lines.push(`- ${sig.label ?? sig.alias}: ${v}${sig.unit ?? ''}  (${sig.alias})`)
    }
    parts.push(`## 当前车辆状态\n${lines.join('\n')}`)
  }

  if (want.has('environment')) {
    parts.push(`## 环境\n- 天气: ${cn(store, 'env.weather')}\n- 车外温度: ${Math.round(g('cabin.temperature.outside') as number)}°C`)
  }

  if (want.has('speaker')) {
    const seat = cn(store, 'perception.voiceSource')
    parts.push(`## 说话人\n当前说话的人坐在 **${seat}**。当他说"开窗""我这边"这类没有指明位置的话时，默认指他自己所在的位置。`)
  }

  if (want.has('desktop') && extras.desktop)
    parts.push(`## 桌面布局（本车无 App，一切都是卡片）\n${extras.desktop}`)

  if (!parts.length) return ''
  return `【实时状态】以下是本轮最新的系统状态，每轮刷新，以这份为准：\n\n${parts.join('\n\n')}`
}
