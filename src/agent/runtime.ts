import type { Store } from '../core/store'
import type { Registry, ToolResult } from '../tools/registry'
import type { LLM, Msg } from './llm'
import type { AgentManifest } from '../../agents/main-agent/manifest'
import { buildSystemPrompt } from './context'

export type TraceStep =
  | { type: 'userInput'; at: number; text: string }
  | { type: 'prompt'; at: number; system: string; toolCount: number }
  | { type: 'toolCall'; at: number; name: string; args: any; permission?: string }
  | { type: 'toolResult'; at: number; name: string; result: ToolResult; ms: number }
  | { type: 'reply'; at: number; text: string }
  | { type: 'error'; at: number; message: string }

export type AgentEvent =
  | { type: 'thinking' }
  | { type: 'executing'; name: string }
  | { type: 'speaking'; text: string }
  | { type: 'confirming'; text: string }
  | { type: 'rejected'; text: string }
  | { type: 'done' }
  | { type: 'error'; message: string }

export interface RunResult {
  reply: string
  trace: TraceStep[]
  rounds: number
  stopReason: 'reply' | 'maxRounds' | 'error'
}

export interface AgentDeps {
  manifest: AgentManifest
  registry: Registry
  store: Store
  llm: LLM
  clock?: () => number
  desktopSummary?: () => string
}

export function createAgent({ manifest, registry, store, llm, clock = Date.now, desktopSummary }: AgentDeps) {
  const listeners: Array<(e: AgentEvent) => void> = []
  const emit = (e: AgentEvent) => listeners.forEach(l => l(e))
  const on = (cb: (e: AgentEvent) => void) => {
    listeners.push(cb)
    return () => listeners.splice(listeners.indexOf(cb), 1)
  }

  /** 会话历史，跨 run 保留以支持多轮承接 */
  let history: Msg[] = []
  const reset = () => { history = [] }

  async function run(userText: string): Promise<RunResult> {
    const trace: TraceStep[] = []
    const t0 = clock()
    trace.push({ type: 'userInput', at: t0, text: userText })
    history.push({ role: 'user', content: userText })

    const tools = registry.schemas('openai', manifest.tools)
    let rounds = 0

    try {
      while (rounds < manifest.maxRounds) {
        rounds++
        const system = buildSystemPrompt(manifest, store, registry, { desktop: desktopSummary?.() })
        trace.push({ type: 'prompt', at: clock(), system, toolCount: tools.length })
        emit({ type: 'thinking' })

        const reply = await llm.chat({ system, messages: history, tools })

        // ── 无工具调用：出话术，结束 ──
        if (!reply.toolCalls?.length) {
          const text = reply.text ?? ''
          history.push({ role: 'assistant', content: text })
          trace.push({ type: 'reply', at: clock(), text })
          emit({ type: 'speaking', text })
          emit({ type: 'done' })
          return { reply: text, trace, rounds, stopReason: 'reply' }
        }

        // ── 有工具调用：并行执行后回填 ──
        history.push({
          role: 'assistant',
          content: reply.text ?? '',
          tool_calls: reply.toolCalls.map(c => ({
            id: c.id, type: 'function' as const,
            function: { name: c.name, arguments: JSON.stringify(c.args) },
          })),
        })

        const results = await Promise.all(reply.toolCalls.map(async c => {
          trace.push({
            type: 'toolCall', at: clock(), name: c.name, args: c.args,
            permission: registry.permissionOf(c.name),
          })
          emit({ type: 'executing', name: c.name })
          const s = clock()
          const result = registry.invoke(c.name, c.args, { allow: manifest.tools })
          trace.push({ type: 'toolResult', at: clock(), name: c.name, result, ms: clock() - s })
          if (result.status === 'inputRequired') emit({ type: 'confirming', text: result.message ?? '需要确认' })
          if (result.status === 'rejected' || result.status === 'unavailable')
            emit({ type: 'rejected', text: result.message ?? '无法执行' })
          return { c, result }
        }))

        for (const { c, result } of results)
          history.push({ role: 'tool', tool_call_id: c.id, content: JSON.stringify(result) })
      }

      emit({ type: 'done' })
      return { reply: '', trace, rounds, stopReason: 'maxRounds' }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      trace.push({ type: 'error', at: clock(), message })
      emit({ type: 'error', message })
      return { reply: '', trace, rounds, stopReason: 'error' }
    }
  }

  return { run, on, reset, manifest, get history() { return history } }
}

export type Agent = ReturnType<typeof createAgent>
