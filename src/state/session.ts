/**
 * 会话摘要 —— 记忆系统的第二级（对模型的注入形态）。
 *
 * **注入的是结论不是原始数据**：历史注入"最近放过：晴天"而不是 50 条记录，
 * 模型要细节走 Tool 查询（media.queue 的 recent）。压缩在这里做，
 * 预算：≤3 行——system prompt 的每个字都在挤别的东西。
 */
import type { DomainState } from './domain'

export function recentSummary(d: DomainState): string {
  const lines: string[] = []
  const played = d.history.recent(3)
  if (played.length)
    lines.push(`最近放过：${played.map(t => t.track).join('、')}`)
  const asked = d.queries.recent(3)
  if (asked.length)
    lines.push(`最近查过：${asked.map(q => `${q.entity}(${q.brief})`).join('；')}`)
  return lines.join('\n')
}
