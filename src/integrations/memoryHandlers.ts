/**
 * 记忆 Tool 的 handler —— 机制只做存取，**一个 if 都不解析偏好内容**。
 * "以后空调默认 24 度"怎么落实是模型在策略层的事（偏好整包注进 system）。
 */
import type { ToolResult } from '../tools/registry'
import type { Desk } from '../cards/desk'
import type { Prefs } from '../state/prefs'

export function createMemoryHandlers(prefs?: () => Prefs | undefined, desk?: () => Desk | undefined) {
  const need = (): Prefs => {
    const p = prefs?.()
    if (!p) throw new Error('记忆仓未装配')
    return p
  }
  return {
    memoryRemember: (args: any): ToolResult => {
      const text = String(args.text ?? '').trim()
      if (!text) return { status: 'rejected', code: 'INVALID_PARAMS', message: '要记什么得说清楚' }
      const fresh = need().remember(text)
      // 复述确认是必须的：记错了用户当场就能纠正，而不是三天后发现空调一直不对
      return fresh
        ? { status: 'ok', data: { saved: text }, message: `记住了：${text}` }
        : { status: 'ok', data: { already: true }, message: `这条早就记着了：${text}` }
    },
    memoryForget: (args: any): ToolResult => {
      const text = String(args.text ?? '').trim()
      if (!text) return { status: 'rejected', code: 'INVALID_PARAMS', message: '要忘哪条得说清楚' }
      return need().forget(text)
        ? { status: 'ok', data: { forgot: text }, message: '好，这条忘掉了' }
        : { status: 'unavailable', code: 'NOT_FOUND', message: '没有记过这样的内容', suggestion: '用 memory.list 看看记了什么' }
    },
    memoryList: (): ToolResult => {
      const items = need().list()
      if (items.length)
        desk?.()?.render({
          key: 'memory', template: 'list', kind: 'task', ttl: 'untilDismissed',
          data: { title: '我记住的', items: items.map(p => ({ label: p.text })) },
        })
      return {
        status: 'ok', data: { items },
        message: items.length ? `记着 ${items.length} 条，都在屏上` : '现在什么都没记',
      }
    },
  }
}
