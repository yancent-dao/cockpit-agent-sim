/** 对齐 AAOS VehiclePropertyIds 的元数据三元组 */
export type Access = 'READ' | 'WRITE' | 'READ_WRITE'
export type ChangeMode = 'STATIC' | 'ONCHANGE' | 'CONTINUOUS'
/** 对齐行业「黑/灰/彩」车控权限分级 */
export type Permission = '黑' | '灰' | '彩'

export type Value = number | boolean | string

export interface Signal {
  /** 内部短别名，用于 Prompt 注入（Token 效率） */
  alias: string
  /** COVESA VSS v6.0 路径 —— 必填，构建期校验 */
  vssPath: string
  type: 'number' | 'boolean' | 'enum'
  range?: [number, number]
  values?: string[]
  access: Access
  changeMode: ChangeMode
  permission?: Permission
  /** 全行程耗时(ms)。有此字段即自动获得过渡仿真 */
  transition?: number
  initial: Value
  /** 该车型是否选装，false → NOT_EQUIPPED */
  equipped?: boolean
  label?: string
  unit?: string
}

export type Op = '>' | '<' | '>=' | '<=' | '==' | '!='

/**
 * 约束表达式故意限定为三元组，不支持嵌套逻辑。
 * 覆盖约 90% 场景；剩余场景写具名谓词并登记白名单，绝不引入 eval 或表达式引擎。
 */
export interface Constraint {
  id: string
  when: [string, Op, Value]
  /** 作用目标，支持段内通配：cabin.window.rear*.position */
  target: string
  action: 'clamp' | 'reject'
  value?: number
  /** 人话，会直接进模型上下文。支持 {signal.path} 与 {value} 插值 */
  message: string
  suggestion?: string
}

/** 单一结构而非判别联合：这个对象要跨 JSON 边界进模型上下文，扁平更好用 */
export interface SetOutcome {
  status: 'ok' | 'rejected' | 'unavailable'
  applied?: Value
  changed?: string[]
  code?: string
  message?: string
  suggestion?: string
}

export type Listener = (path: string, value: Value) => void
export type Invariant = { id: string; check: (get: (p: string) => Value | undefined) => string | null }
