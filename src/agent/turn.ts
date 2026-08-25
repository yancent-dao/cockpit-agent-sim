/**
 * Turn = 一个 run() 回合的状态壳（R-1，调度与呈现重构方案 §02）。
 *
 * 从 pipeline.ts 的模块级 let 里搬出来的第一批：撞墙检测（同一失败签名连续
 * 几次）与打转熔断（lane 上一轮 ok 过的签名）。以前这两块是模块级共享，
 * subRun 的后台工具调用跟主 turn 共用同一份状态——子 Agent 撞墙会污染主
 * turn 的撞墙计数、子 Agent 的 REPEAT_CALL 表也会跟主 turn 混在一起。
 * 每次 run()/subRun() 各建一份 Turn，天然隔离，不用额外加判断去撇清。
 */

/** 同一失败签名连续几次算撞墙。3 次足够模型试完"改参数名/改嵌套/改类型"三种自纠 */
const WALL_LIMIT = 3

export interface Turn {
  /** 记一次 execRound 的失败签名（空串=本轮全 ok）。metaOnly 轮不清洗计数 */
  noteFailSig(sig: string, metaOnly: boolean): void
  hitWall(): boolean
  /** lane 上一轮是否已经成功调过这个签名（REPEAT_CALL 判据） */
  wasJustOk(lane: string, sig: string): boolean
  /** 记录 lane 本轮 ok/被 REPEAT_CALL 拦下的签名，覆盖上一轮记录 */
  recordLane(lane: string, sigs: string[]): void
  /** 本 turn 有 mic 工具成功出过声（voice.speak/ask ok）。空收场兜底的免罪牌 */
  markSpoke(): void
  spoke(): boolean
}

export function createTurn(): Turn {
  let lastFailSig = ''
  let failStreak = 0
  const prevOk = new Map<string, Set<string>>()

  let micSpoke = false

  return {
    markSpoke() { micSpoke = true },
    spoke() { return micSpoke },
    noteFailSig(sig, metaOnly) {
      if (sig && sig === lastFailSig) failStreak++
      else if (!metaOnly) { lastFailSig = sig; failStreak = sig ? 1 : 0 }
    },
    hitWall() { return failStreak >= WALL_LIMIT },
    wasJustOk(lane, sig) { return prevOk.get(lane)?.has(sig) ?? false },
    recordLane(lane, sigs) { prevOk.set(lane, new Set(sigs)) },
  }
}
