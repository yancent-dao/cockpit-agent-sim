import type { Store } from '../core/store'
import type { Registry } from '../tools/registry'
import type { AgentManifest } from '../../agents/main-agent/manifest'

const SEAT_CN: Record<string, string> = {
  driver: '主驾', passenger: '副驾', rearLeft: '左后', rearRight: '右后',
}
const WEATHER_CN: Record<string, string> = {
  clear: '晴', cloudy: '多云', rain: '小雨', heavyRain: '大雨', snow: '雪', fog: '雾',
}
const GEAR_CN: Record<string, string> = { p: 'P', r: 'R', n: 'N', d: 'D' }

/**
 * 上下文注入。
 * 按 ChangeMode 裁剪：CONTINUOUS 取整给摘要，避免无意义精度占 Token。
 */
export function buildSystemPrompt(
  manifest: AgentManifest,
  store: Store,
  registry: Registry,
  extras: { desktop?: string } = {},
): string {
  const parts: string[] = [manifest.persona]
  const want = new Set(manifest.context)
  const g = (p: string) => store.get(p)

  if (want.has('vehicleState')) {
    const lines: string[] = []
    for (const sig of store.signals) {
      if (sig.equipped === false) continue
      if (sig.alias.startsWith('perception.') || sig.alias.startsWith('env.')) continue
      let v = g(sig.alias)
      if (sig.changeMode === 'CONTINUOUS' && typeof v === 'number') v = Math.round(v)
      if (typeof v === 'number') v = Math.round(v as number)
      if (sig.alias === 'vehicle.gear') v = GEAR_CN[v as string] ?? v
      lines.push(`- ${sig.label ?? sig.alias}: ${v}${sig.unit ?? ''}  (${sig.alias})`)
    }
    parts.push(`\n## 当前车辆状态\n${lines.join('\n')}`)
  }

  if (want.has('environment')) {
    const w = WEATHER_CN[g('env.weather') as string] ?? g('env.weather')
    parts.push(`\n## 环境\n- 天气: ${w}\n- 车外温度: ${Math.round(g('cabin.temperature.outside') as number)}°C`)
  }

  if (want.has('speaker')) {
    const seat = SEAT_CN[g('perception.voiceSource') as string] ?? '主驾'
    parts.push(`\n## 说话人\n当前说话的人坐在 **${seat}**。当他说"开窗""我这边"这类没有指明位置的话时，默认指他自己所在的位置。`)
  }

  if (want.has('capabilities')) {
    const missing = store.signals.filter(s => s.equipped === false)
    if (missing.length)
      parts.push(`\n## 本车型未配备（绝对不要假装能操作）\n${missing.map(s => `- ${s.label}`).join('\n')}`)
    parts.push(`\n你当前可用的能力共 ${registry.list(manifest.tools).length} 项，均已在工具列表中给出。列表之外的能力一律不存在。`)
  }

  if (want.has('desktop') && extras.desktop)
    parts.push(`\n## 桌面布局（本车无 App，一切都是卡片）\n${extras.desktop}`)

  return parts.join('\n')
}
