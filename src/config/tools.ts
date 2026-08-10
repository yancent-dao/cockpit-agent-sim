import type { Permission, Op, Value } from '../core/types'
import { TEMPLATE_IDS } from './cards'

export interface ParamDef {
  type: 'number' | 'string' | 'boolean' | 'enum' | 'array' | 'object'
  values?: string[]
  range?: [number, number]
  items?: 'string'
  required?: boolean
  desc: string
}

export interface ToolDef {
  name: string
  desc: string
  permission: Permission
  params: Record<string, ParamDef>
  /** 声明式写入：有此字段即自动生成 handler，无需一行代码 */
  writes?: { path: string; from: string; map?: Record<string, Value> }
  /** 参数展开：window=all → 四扇窗 */
  expand?: Record<string, Record<string, string[]>>
  /** 动态权限升级：命中条件时提升等级 */
  escalate?: Array<{ when: [string, Op, Value]; to: Permission }>
  /** 需二次确认时向用户播报的问句 */
  confirmPrompt?: string
  /** 有真实逻辑的 Tool 用具名 handler，登记在 handlers/ 白名单 */
  handler?: string
}

/**
 * v0.1 Tool 集。44 个中的第一批。
 * 约 60% 是零 handler 代码的 —— 靠 writes 声明自动生成。
 */
export const TOOLS: ToolDef[] = [
  /* ── 读取 ── */
  {
    name: 'vehicle.getState',
    desc: '读取车辆当前状态。不传参返回全部状态；传 paths 只读取指定信号。',
    permission: '彩',
    params: {
      paths: { type: 'array', items: 'string', desc: '要读取的信号路径列表，如 ["vehicle.speed"]' },
    },
    handler: 'getState',
  },

  /* ── 车窗（零 handler） ── */
  {
    name: 'window.set',
    desc: '控制车窗开度。position 为百分比，0 表示完全关闭，100 表示完全打开。window 传 all 可一次控制四扇窗。',
    permission: '彩',
    params: {
      window: {
        type: 'enum', values: ['driver', 'passenger', 'rearLeft', 'rearRight', 'all'],
        required: true, desc: '目标车窗：driver 主驾 / passenger 副驾 / rearLeft 左后 / rearRight 右后 / all 全部',
      },
      position: { type: 'number', range: [0, 100], required: true, desc: '开度百分比 0-100' },
    },
    writes: { path: 'cabin.window.{window}.position', from: 'position' },
    expand: { window: { all: ['driver', 'passenger', 'rearLeft', 'rearRight'] } },
    escalate: [{ when: ['vehicle.speed', '>', 5], to: '灰' }],
    confirmPrompt: '车辆正在行驶，确认要调整车窗吗？',
  },

  /* ── 天窗：未选装，用于反幻觉验证 ── */
  {
    name: 'sunroof.set',
    desc: '控制全景天窗开度。',
    permission: '彩',
    params: { position: { type: 'number', range: [0, 100], required: true, desc: '开度百分比 0-100' } },
    writes: { path: 'cabin.sunroof.glass.position', from: 'position' },
  },

  /* ── 车门：灰级，需二次确认 ── */
  {
    name: 'door.set',
    desc: '开关车门。open 打开，close 关闭。',
    permission: '灰',
    params: {
      door: { type: 'enum', values: ['driver'], required: true, desc: '目标车门' },
      action: { type: 'enum', values: ['open', 'close'], required: true, desc: '动作' },
    },
    writes: { path: 'cabin.door.{door}.isOpen', from: 'action', map: { open: true, close: false } },
    confirmPrompt: '即将打开车门，确认吗？',
  },

  /* ── 儿童锁 ── */
  {
    name: 'childLock.set',
    desc: '开关后排儿童锁。开启后后排车窗与车门将无法控制。',
    permission: '彩',
    params: { enabled: { type: 'boolean', required: true, desc: '是否开启' } },
    writes: { path: 'cabin.childLock', from: 'enabled' },
  },

  /* ── 语音 ── */
  {
    name: 'voice.speak',
    desc: '通过车内音响向用户播报一段话。用于解释、确认、反馈。',
    permission: '彩',
    params: {
      text: { type: 'string', required: true, desc: '要播报的内容，口语化、简短' },
      tone: { type: 'enum', values: ['neutral', 'warm', 'urgent'], desc: '语气' },
    },
    handler: 'speak',
  },

  /* ── 卡片调度（无APP化核心） ── */
  {
    name: 'card.show',
    desc: '在桌面 Agent 区新建一张卡片。先用 desktop.getLayout 看桌面上有没有现成的卡可以复用——已有就用 card.update，尺寸不够就用 card.resize，都不行才新建。',
    permission: '彩',
    params: {
      template: { type: 'enum', values: TEMPLATE_IDS, required: true, desc: '卡片模板' },
      size: { type: 'enum', values: ['1/6', '1/3', '1/2', 'full'], required: true, desc: '尺寸：1/6 单格 / 1/3 两格 / 1/2 整行 / full 全屏（临时征用，关闭后自动还原）' },
      ttl: { type: 'string', required: true, desc: '生命周期：persistent 常驻 / untilDismissed 直到关闭 / untilTaskEnd 本轮任务结束即退 / 数字表示秒数' },
      key: { type: 'string', desc: '逻辑标识，如 windows、nav。同 key 的卡会被复用而不是重复新建' },
      data: { type: 'object', desc: '卡片内容，字段取决于模板' },
      kind: { type: 'enum', values: ['task', 'system'], desc: '卡片类别，默认 task' },
    },
    handler: 'cardShow',
  },
  {
    name: 'card.update',
    desc: '更新已有卡片的内容。桌面上已有对应卡片时优先用这个，不要重复新建。',
    permission: '彩',
    params: {
      cardId: { type: 'string', required: true, desc: '卡片 id' },
      data: { type: 'object', required: true, desc: '要更新的字段' },
    },
    handler: 'cardUpdate',
  },
  {
    name: 'card.resize',
    desc: '改变卡片尺寸。空间不够时系统会自动腾位。',
    permission: '彩',
    params: {
      cardId: { type: 'string', required: true, desc: '卡片 id' },
      size: { type: 'enum', values: ['1/6', '1/3', '1/2'], required: true, desc: '目标尺寸' },
    },
    handler: 'cardResize',
  },
  {
    name: 'card.dismiss',
    desc: '移除一张卡片。',
    permission: '彩',
    params: { cardId: { type: 'string', required: true, desc: '卡片 id' } },
    handler: 'cardDismiss',
  },
  {
    name: 'card.focus',
    desc: '把卡片提到主位并高亮，同时刷新它的活跃时间，避免被挤掉。',
    permission: '彩',
    params: { cardId: { type: 'string', required: true, desc: '卡片 id' } },
    handler: 'cardFocus',
  },
  {
    name: 'desktop.getLayout',
    desc: '读取当前桌面布局：有哪些卡片、在哪个区、多大、还剩几格。编排卡片前先看这个。',
    permission: '彩',
    params: {},
    handler: 'deskLayout',
  },
  {
    name: 'desktop.pin',
    desc: '把卡片固定到桌面下方的固定区。固定区归用户所有，需要用户同意。',
    permission: '灰',
    params: { cardId: { type: 'string', required: true, desc: '卡片 id' } },
    confirmPrompt: '要把这张卡片固定到桌面上吗？',
    handler: 'deskPin',
  },
  {
    name: 'desktop.unpin',
    desc: '把卡片移出固定区。',
    permission: '灰',
    params: { cardId: { type: 'string', required: true, desc: '卡片 id' } },
    confirmPrompt: '要把这张卡片从桌面上取下吗？',
    handler: 'deskUnpin',
  },

  /* ── 黑级：永久禁区，配置里存在但永不暴露给 Agent ── */
  {
    name: 'brake.apply',
    desc: '施加制动力。',
    permission: '黑',
    params: { force: { type: 'number', range: [0, 1], required: true, desc: '制动力度' } },
  },
]
