import { compare } from './types'
import type { Signal, Constraint, Value, SetOutcome, Listener, Invariant } from './types'
import { globMatch } from './glob'
import { INVARIANTS } from '../config/constraints'

interface Cell { sig: Signal; current: Value; target: Value }

export function createStore(
  signals: Signal[],
  constraints: Constraint[],
  invariants: Invariant[] = INVARIANTS,
) {
  const cells = new Map<string, Cell>()
  for (const sig of signals) cells.set(sig.alias, { sig, current: sig.initial, target: sig.initial })

  const listeners: Array<{ pattern: string; cb: Listener }> = []
  const notify = (path: string, value: Value) => {
    for (const l of listeners) if (globMatch(l.pattern, path)) l.cb(path, value)
  }

  const get = (path: string): Value | undefined => cells.get(path)?.current
  const getTarget = (path: string): Value | undefined => cells.get(path)?.target

  /** message 模板插值：{signal.path} 取当前值，{value} 取约束的 value */
  const render = (tpl: string, cVal?: number) =>
    tpl.replace(/\{([^}]+)\}/g, (_, key) =>
      key === 'value' ? String(cVal ?? '') : String(get(key) ?? key))

  /**
   * 纯校验通道：走完 access → range → 约束引擎，但**不写入**。
   * 供批量操作先全量试算，避免部分写入。
   */
  function canSet(path: string, value: Value): SetOutcome {
    const cell = cells.get(path)
    if (!cell) return { status: 'unavailable', code: 'UNKNOWN_SIGNAL', message: `未知信号 ${path}` }

    const { sig } = cell
    if (sig.equipped === false)
      return {
        status: 'unavailable', code: 'NOT_EQUIPPED',
        message: `本车型未配备${sig.label ?? path}`,
      }

    if (sig.access === 'READ')
      return { status: 'rejected', code: 'READ_ONLY', message: `${sig.label ?? path}是只读信号，不能设置` }

    if (sig.type === 'number') {
      const n = value as number
      if (typeof n !== 'number' || Number.isNaN(n))
        return { status: 'rejected', code: 'OUT_OF_RANGE', message: `${sig.label ?? path}需要数值` }
      if (sig.range && (n < sig.range[0] || n > sig.range[1]))
        return {
          status: 'rejected', code: 'OUT_OF_RANGE',
          message: `${sig.label ?? path}取值需在 ${sig.range[0]}~${sig.range[1]} 之间`,
        }
    }
    if (sig.type === 'enum' && sig.values && !sig.values.includes(value as string))
      return { status: 'rejected', code: 'OUT_OF_RANGE', message: `${sig.label ?? path}不支持取值 ${value}` }

    // ── 约束引擎 ──
    let applied = value
    let code: string | undefined
    let message: string | undefined

    for (const c of constraints) {
      if (!globMatch(c.target, path)) continue
      const [wPath, op, wVal] = c.when
      if (!compare(get(wPath), op, wVal)) continue

      if (c.action === 'reject')
        return {
          status: 'rejected', code: c.id,
          message: render(c.message, c.value),
          suggestion: c.suggestion,
        }

      if (c.action === 'clamp' && typeof applied === 'number' && c.value !== undefined) {
        if (applied > c.value) {
          applied = c.value
          code = c.id
          message = render(c.message, c.value)
        }
      }
    }

    return { status: 'ok', applied, changed: [path], ...(code && { code, message }) }
  }

  /** 写入主通道 = 校验 + 提交 */
  function set(path: string, value: Value): SetOutcome {
    const outcome = canSet(path, value)
    if (outcome.status !== 'ok') return outcome

    const cell = cells.get(path)!
    const applied = outcome.applied as Value
    const changedTarget = cell.target !== applied
    cell.target = applied
    if (!cell.sig.transition) cell.current = applied
    if (changedTarget) notify(path, cell.current)
    return outcome
  }

  /**
   * 批量原子写（2026-08-19 实拍）：播放态六连写逐条 set 会把中间态
   * （source 已是 video、streamUrl 还是音乐）泄漏给订阅者——车机屏拿着
   * 音乐 URL 开了视频。**先全验（无部分提交）、再全写、最后才通知**：
   * 订阅者第一个回调里读到的已是完整终态。值没变的键不通知。
   */
  function setMany(entries: Array<[string, Value]>): SetOutcome {
    const outcomes: Array<{ path: string; applied: Value }> = []
    for (const [path, value] of entries) {
      const o = canSet(path, value)
      if (o.status !== 'ok') return o
      outcomes.push({ path, applied: o.applied as Value })
    }
    const dirty: Array<[string, Value]> = []
    for (const { path, applied } of outcomes) {
      const cell = cells.get(path)!
      if (cell.target !== applied) {
        cell.target = applied
        if (!cell.sig.transition) cell.current = applied
        dirty.push([path, cell.current])
      }
    }
    for (const [path, v] of dirty) notify(path, v)
    return { status: 'ok' }
  }

  /** 仿真通道：绕过 access 与约束，供控制面板与场景预设使用 */
  function setDirect(path: string, value: Value) {
    const cell = cells.get(path)
    if (!cell) return
    cell.target = value
    cell.current = value
    notify(path, value)
  }

  function subscribe(pattern: string, cb: Listener) {
    const entry = { pattern, cb }
    listeners.push(entry)
    return () => {
      const i = listeners.indexOf(entry)
      if (i >= 0) listeners.splice(i, 1)
    }
  }

  /** 过渡仿真：匀速逼近 target，可在任意中间态改向且不跳变 */
  function tick(dtMs: number) {
    for (const [path, cell] of cells) {
      const { sig } = cell
      if (!sig.transition || sig.type !== 'number') continue
      const cur = cell.current as number
      const tgt = cell.target as number
      if (cur === tgt) continue
      const span = sig.range ? sig.range[1] - sig.range[0] : 100
      const step = (dtMs / sig.transition) * span
      const next = cur < tgt ? Math.min(cur + step, tgt) : Math.max(cur - step, tgt)
      cell.current = next
      notify(path, next)
    }
  }

  const snapshot = (): Record<string, Value> => {
    const out: Record<string, Value> = {}
    for (const [k, c] of cells) out[k] = c.current
    return out
  }

  const checkInvariants = (): string[] =>
    invariants.map(inv => inv.check(get)).filter((x): x is string => x !== null)

  return { get, getTarget, canSet, set, setMany, setDirect, subscribe, tick, snapshot, checkInvariants, signals }
}

export type Store = ReturnType<typeof createStore>
