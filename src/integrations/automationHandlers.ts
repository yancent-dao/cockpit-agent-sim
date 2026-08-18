/**
 * 自动化五工具的 handlers（设计文档 2026-08-18-automation-design.md）。
 *
 * 机制归这里：校验 → 写仓 → 上卡 → 人话回执。动作**执行**在装配层
 * （run 经注入的 execute 回调）——handler 不碰 pipeline，跟引擎不碰
 * registry 是同一条边界。规则内容全是用户说的，这里一个意图都不解析。
 */
import type { Desk } from '../cards/desk'
import type { ToolResult } from '../tools/registry'
import type { AutomationStore, AutomationRule, Cond, Action } from '../state/automation'

export interface AutomationDeps {
  store: AutomationStore
  /** 装配层的执行器：顺序跑一条规则的动作（tool 直调 / prompt 委托）。返回一句结果 */
  execute?: (rule: AutomationRule) => Promise<string>
}

const CARD_KEY = 'automations'

/** 条件的人话摘要（进卡片 sub）——用户要能看懂"它什么时候会动" */
const condText = (c: Cond, labelOf: (p: string) => string): string =>
  c[0] === 'time' ? `每天 ${c[1]}` : `${labelOf(c[1])}${c[2]}${c[3]}`

export function createAutomationHandlers(
  desk: () => Desk | undefined,
  deps: () => AutomationDeps | undefined,
  toolExists: (name: string) => boolean,
  validateArgs: (name: string, args: Record<string, unknown>) => string | null,
  signalLabel: (path: string) => string | undefined,
  clock: () => number,
) {
  /** 卡片 = f(规则仓)。每次增删改跑完都重画，跟编排器"桌面=f(状态)"同一个理 */
  const refreshCard = (a: AutomationStore) => {
    const rules = a.list()
    const d = desk()
    if (!d) return
    if (!rules.length) { const c = d.findByKey(CARD_KEY); if (c) d.dismiss(c.id); return }
    d.render({
      key: CARD_KEY, template: 'automation', kind: 'task', ttl: 'untilDismissed', urgency: 'normal',
      data: {
        title: '自动任务',
        items: rules.map(r => ({
          value: r.id,
          label: `${r.enabled ? '●' : '○'} ${r.name}`,
          sub: r.when.length
            ? r.when.map(c => condText(c, p => signalLabel(p) ?? p)).join(' 且 ') + (r.ask ? ' · 先问我' : '')
            : '手动任务 · 说"运行' + r.name + '"',
        })),
      },
    })
  }

  const need = (): AutomationDeps | ToolResult =>
    deps() ?? { status: 'unavailable', code: 'NO_STORE', message: '自动化没接存储' } as ToolResult

  return {
    automationCreate: (args: any): ToolResult => {
      const dep = need(); if ('status' in dep) return dep
      const name = String(args.name ?? '').trim()
      if (!name) return { status: 'rejected', code: 'INVALID_PARAMS', message: '任务要有个名字' }
      const when: Cond[] = []
      for (const w of args.when ?? []) {
        if (w.kind === 'time') {
          if (!/^\d{2}:\d{2}$/.test(String(w.at)))
            return { status: 'rejected', code: 'INVALID_PARAMS', message: `时间要写成 HH:MM，收到「${w.at}」` }
          when.push(['time', String(w.at)])
        } else {
          if (signalLabel(String(w.path)) === undefined)
            return { status: 'rejected', code: 'INVALID_PARAMS',
              message: `没有 ${w.path} 这个信号`, suggestion: '对照系统提示里的信号名' }
          when.push(['signal', String(w.path), String(w.op ?? '=='), w.value])
        }
      }
      const actions: Action[] = []
      for (const d of args.do ?? []) {
        if (d.prompt) actions.push({ prompt: String(d.prompt) })
        else {
          if (!toolExists(String(d.tool)))
            return { status: 'rejected', code: 'INVALID_PARAMS', message: `没有 ${d.tool} 这个工具` }
          // 动作参数现在就干验证——写进任务的错参是定时哑弹，
          // 触发时才炸远比现在拒掉贵（实拍 climate.set {"on":"true"} 就这么埋进去过）
          const err = validateArgs(String(d.tool), d.args ?? {})
          if (err) return { status: 'rejected', code: 'INVALID_PARAMS',
            message: `「${d.tool}」的参数不对：${err}`, suggestion: '对照工具目录里的参数改一下' }
          actions.push({ tool: String(d.tool), args: d.args ?? {} })
        }
      }
      if (!actions.length) return { status: 'rejected', code: 'INVALID_PARAMS', message: '总得有一个动作' }
      const rule: AutomationRule = {
        id: `au${clock().toString(36)}`, name, when, do: actions,
        ask: !!args.ask, enabled: true,
      }
      dep.store.add(rule)
      refreshCard(dep.store)
      const how = when.length ? '条件满足会自动执行' : '说"运行' + name + '"或点卡片就执行'
      return { status: 'ok', data: { rule },
        message: `建好了：「${name}」，${how}。规则已上屏，不对的话让我改` }
    },

    automationList: (): ToolResult => {
      const dep = need(); if ('status' in dep) return dep
      const rules = dep.store.list()
      refreshCard(dep.store)
      return { status: 'ok', data: { rules },
        message: `现在有 ${rules.length} 条自动任务，已上屏。data 里的 rules 就是任务码，可以整段导出分享` }
    },

    automationToggle: (args: any): ToolResult => {
      const dep = need(); if ('status' in dep) return dep
      const r = find(dep.store, args)
      if (!r) return { status: 'rejected', code: 'NOT_FOUND', message: '没找到这条任务' }
      // 不带 on 就翻转——点卡片那条路只传得了 id
      const on = args.on !== undefined ? !!args.on : !r.enabled
      dep.store.toggle(r.id, on)
      refreshCard(dep.store)
      return { status: 'ok', message: `「${r.name}」${on ? '已启用' : '先停了'}` }
    },

    automationDelete: (args: any): ToolResult => {
      const dep = need(); if ('status' in dep) return dep
      const r = find(dep.store, args)
      if (!r) return { status: 'rejected', code: 'NOT_FOUND', message: '没找到这条任务' }
      dep.store.remove(r.id)
      refreshCard(dep.store)
      return { status: 'ok', message: `「${r.name}」删掉了` }
    },

    automationRun: async (args: any): Promise<ToolResult> => {
      const dep = need(); if ('status' in dep) return dep
      const r = find(dep.store, args)
      if (!r) return { status: 'rejected', code: 'NOT_FOUND', message: '没找到这条任务' }
      if (!dep.execute) return { status: 'unavailable', code: 'NO_EXECUTOR', message: '这环境跑不了任务' }
      const brief = await dep.execute(r)
      dep.store.markRun(r.id, clock())
      return { status: 'ok', message: `「${r.name}」跑完了：${brief}` }
    },
  }
}

const find = (a: AutomationStore, args: any) =>
  a.list().find(r => r.id === args?.id || (args?.name && r.name === args.name))
