/**
 * Scheduler = run() 的唯一准入入口（R-2，调度与呈现重构方案 §03）。
 *
 * 真实动机：director.ts 里 automation 触发的 `ask()` 调用不打 source 标签
 * （默认落 'voice'），storyChapterDone 甚至绕开 `ask()` 裸调 `pipeline.run()`——
 * 两条路径都能在用户正说着话的时候抢着调 pipeline.run，而 pipeline 每次
 * run() 都会 `++gen` 让上一个还没跑完的 run 立刻变 stale。系统事件因此能
 * 打断一个真实用户的对话，用户会觉得自己的话"突然被吞了"。
 *
 * Scheduler **不改**同优先级之间的 barge-in 语义（用户连着说两句、点两次
 * 屏幕——那是设计好的常态，pipeline 内部的 gen/stale 机制继续管）。
 * 它只管**跨优先级**：语音/点选（真实用户）永远立即执行；系统事件/
 * 自动化永远排队，等所有在跑的用户回合结束才轮到自己。
 */

export type RunFn<T> = (text: string, opts: { answer?: boolean; source?: string }) => Promise<T>

/** 数字越小优先级越高。voice/tap-answer 是用户，不进队列直接跑 */
function priorityOf(opts: { answer?: boolean; source?: string }): number {
  const source = opts.source ?? (opts.answer ? 'tap-answer' : 'voice')
  if (source === 'voice' || source === 'tap-answer') return 1
  if (source.startsWith('system:')) return 2
  return 3   // automation 及其它
}

interface QueueItem {
  priority: number
  seq: number
  task: () => void
}

export function createScheduler<T>(run: RunFn<T>) {
  let activeUserRuns = 0
  let draining = false
  let seq = 0
  const queue: QueueItem[] = []

  function drain() {
    if (draining || activeUserRuns > 0 || !queue.length) return
    draining = true
    // 优先级数字小的先走；同优先级按提交顺序（seq）
    queue.sort((a, b) => a.priority - b.priority || a.seq - b.seq)
    const next = queue.shift()!
    next.task()
  }

  function submit(text: string, opts: { answer?: boolean; source?: string } = {}): Promise<T> {
    const priority = priorityOf(opts)
    if (priority === 1) {
      activeUserRuns++
      return run(text, opts).finally(() => { activeUserRuns--; drain() })
    }
    return new Promise<T>((resolve, reject) => {
      queue.push({
        priority, seq: seq++,
        task: () => {
          run(text, opts).then(resolve, reject).finally(() => { draining = false; drain() })
        },
      })
      drain()
    })
  }

  return { submit }
}
