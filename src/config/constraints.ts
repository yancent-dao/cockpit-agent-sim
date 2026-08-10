import type { Constraint, Invariant } from '../core/types'

/**
 * 约束与联锁 —— Demo 的戏剧张力来源。
 * message 必须写成人话（会直接进模型上下文），不是日志。
 */
export const CONSTRAINTS: Constraint[] = [
  {
    id: 'SPEED_LIMITED',
    when: ['vehicle.speed', '>', 100],
    target: 'cabin.window.*.position',
    action: 'clamp',
    value: 30,
    message: '当前车速 {vehicle.speed}km/h，车窗最多开到 {value}%',
  },
  {
    id: 'CHILD_LOCK_ON',
    when: ['cabin.childLock', '==', true],
    target: 'cabin.window.rear*.position',
    action: 'reject',
    message: '儿童锁已开启，后排车窗当前不可控制',
    suggestion: '可以先关闭儿童锁，或改开前排车窗',
  },
  {
    id: 'SPEED_TOO_HIGH',
    when: ['vehicle.speed', '>', 5],
    target: 'cabin.door.*.isOpen',
    action: 'reject',
    message: '当前车速 {vehicle.speed}km/h，行驶中无法开启车门',
    suggestion: '停稳后我可以帮你打开',
  },
]

/** 状态不变量：运行时持续校验，违反即在控制面板报警 */
export const INVARIANTS: Invariant[] = [
  {
    id: 'POSITION_IN_RANGE',
    check: get => {
      for (const p of [
        'cabin.window.driver.position',
        'cabin.window.passenger.position',
        'cabin.window.rearLeft.position',
        'cabin.window.rearRight.position',
      ]) {
        const v = get(p) as number
        if (typeof v === 'number' && (v < 0 || v > 100)) return `${p} 越界：${v}`
      }
      return null
    },
  },
  {
    id: 'NO_DOOR_OPEN_WHILE_MOVING',
    check: get => {
      const speed = get('vehicle.speed') as number
      if (speed > 5 && get('cabin.door.driver.isOpen') === true)
        return `行驶中存在开启的车门（speed=${speed}）`
      return null
    },
  },
  {
    id: 'CHILD_LOCK_HOLDS',
    check: get => {
      // 儿童锁生效时后窗不应处于被指令打开的中间态之外的异常值
      const v = get('cabin.window.rearLeft.position') as number
      if (typeof v === 'number' && v < 0) return 'rearLeft 车窗位置异常'
      return null
    },
  },
]
