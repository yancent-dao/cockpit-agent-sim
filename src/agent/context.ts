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
 * 上下文注入。
 * 分段顺序即缓存策略（设计文档 §8）：**稳定前缀在前**（persona/协作段/目录/未配备——
 * 会话内不变，provider prompt cache 能命中），**易变内容在后**（车辆状态每秒在变，
 * 放前面会把整条缓存前缀冲掉）。
 */
export function buildSystemPrompt(
  manifest: AgentManifest,
  store: Store,
  registry: Registry,
  extras: {
    desktop?: string; prefs?: string[]; recent?: string
    /** 工具目录（brief 行）。慢层常驻，快层用于勾选转交 */
    catalog?: string
    /** 状态注入白名单（signalsFor 的输出）。缺省 = 全量（老行为） */
    signalFilter?: string[]
  } = {},
): string {
  /* ── 稳定前缀 ── */
  const parts: string[] = [manifest.persona]
  if (manifest.role) parts.push(manifest.role)
  const want = new Set(manifest.context)
  const g = (p: string) => store.get(p)

  if (want.has('capabilities')) {
    const missing = store.signals.filter(s => s.equipped === false)
    if (missing.length)
      parts.push(`\n## 本车型未配备（绝对不要假装能操作）\n${missing.map(s => `- ${s.label}`).join('\n')}`)
  }

  if (extras.catalog)
    parts.push(`\n## 工具目录（一行一能力。schema 不在手边的能力先用 tools.load 点名取，别硬调）\n${extras.catalog}`)

  /* ── 易变尾部 ── */
  // 长期记忆注入：用户明说要记的偏好，整包给策略层。封顶 10 条取最近——
  // system 的每个字都在挤别的东西
  if (extras.prefs?.length) {
    const shown = extras.prefs.slice(-10)
    parts.push(`\n## 用户偏好（用户让你记住的，落实靠你）\n${shown.map(t => `- ${t}`).join('\n')}`)
  }
  // 会话摘要：最近放过/查过的**结论**。细节走 Tool，不在这堆原始数据
  if (extras.recent) parts.push(`\n## 最近\n${extras.recent}`)

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
    parts.push(`\n## 当前车辆状态\n${lines.join('\n')}`)
  }

  if (want.has('environment')) {
    parts.push(`\n## 环境\n- 天气: ${cn(store, 'env.weather')}\n- 车外温度: ${Math.round(g('cabin.temperature.outside') as number)}°C`)
  }

  if (want.has('speaker')) {
    const seat = cn(store, 'perception.voiceSource')
    parts.push(`\n## 说话人\n当前说话的人坐在 **${seat}**。当他说"开窗""我这边"这类没有指明位置的话时，默认指他自己所在的位置。`)
  }

  if (want.has('capabilities'))
    parts.push(`\n你当前可用的能力共 ${registry.list(manifest.tools).length} 项。目录之外的能力一律不存在。`)

  if (want.has('desktop') && extras.desktop)
    parts.push(`\n## 桌面布局（本车无 App，一切都是卡片）\n${extras.desktop}`)

  return parts.join('\n')
}
