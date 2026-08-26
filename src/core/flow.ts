/**
 * 长流程状态机（交互总设计 R2，2026-08-19）。
 *
 * 为什么需要它：绘本的 phase 一直只是个"标签"——任何 run 任何时刻都能调
 * 任何 story 工具，于是需要一个个"锁门"补丁（STORY_ENDED、章末闸、关卡收场），
 * 洞是系统性的，堵一个换个面孔再来。这里把契约补上：**机制持有状态，
 * 每个状态只放行白名单内的工具**，其余拒绝并告诉模型当前处在什么状态。
 *
 * 通用件：绘本是第一个用户；自动化 ask 确认、MRTR 确认流是同一形状，
 * 以后迁进来。**只管有物理进度的长流程**（一本书讲到第几章、一个确认
 * 等没等到）——闲聊、车控、查询这些单发交互不进状态机，不然就把
 * 「编排的决策必须在模型」这条核心原则吃掉了。
 */

export interface FlowDecl {
  id: string
  initial: string
  states: Record<string, {
    /** 本状态放行的工具名。声明表之外的工具不归本流程管（一律放行） */
    tools: string[]
    /** 名单内工具在错误状态被调时，给模型看的人话（说清现在处在哪、该干嘛） */
    deny: string
    /**
     * 本状态活跃时随状态注入亮给模型的一行提示（可选）。动机：章法住在技能正文里，
     * 会被记忆压缩折走——铁律（"结束=story.finish"）得有条不经过压缩的通道
     */
    hint?: string
  }>
}

export function createFlow(decl: FlowDecl) {
  let current = decl.initial
  /** 声明表里出现过的全部工具——只有它们归本流程管 */
  const managed = new Set(Object.values(decl.states).flatMap(s => s.tools))

  return {
    get state() { return current },
    /** 转移。未知状态直接抛——声明写错要炸在开发期，不要在运行期静默吞 */
    to(next: string) {
      if (!decl.states[next]) throw new Error(`flow ${decl.id}：没有状态 ${next}`)
      current = next
    },
    /**
     * 这个工具现在能不能调。null = 放行；字符串 = 拒绝理由（给模型的人话）。
     * 不归本流程管的工具一律放行——状态机只管自家流程。
     */
    /** 当前状态的提示行（没声明就空串） */
    hint(): string { return decl.states[current].hint ?? '' },
    allow(tool: string): string | null {
      if (!managed.has(tool)) return null
      return decl.states[current].tools.includes(tool) ? null : decl.states[current].deny
    },
  }
}

export type Flow = ReturnType<typeof createFlow>
