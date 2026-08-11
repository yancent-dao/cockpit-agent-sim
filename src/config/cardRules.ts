import type { Op, Value } from '../core/types'
import type { Size } from '../cards/desk'
import type { Store } from '../core/store'
import type { AmapClient } from '../tools/amap'
import { buildMapUrl } from '../tools/navHandlers'

/**
 * 卡片规则 —— 状态→卡片的声明式映射（设计见 docs/superpowers/specs/2026-08-10-card-orchestration-design.md）
 *
 * 「该显示什么」的基础部分由这里的数据决定，模型零参与：
 * - 状态卡（有 when）：条件成立期间卡片必须在场，破灭自动退场；watch 信号变化刷新 data
 * - 事件卡（无 when）：watch 信号一变即确保在场，ttl 到期自动消失，活动期间寿命刷新
 *
 * 加场景 = 加一条规则 + 一个 data builder，不改编排器代码。
 * data builder 用具名函数白名单（沿用约束引擎具名谓词的先例）——纯配置拼不出 mapUrl 这类需要依赖的数据。
 */

export interface BuilderDeps { store: Store; amap?: AmapClient }

export interface CardRule {
  id: string
  /** 状态卡条件（三元组数组，与关系）。缺省 = 事件卡 */
  when?: Array<[string, Op, Value]>
  /** 触发信号，支持通配（cabin.window.*.position） */
  watch: string[]
  card: {
    key: string
    template: string
    size: Size
    /** 事件卡的寿命（秒）。状态卡不填——退场由条件决定 */
    ttl?: number
    evictable?: boolean
    /** data builder 名，登记在 DATA_BUILDERS 白名单 */
    data: string
  }
}

export const CARD_RULES: CardRule[] = [
  {
    id: 'nav-active',
    when: [['navigation.active', '==', true]],
    watch: [
      'navigation.eta', 'navigation.distanceRemaining', 'navigation.destination',
      'navigation.nextInstruction', 'navigation.destinationLocation',
      'navigation.routePolyline', 'vehicle.location',
    ],
    card: { key: 'nav', template: 'nav', size: '2/3', evictable: false, data: 'navCard' },
  },
  /* ── 车控事件卡：调什么显示什么，ttl 到期自动退场 ── */
  { id: 'window-feedback', watch: ['cabin.window.*.position'],
    card: { key: 'windows', template: 'control', size: '1/6', ttl: 30, data: 'windowCard' } },
  { id: 'climate-feedback', watch: ['cabin.climate.*'],
    card: { key: 'climate', template: 'control', size: '1/6', ttl: 30, data: 'climateCard' } },
  { id: 'seat-feedback', watch: ['seat.*.*'],
    card: { key: 'seats', template: 'control', size: '1/6', ttl: 30, data: 'seatCard' } },
  { id: 'steering-feedback', watch: ['cabin.steeringWheel.heating'],
    card: { key: 'steering', template: 'control', size: '1/6', ttl: 30, data: 'steeringCard' } },
  { id: 'ambient-feedback', watch: ['cabin.ambientLight.*'],
    card: { key: 'ambient', template: 'control', size: '1/6', ttl: 30, data: 'ambientCard' } },
  { id: 'fragrance-feedback', watch: ['cabin.fragrance.*'],
    card: { key: 'fragrance', template: 'control', size: '1/6', ttl: 30, data: 'fragranceCard' } },
  { id: 'light-feedback', watch: ['cabin.light.*.state'],
    card: { key: 'lights', template: 'control', size: '1/6', ttl: 30, data: 'lightCard' } },
  { id: 'drive-feedback', watch: ['vehicle.driveMode', 'vehicle.regenLevel', 'vehicle.suspensionHeight'],
    card: { key: 'drive', template: 'control', size: '1/6', ttl: 30, data: 'driveCard' } },
  { id: 'opening-feedback', watch: ['cabin.door.*.isOpen', 'cabin.trunk.isOpen', 'cabin.chargePort.isOpen'],
    card: { key: 'openings', template: 'control', size: '1/6', ttl: 30, data: 'openingCard' } },
]

const WIN_POS = ['driver', 'passenger', 'rearLeft', 'rearRight'] as const
const SEAT_CN: Record<string, string> = { driver: '主驾', passenger: '副驾', rearLeft: '左后', rearRight: '右后' }
const CN: Record<string, string> = {
  // 枚举值 → 人话。加枚举先补这里，别让英文码直接怼到屏上
  blue: '蓝色', purple: '紫色', pink: '粉色', red: '红色', orange: '橙色', yellow: '黄色', green: '绿色', white: '白色',
  static: '常亮', breathing: '呼吸', flowing: '流动', musicSync: '随音乐',
  none: '无', citrus: '柑橘', wood: '木质', floral: '花香', mint: '薄荷',
  comfort: '舒适', sport: '运动', eco: '节能', snow: '雪地',
  low: '低', normal: '标准', high: '高',
  on: '开', off: '关', auto: '自动',
  face: '吹面', feet: '吹脚', faceFeet: '吹面+吹脚', defrost: '除雾',
}
const cn = (v: unknown) => (typeof v === 'string' && CN[v]) || v

export const DATA_BUILDERS: Record<string, (d: BuilderDeps) => any> = {
  navCard: ({ store, amap }) => {
    const destination = store.get('navigation.destination') as string
    const destLoc = store.get('navigation.destinationLocation') as string
    const next = store.get('navigation.nextInstruction') as string
    const originLoc = store.get('vehicle.location') as string
    const polyline = store.get('navigation.routePolyline') as string
    return {
      title: destination ? `去${destination}` : '导航',
      destination,
      eta: store.get('navigation.eta'),
      distance: store.get('navigation.distanceRemaining'),
      ...(next && { steps: [{ instruction: next, distance: 0 }] }),
      // 活地图（JS SDK）要的原始坐标
      originLoc, destLoc, polyline,
      waypoints: store.get('navigation.waypoints') as string,
      // 静态图仍然给：JS 地图没加载出来时的兜底
      ...(amap && destLoc && {
        mapUrl: buildMapUrl(amap, originLoc, destLoc, polyline,
          ((store.get('navigation.waypoints') as string) || '').split(';').filter(Boolean)),
      }),
    }
  },

  windowCard: ({ store }) => ({
    title: '车窗',
    items: WIN_POS.map(k => ({
      key: k, label: SEAT_CN[k], unit: '%',
      value: store.getTarget(`cabin.window.${k}.position`) as number,
    })),
  }),

  climateCard: ({ store }) => ({
    title: '空调',
    items: [
      { label: '开关', value: store.get('cabin.climate.power') },
      { label: '温度', value: store.get('cabin.climate.targetTemp'), unit: '°C' },
      { label: '风量', value: store.get('cabin.climate.fanSpeed'), unit: '档' },
      { label: '出风', value: cn(store.get('cabin.climate.airflow')) },
    ],
  }),

  // 座椅项多（4座×4项），只显示非零的——"调了什么显示什么"
  seatCard: ({ store }) => {
    const items: any[] = []
    for (const pos of WIN_POS) {
      for (const [field, label, unit] of [['heating', '加热', '档'], ['ventilation', '通风', '档']] as const) {
        const v = store.get(`seat.${pos}.${field}`) as number
        if (v > 0) items.push({ label: `${SEAT_CN[pos]}${label}`, value: v, unit })
      }
    }
    return { title: '座椅', items: items.length ? items : [{ label: '加热/通风', value: '已全部关闭' }] }
  },

  steeringCard: ({ store }) => ({
    title: '方向盘',
    items: [{ label: '加热', value: store.get('cabin.steeringWheel.heating'), unit: '档' }],
  }),

  ambientCard: ({ store }) => ({
    title: '氛围灯',
    items: [
      { label: '开关', value: store.get('cabin.ambientLight.power') },
      { label: '颜色', value: cn(store.get('cabin.ambientLight.color')) },
      { label: '亮度', value: store.get('cabin.ambientLight.brightness'), unit: '%' },
      { label: '灯效', value: cn(store.get('cabin.ambientLight.effect')) },
    ],
  }),

  fragranceCard: ({ store }) => ({
    title: '香氛',
    items: [
      { label: '开关', value: store.get('cabin.fragrance.power') },
      { label: '香型', value: cn(store.get('cabin.fragrance.scent')) },
      { label: '浓度', value: store.get('cabin.fragrance.intensity'), unit: '档' },
    ],
  }),

  lightCard: ({ store }) => ({
    title: '车灯',
    items: [
      { label: '大灯', value: cn(store.get('cabin.light.headlight.state')) },
      { label: '后备箱灯', value: cn(store.get('cabin.light.trunkLight.state')) },
    ],
  }),

  driveCard: ({ store }) => ({
    title: '驾驶设置',
    items: [
      { label: '驾驶模式', value: cn(store.get('vehicle.driveMode')) },
      { label: '动能回收', value: store.get('vehicle.regenLevel'), unit: '级' },
      { label: '悬架', value: cn(store.get('vehicle.suspensionHeight')) },
    ],
  }),

  // 门/舱盖只显示开着的——全关时明确说"全部关好"
  openingCard: ({ store }) => {
    const defs: Array<[string, string]> = [
      ['cabin.door.driver.isOpen', '主驾车门'], ['cabin.door.passenger.isOpen', '副驾车门'],
      ['cabin.door.rearLeft.isOpen', '左后车门'], ['cabin.door.rearRight.isOpen', '右后车门'],
      ['cabin.trunk.isOpen', '后备箱'], ['cabin.chargePort.isOpen', '充电口'],
    ]
    const items = defs.filter(([p]) => store.get(p) === true).map(([, label]) => ({ label, value: '开启' }))
    return { title: '门与舱盖', items: items.length ? items : [{ label: '车门/后备箱/充电口', value: '全部关好' }] }
  },
}
