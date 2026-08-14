import type { Op, Value } from '../core/types'
import type { Size } from '../cards/desk'
import type { Store } from '../core/store'
import type { AmapClient } from '../integrations/amap'
import { buildMapUrl } from '../integrations/navHandlers'
import type { DomainState } from '../state/domain'

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

export interface BuilderDeps { store: Store; amap?: AmapClient; state?: DomainState }

export interface CardRule {
  id: string
  /** 状态卡条件（三元组数组，与关系）。缺省 = 事件卡 */
  when?: Array<[string, Op, Value]>
  /** 触发信号，支持通配（cabin.window.*.position） */
  watch: string[]
  card: {
    key: string
    template: string
    /** 不写就用模板的 defaultSize */
    size?: Size
    /**
     * 事件卡的寿命（秒）。**默认不填 = 不自动消失。**
     *
     * 之前车控反馈卡统一 30 秒退场，演示时最常见的抱怨是「我还没讲到它就没了」。
     * 而且 30 这个数字是拍的：用户瞟一眼车窗开度要 3 秒，讲解一段要 2 分钟，
     * 同一个数字伺候不了这两种场合。
     *
     * 桌面满了自然会挤（七档缩放 + LRU）——**让空间竞争决定谁退场，
     * 比让秒表决定更接近真实的注意力分配**。
     * 只有"问了没人答"这类真的会过期的东西才该填秒数。
     */
    ttl?: number
    evictable?: boolean
    /**
     * 这事有多急。正交于 kind —— 规则建的卡全是 rule，但天气和"车门没关且已起步"
     * 显然不该有同样的命运。不写就是 normal。
     */
    urgency?: 'ambient' | 'normal' | 'urgent' | 'critical'
    /** 靠边锚定：nav 靠左。（时钟卡撤掉后暂时只有它用，字段保留给将来的右锚定卡） */
    anchor?: 'left' | 'right'
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
      'navigation.nextInstruction', 'navigation.destinationLocation','navigation.waypointNames',
      'navigation.routePolyline', 'vehicle.location',
    ],
    card: { key: 'nav', template: 'nav', evictable: false, data: 'navCard' },
  },
  /* ── 播放器卡：持续态，跟导航卡同一个生命周期，不是"30 秒后退场"那类 ── */
  // 两条互斥规则而不是"按内容算尺寸的函数"——规则得是纯数据，
  // 塞进去一个 size(store) 回调，声明式就破了。
  // key 必须不同：orchestrator 的 retire 按 key 撤卡，同 key 的话
  // 一条规则建完、另一条判定自己不活跃就立刻把它撤了，互相拆台。
  // when 互斥保证两张卡不会同时在场
  {
    id: 'media-playing',
    // 用户实拍 bug：条件曾是 playing==true，点暂停规则判死刑直接撤卡。
    // **暂停是状态不是退场理由**——有内容加载着卡就在场（显示 ▶ 等继续），
    // stop 清掉内容（source=none）才退场。watch 带 playing 让暂停态刷进卡片
    when: [['media.source', '!=', 'none'], ['media.source', '!=', 'video']],
    watch: ['media.track', 'media.artist', 'media.artwork', 'media.source', 'media.mode', 'media.playing'],
    card: { key: 'player', template: 'media', evictable: true, urgency: 'ambient', data: 'playerCard' },
  },
  {
    id: 'media-playing-video',
    when: [['media.source', '==', 'video']],
    watch: ['media.track', 'media.artist', 'media.artwork', 'media.source', 'media.mode', 'media.playing'],
    card: { key: 'player-video', template: 'media', size: '2/3', evictable: true, data: 'playerCard' },
  },
  /* ── 车控事件卡：调什么显示什么，ttl 到期自动退场 ── */
  { id: 'window-feedback', watch: ['cabin.window.*.position'],
    card: { key: 'windows', template: 'control', data: 'windowCard' } },
  { id: 'climate-feedback', watch: ['cabin.climate.*'],
    card: { key: 'climate', template: 'control', data: 'climateCard' } },
  { id: 'seat-feedback', watch: ['seat.*.*'],
    card: { key: 'seats', template: 'control', data: 'seatCard' } },
  { id: 'steering-feedback', watch: ['cabin.steeringWheel.heating'],
    card: { key: 'steering', template: 'control', data: 'steeringCard' } },
  { id: 'ambient-feedback', watch: ['cabin.ambientLight.*'],
    card: { key: 'ambient', template: 'control', data: 'ambientCard' } },
  { id: 'fragrance-feedback', watch: ['cabin.fragrance.*'],
    card: { key: 'fragrance', template: 'control', data: 'fragranceCard' } },
  { id: 'light-feedback', watch: ['cabin.light.*.state'],
    card: { key: 'lights', template: 'control', data: 'lightCard' } },
  { id: 'drive-feedback', watch: ['vehicle.driveMode', 'vehicle.regenLevel', 'vehicle.suspensionHeight'],
    card: { key: 'drive', template: 'control', data: 'driveCard' } },
  { id: 'opening-feedback', watch: ['cabin.door.*.isOpen', 'cabin.trunk.isOpen', 'cabin.chargePort.isOpen'],
    card: { key: 'openings', template: 'control', urgency: 'urgent', data: 'openingCard' } },
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
      via: ((store.get('navigation.waypointNames') as string) || '').split(';').filter(Boolean),
      // 静态图仍然给：JS 地图没加载出来时的兜底
      ...(amap && destLoc && {
        mapUrl: buildMapUrl(amap, originLoc, destLoc, polyline,
          ((store.get('navigation.waypoints') as string) || '').split(';').filter(Boolean)),
      }),
    }
  },

  /** 播放器。视频要大画面，音乐/电台用默认小卡——这是唯一按内容改尺寸的地方 */
  playerCard: ({ store, state }) => {
    const source = store.get('media.source') as string
    return {
      // 接下来两首（域仓队列）——大档播放器卡显示，让"下一曲"有预告
      nextUp: state?.queue.peek(2).map(t => t.track) ?? [],
      title: store.get('media.track') || '正在播放',
      track: store.get('media.track'),
      artist: store.get('media.artist'),
      artwork: store.get('media.artwork'),
      source,
      mode: store.get('media.mode'),
      playing: store.get('media.playing'),
      streamUrl: store.get('media.streamUrl'),
      volume: store.get('media.volume'),
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
