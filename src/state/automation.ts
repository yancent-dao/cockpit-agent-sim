/**
 * 自动化任务的规则仓（设计文档 2026-08-18-automation-design.md）。
 *
 * 规则是**用户数据**——跟 cardRules 同构的声明，不是代码。存 localStorage
 * （域仓同款：可注入 storage，坏数据兜底成空表），刷新/重启后还在——
 * 「后台运行」的地基是持久化。任务码分享 = 这份 JSON 本身。
 */
import type { DomainStorage } from './domain'

/** 条件：信号三元组（复用约束引擎语法）或每天定时（分钟级） */
export type Cond = ['signal', string, string, unknown] | ['time', string]
/** 动作：工具直调（机制执行，零模型）或 prompt 委托（叫醒慢层跑一句） */
export type Action = { tool: string; args?: Record<string, unknown> } | { prompt: string }

export interface AutomationRule {
  id: string
  name: string
  /** 空数组 = 手动任务：不自动触发，点卡片或语音 run */
  when: Cond[]
  do: Action[]
  /** 运行前询问：触发时先出确认卡，点了「执行」才跑 */
  ask?: boolean
  enabled: boolean
  lastRun?: number
}

const KEY = 'cockpit-sim:automations'

export function createAutomationStore(storage: DomainStorage) {
  let rules: AutomationRule[] = []
  try {
    const raw = storage.get(KEY)
    const parsed = raw ? JSON.parse(raw) : []
    if (Array.isArray(parsed)) rules = parsed
  } catch { /* 坏数据兜底成空表 */ }

  const persist = () => { try { storage.set(KEY, JSON.stringify(rules)) } catch { /* 配额满静默 */ } }

  return {
    list: (): AutomationRule[] => rules.map(r => ({ ...r })),
    get: (id: string) => rules.find(r => r.id === id),
    // 防御性拷贝：外部引用不许穿透进仓——共享对象被调用方改一下，
    // 仓里的"事实"就悄悄变了（测试里真踩到：常量夹具被 toggle 改瘫）
    add(r: AutomationRule) { rules.push({ ...r, when: [...r.when], do: [...r.do] }); persist() },
    toggle(id: string, on: boolean) {
      const r = rules.find(x => x.id === id)
      if (r) { r.enabled = on; persist() }
      return r
    },
    remove(id: string) {
      const i = rules.findIndex(x => x.id === id)
      if (i >= 0) { rules.splice(i, 1); persist() }
    },
    markRun(id: string, at: number) {
      const r = rules.find(x => x.id === id)
      if (r) { r.lastRun = at; persist() }
    },
  }
}

export type AutomationStore = ReturnType<typeof createAutomationStore>
