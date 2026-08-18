import type { Permission, Op, Value } from '../core/types'
import { TEMPLATE_IDS, CARD_TEMPLATES } from './cards'

/**
 * Agent 能选的全部档位，从小到大。
 * 之前这里只写了老的五档，chip/strip/bar/wide 这些小档虽然在栅格里存在，
 * Agent 却选不到 —— 桌面一满就只能挤卡，用户看到的就是"超过六个就把播放器关了"。
 */
const ALL_SIZES = ['chip', 'strip', 'tile', 'bar', 'box', 'frame', 'wide',
  'panel', 'tower', 'hall', 'band', 'court', 'stage', 'full'] as const

export interface ParamDef {
  type: 'number' | 'string' | 'boolean' | 'enum' | 'array' | 'object'
  values?: string[]
  range?: [number, number]
  /**
   * 数组元素的形状。可以只写类型名（`'string'`），也可以直接写一段
   * JSON Schema —— 后者是实拍逼出来的：`story.begin` 的 pages 只声明
   * "是个数组"时模型**连着猜错两次**（`pageCount:"3"`、`{item:[...]}`）。
   * 元素形状写在 desc 的散文里，模型读不到机器可读的约束。
   */
  items?: 'string' | Record<string, unknown>
  required?: boolean
  /**
   * 缺省值。**路径占位符的必要配套**：`sunroof.set` 写的是
   * `cabin.sunroof.{part}.position`，part 不传路径就拼成 `undefined` ——
   * 而"开天窗"这句话里用户根本不会说"玻璃还是遮阳帘"，
   * 逼模型每次都传是把机制的缺口转嫁给它。
   * 填进 args 的时机在**校验之前**，之后所有环节都当它是用户传的。
   */
  default?: Value
  desc: string
}

export interface ToolDef {
  name: string
  desc: string
  permission: Permission
  params: Record<string, ParamDef>
  /**
   * 声明式写入：有此字段即自动生成 handler，无需一行代码。
   * 数组支持一次调用写多个不同信号（如 climate.set 同时改温度和风量）——
   * 每条独立判断对应的 from 字段本次是否传入，没传就跳过，不是"全部必填"。
   */
  writes?: Array<{ path: string; from: string; map?: Record<string, Value> }>
  /** 参数展开：window=all → 四扇窗 */
  expand?: Record<string, Record<string, string[]>>
  /** 动态权限升级：命中条件时提升等级 */
  escalate?: Array<{ when: [string, Op, Value]; to: Permission }>
  /** 需二次确认时向用户播报的问句 */
  confirmPrompt?: string
  /** 有真实逻辑的 Tool 用具名 handler，登记在 handlers/ 白名单 */
  handler?: string
  /** mic 类工具（说话/提问）。stale 轮里 pipeline 会拒——说话就是抢麦，建问题卡也是 */
  mic?: boolean
  /** 依赖的信号：该信号 equipped=false 时，能力目录里此 Tool 标记为未选装 */
  requires?: string
  /**
   * 一行速览（≤20 字），慢层工具目录的原料——目录常驻 system 代替全量 schema。
   * 非黑、非 meta 工具必填（有测试卡）。写给模型看，要说清"什么时候用我"。
   */
  brief?: string
  /**
   * 快层工具面标记。**显式标注不做推导**：彩权限里也有不适合快层的
   * （music.play 要挑搜索结果）。只允许出现在彩权限上（有测试卡）。
   */
  fast?: boolean
  /** 元工具（tools.load / handoff 这类装载管道），不进目录不进能力卡 */
  meta?: boolean
}

/**
 * v0.1 Tool 集。44 个中的第一批。
 * 约 60% 是零 handler 代码的 —— 靠 writes 声明自动生成。
 */
export const TOOLS: ToolDef[] = [
  /* ── 读取 ── */
  {
    name: 'vehicle.getState',
    brief: '读车辆当前状态',
    fast: true,
    desc: '读取车辆当前状态。不传参返回全部状态；传 paths 只读取指定信号。',
    permission: '彩',
    params: {
      paths: { type: 'array', items: 'string', desc: '要读取的信号路径列表，如 ["vehicle.speed"]' },
    },
    handler: 'getState',
  },

  /* ── 能力目录：由 Tool Registry 自动生成，供能力目录卡渲染 ── */
  {
    name: 'capability.list',
    brief: '屏上显示能力目录',
    desc: '把本车能力目录显示到屏幕上（按能力域分组的卡片，如车窗/空调/导航），并返回清单数据。**这是唯一能让用户在屏幕上看到能力清单的方式**——你自己凭记忆背清单，用户屏幕上什么都不会出现，而且容易背漏或背错。所以只要用户问"你能做什么/会啥/帮我干嘛"，先调它，再口头概括一两句。调用后不要再说"屏幕上已显示"之类的话除非你真的调过它。不传 domain 返回全部；传 domain 只看某一类（如 window）。',
    permission: '彩',
    params: {
      domain: { type: 'string', desc: '按能力名前缀过滤，如 "window" 只看车窗相关能力' },
    },
    handler: 'capabilityList',
  },

  /* ── 车窗（零 handler） ── */
  {
    name: 'window.set',
    brief: '控制车窗开度',
    fast: true,
    desc: '控制车窗开度。position 为百分比，0 表示完全关闭，100 表示完全打开。window 传 all 可一次控制四扇窗。',
    permission: '彩',
    params: {
      window: {
        type: 'enum', values: ['driver', 'passenger', 'rearLeft', 'rearRight', 'all'],
        required: true, desc: '目标车窗：driver 主驾 / passenger 副驾 / rearLeft 左后 / rearRight 右后 / all 全部',
      },
      position: { type: 'number', range: [0, 100], required: true, desc: '开度百分比 0-100' },
    },
    writes: [{ path: 'cabin.window.{window}.position', from: 'position' }],
    expand: { window: { all: ['driver', 'passenger', 'rearLeft', 'rearRight'] } },
    escalate: [{ when: ['vehicle.speed', '>', 5], to: '灰' }],
    confirmPrompt: '车辆正在行驶，确认要调整车窗吗？',
  },

  /* ── 空调（v0.1 简化：单分区，不做左右独立温区） ── */
  {
    name: 'climate.set',
    brief: '空调温度风量出风',
    fast: true,
    desc: '控制空调。可以一次传多个字段（比如同时开空调并调温度），只传要改的字段即可，不用每个都填。',
    permission: '彩',
    params: {
      power: { type: 'boolean', desc: '空调开关' },
      targetTemp: { type: 'number', range: [16, 30], desc: '目标温度 °C' },
      fanSpeed: { type: 'number', range: [0, 7], desc: '风量档位 0-7' },
      airflow: { type: 'enum', values: ['face', 'feet', 'faceFeet', 'defrost'], desc: '出风模式' },
      auto: { type: 'boolean', desc: '自动模式' },
      recirculation: { type: 'boolean', desc: '内循环' },
      frontDefrost: { type: 'boolean', desc: '前挡除雾' },
      rearDefrost: { type: 'boolean', desc: '后挡除雾' },
    },
    writes: [
      { path: 'cabin.climate.power', from: 'power' },
      { path: 'cabin.climate.targetTemp', from: 'targetTemp' },
      { path: 'cabin.climate.fanSpeed', from: 'fanSpeed' },
      { path: 'cabin.climate.airflow', from: 'airflow' },
      { path: 'cabin.climate.auto', from: 'auto' },
      { path: 'cabin.climate.recirculation', from: 'recirculation' },
      { path: 'cabin.climate.frontDefrost', from: 'frontDefrost' },
      { path: 'cabin.climate.rearDefrost', from: 'rearDefrost' },
    ],
  },

  /* ── 座椅（v0.1 简化：滑动/靠背仅前排；按摩、记忆位暂不做） ── */
  {
    name: 'seat.set',
    brief: '座椅加热通风调节',
    fast: true,
    desc: '控制座椅。seat 传 all 可一次控制四个座椅（仅对加热/通风/按摩生效，滑动和靠背只有前排有）。可以一次传多个字段，只传要改的即可。',
    permission: '彩',
    params: {
      seat: {
        type: 'enum', values: ['driver', 'passenger', 'rearLeft', 'rearRight', 'all'],
        required: true, desc: '目标座椅',
      },
      heating: { type: 'number', range: [0, 3], desc: '加热档位 0-3' },
      ventilation: { type: 'number', range: [0, 3], desc: '通风档位 0-3' },
      massage: { type: 'number', range: [0, 3], desc: '按摩档位 0-3，0 是关' },
      slide: { type: 'number', range: [0, 100], desc: '前后位置百分比，仅前排' },
      recline: { type: 'number', range: [0, 100], desc: '靠背角度百分比，仅前排' },
    },
    writes: [
      { path: 'seat.{seat}.heating', from: 'heating' },
      { path: 'seat.{seat}.ventilation', from: 'ventilation' },
      { path: 'seat.{seat}.massage', from: 'massage' },
      { path: 'seat.{seat}.slide', from: 'slide' },
      { path: 'seat.{seat}.recline', from: 'recline' },
    ],
    expand: { seat: { all: ['driver', 'passenger', 'rearLeft', 'rearRight'] } },
  },

  /* ── 方向盘 ── */
  {
    name: 'steeringWheel.set',
    brief: '方向盘加热',
    fast: true,
    desc: '控制方向盘加热档位。',
    permission: '彩',
    params: { heating: { type: 'number', range: [0, 3], required: true, desc: '加热档位 0-3' } },
    writes: [{ path: 'cabin.steeringWheel.heating', from: 'heating' }],
  },

  /* ── 天窗：未选装，用于反幻觉验证 ── */
  {
    name: 'sunroof.set',
    brief: '天窗开合',
    fast: true,
    desc: '控制全景天窗。part 不传就是动玻璃 —— 用户说「开天窗」指的就是它；' +
      '说「拉上遮阳帘」「遮一下太阳」时传 shade。两者是独立执行器，各开各的。',
    permission: '彩',
    params: {
      position: { type: 'number', range: [0, 100], required: true, desc: '开度百分比 0-100' },
      part: { type: 'enum', values: ['glass', 'shade'], default: 'glass', desc: '玻璃还是遮阳帘，默认 glass' },
    },
    // 路径里的 {part} 缺省时由 expand 填 glass —— 现有信号本来就叫
    // cabin.sunroof.**glass**.position，加这个参数天然吻合，零破坏
    writes: [{ path: 'cabin.sunroof.{part}.position', from: 'position' }],
    requires: 'cabin.sunroof.glass.position',
  },

  /* ── 后视镜（零 handler）。只做折叠与加热：角度调节在屏幕上看不出变化，
     演示价值为零，加了只是让能力目录长一点 ── */
  {
    name: 'defrost.set',
    brief: '前后风挡除雾',
    fast: true,
    desc: '开关前/后风挡除雾除霜。雨天起雾、冬天结霜用。target 传 both 一次开双侧。',
    permission: '彩',
    params: {
      target: { type: 'enum', values: ['front', 'rear', 'both'], required: true, desc: '前挡 / 后挡 / 都开' },
      on: { type: 'boolean', required: true, desc: '开或关' },
    },
    writes: [{ path: 'cabin.defrost.{target}.isOn', from: 'on' }],
    expand: { target: { both: ['front', 'rear'] } },
  },
  {
    name: 'mirror.set',
    brief: '后视镜折叠与加热',
    fast: true,
    desc: '控制后视镜。mirror 传 both 一次控制两侧。可以一次传多个字段，只传要改的即可。' +
      '下雨起雾时用户说"后视镜看不清"，开加热。',
    permission: '彩',
    params: {
      mirror: {
        type: 'enum', values: ['driver', 'passenger', 'both'],
        required: true, desc: '目标后视镜',
      },
      fold: { type: 'boolean', desc: '折叠收起' },
      heating: { type: 'boolean', desc: '镜面加热除雾' },
    },
    writes: [
      { path: 'cabin.mirror.{mirror}.isFolded', from: 'fold' },
      { path: 'cabin.mirror.{mirror}.heating', from: 'heating' },
    ],
    expand: { mirror: { both: ['driver', 'passenger'] } },
  },

  /* ── 空气净化器（零 handler） ── */
  {
    name: 'airPurifier.set',
    brief: '空气净化器开关档位',
    fast: true,
    desc: '控制空气净化器。可以一次传开关和档位。用户说"空气不好""外面味儿大"时用它，' +
      '跟空调内循环是两件事（内循环走 climate.set）。',
    permission: '彩',
    params: {
      power: { type: 'boolean', desc: '开关' },
      level: { type: 'number', range: [0, 3], desc: '净化档位 0-3' },
    },
    writes: [
      { path: 'cabin.airPurifier.power', from: 'power' },
      { path: 'cabin.airPurifier.level', from: 'level' },
    ],
  },

  {
    name: 'wiper.set',
    brief: '雨刷挡位',
    fast: true,
    desc: '雨刷。auto 是自动感应雨量，下雨天用户说"开雨刷"一般给 auto 最省心；雨大就 high。',
    permission: '彩',
    params: { mode: { type: 'enum', values: ['off', 'auto', 'slow', 'medium', 'high'], required: true, desc: '档位' } },
    writes: [{ path: 'cabin.wiper.mode', from: 'mode' }],
  },

  /* ── 车门：灰级，需二次确认 ── */
  {
    name: 'door.set',
    brief: '开关车门，需确认',
    desc: '开关车门。open 打开，close 关闭。',
    permission: '灰',
    params: {
      door: {
        type: 'enum', values: ['driver', 'passenger', 'rearLeft', 'rearRight'],
        required: true, desc: '目标车门',
      },
      action: { type: 'enum', values: ['open', 'close'], required: true, desc: '动作' },
    },
    writes: [{ path: 'cabin.door.{door}.isOpen', from: 'action', map: { open: true, close: false } }],
    confirmPrompt: '即将打开车门，确认吗？',
  },

  /* ── 后备箱：灰级，且非 P 挡禁止 ── */
  {
    name: 'trunk.set',
    brief: '开关后备箱，需确认',
    desc: '开关后备箱。只有 P 挡才能打开。',
    permission: '灰',
    params: {
      target: { type: 'enum', values: ['trunk'], required: true, desc: '目标' },
      action: { type: 'enum', values: ['open', 'close'], required: true, desc: '动作' },
    },
    writes: [{ path: 'cabin.trunk.isOpen', from: 'action', map: { open: true, close: false } }],
    confirmPrompt: '即将打开后备箱，确认吗？',
  },

  /* ── 充电口 ── */
  {
    name: 'chargePort.set',
    brief: '开关充电口，需确认',
    desc: '开关充电口盖。',
    permission: '彩',
    params: { action: { type: 'enum', values: ['open', 'close'], required: true, desc: '动作' } },
    writes: [{ path: 'cabin.chargePort.isOpen', from: 'action', map: { open: true, close: false } }],
  },

  /* ── 儿童锁 ── */
  {
    name: 'childLock.set',
    brief: '儿童锁开关',
    fast: true,
    desc: '开关后排儿童锁。开启后后排车窗与车门将无法控制。',
    permission: '彩',
    params: { enabled: { type: 'boolean', required: true, desc: '是否开启' } },
    writes: [{ path: 'cabin.childLock', from: 'enabled' }],
  },

  /* ── 氛围灯（v0.1 简化：整车一个分区，不做前后独立） ── */
  {
    name: 'ambientLight.set',
    brief: '氛围灯开关颜色亮度',
    fast: true,
    desc: '控制氛围灯。可以一次传多个字段，只传要改的即可。',
    permission: '彩',
    params: {
      power: { type: 'boolean', desc: '开关' },
      color: { type: 'enum', values: ['white', 'blue', 'purple', 'pink', 'red', 'orange', 'yellow', 'green'], desc: '颜色' },
      brightness: { type: 'number', range: [0, 100], desc: '亮度百分比' },
      effect: { type: 'enum', values: ['static', 'breathing', 'flowing', 'musicSync'], desc: '灯效' },
    },
    writes: [
      { path: 'cabin.ambientLight.power', from: 'power' },
      { path: 'cabin.ambientLight.color', from: 'color' },
      { path: 'cabin.ambientLight.brightness', from: 'brightness' },
      { path: 'cabin.ambientLight.effect', from: 'effect' },
    ],
  },

  /* ── 香氛 ── */
  {
    name: 'fragrance.set',
    brief: '香氛开关香型浓度',
    fast: true,
    desc: '控制香氛。可以一次传多个字段，只传要改的即可。',
    permission: '彩',
    params: {
      power: { type: 'boolean', desc: '开关' },
      scent: { type: 'enum', values: ['none', 'citrus', 'wood', 'floral', 'mint'], desc: '香型' },
      intensity: { type: 'number', range: [0, 3], desc: '浓度档位 0-3' },
    },
    writes: [
      { path: 'cabin.fragrance.power', from: 'power' },
      { path: 'cabin.fragrance.scent', from: 'scent' },
      { path: 'cabin.fragrance.intensity', from: 'intensity' },
    ],
  },

  /* ── 灯光（v0.1 简化：只做大灯与后备箱灯，阅读灯留待 v0.2） ── */
  {
    name: 'light.set',
    brief: '大灯与后备箱灯',
    fast: true,
    desc: '开关车灯。用户说「开大灯」一般指近光（lowBeam）；「远光」「雾灯」「示宽灯」「阅读灯」各自独立。',
    permission: '彩',
    params: {
      light: {
        type: 'enum',
        values: ['lowBeam', 'highBeam', 'fogFront', 'fogRear', 'parking',
                 'readingFront', 'readingRear', 'trunkLight'],
        required: true,
        desc: '目标灯具：lowBeam 近光（用户说"大灯"一般指它）/ highBeam 远光 / ' +
          'fogFront 前雾灯 / fogRear 后雾灯 / parking 示宽灯 / ' +
          'readingFront 前排阅读灯 / readingRear 后排阅读灯 / trunkLight 后备箱灯',
      },
      state: { type: 'enum', values: ['on', 'off', 'auto'], required: true, desc: '状态。auto 是随环境光自动' },
    },
    writes: [{ path: 'cabin.light.{light}.state', from: 'state' }],
  },

  /* ── 驾驶设置：灰级（行驶中） ── */
  {
    name: 'driveSetting.set',
    brief: '驾驶模式回收悬架',
    fast: true,
    desc: '调整驾驶模式、动能回收、悬架高度。可以一次传多个字段，只传要改的即可。停车时可直接执行，行驶中需要用户确认。',
    permission: '彩',
    params: {
      driveMode: { type: 'enum', values: ['comfort', 'sport', 'eco', 'snow'], desc: '驾驶模式' },
      regenLevel: { type: 'number', range: [0, 3], desc: '动能回收等级 0-3' },
      suspensionHeight: { type: 'enum', values: ['low', 'normal', 'high'], desc: '悬架高度' },
    },
    writes: [
      { path: 'vehicle.driveMode', from: 'driveMode' },
      { path: 'vehicle.regenLevel', from: 'regenLevel' },
      { path: 'vehicle.suspensionHeight', from: 'suspensionHeight' },
    ],
    escalate: [{ when: ['vehicle.speed', '>', 5], to: '灰' }],
    confirmPrompt: '车辆正在行驶，确认要调整驾驶设置吗？',
  },

  /* ── L2 应用级：导航（真实接高德，失败一律 unavailable，不冒充 rejected） ── */
  {
    name: 'navigation.search',
    brief: '搜地点出候选列表',
    desc: '搜索地点或公交线路。去一个地方前先用这个搜，不要凭地名直接设目的地——同名地点很多。type 传 poi（默认）返回候选 POI 列表；type 传 bus 返回公交线路，这时 near 必须传城市名。搜到多个候选时列表会自动上屏，**带编号**。你只说一句"搜到几个，你说第几个"就行，别把候选逐条念一遍——屏幕上摆着呢，念了是重复劳动，语音还长。只有一个候选时直接进 navigation.setDestination，不用多此一举地问。',
    permission: '彩',
    params: {
      query: { type: 'string', required: true, desc: '搜索关键字，如"望京 SOHO" 或公交线路名"10号线"' },
      type: { type: 'enum', values: ['poi', 'bus'], desc: '搜索类型，默认 poi' },
      near: { type: 'string', desc: 'poi 搜索时是可选的城市/区域限定；bus 搜索时是必填的城市名' },
    },
    handler: 'navSearch',
  },
  {
    name: 'navigation.setDestination',
    brief: '设目的地开始导航',
    desc: '设置导航目的地并规划路线，调用成功后导航自动开始，导航卡会由系统自动出现在桌面上——你不需要也不应该再调 card.show 或 navigation.control 的 start。poiId（来自 navigation.search 的结果）和 address 二选一传。',
    permission: '彩',
    params: {
      alias: { type: 'string', desc: '常用地址别名，如"家""公司"。用户说"回家"时优先用这个，不用再搜' },
      poiId: { type: 'string', desc: 'navigation.search 返回的 POI id' },
      address: { type: 'string', desc: '地址或地点名称，没有 alias/poiId 时用这个' },
      preference: { type: 'enum', values: ['default', 'fastest', 'highwayFirst', 'avoidHighway', 'avoidCongestion', 'avoidToll'],
        desc: '路线偏好，默认 default。**限行不用管** —— 车牌已经随请求传给高德，' +
          '它会自动规避，撞了限行也会在结果里说' },
      mode: { type: 'enum', values: ['driving', 'walking', 'bicycling', 'electrobike'], desc: '出行方式，默认 driving。用户说"走过去""骑车"时改' },
      waypoints: {
        type: 'array', items: 'string',
        desc: '途经点坐标（"经度,纬度"），按先后顺序，最多 16 个。用户说"先去A再去B"或"顺路充个电"时用——坐标来自 navigation.search / navigation.searchAlong 结果里的 location。传了途经点就是一条完整路线，会依次经过再到终点，**不需要用户中途做任何操作**，不要说"到了要手动切换下一站"这种话。',
      },
      waypointNames: {
        type: 'array', items: 'string',
        desc: '途经点的名字，跟 waypoints 一一对应，比如["特来电中环广场"]。坐标只能在地图上打点，导航卡要靠这个写出"经 XX"——不传的话用户看屏幕不知道要绕路。',
      },
    },
    handler: 'navSetDestination',
  },
  {
    name: 'region.districts',
    brief: '查周边区县列表',
    desc: `列出某个城市下辖的区县（名称 + 中心坐标）。不传 area 就用车辆当前所在城市。
**这是"扫一圈周边"类需求的第一步**——拿到区县列表后，再用别的工具逐个查，就能组合出很多事：
例："找附近正在下雨的县城导航过去" = 先调这个拿区县列表，再对每个区县调 weather.query，
挑出在下雨的，再调 navigation.setDestination 过去。区县不少，挑几个近的查就行，不用全查。`,
    permission: '彩',
    params: {
      area: { type: 'string', desc: '城市名，如"成都"。不传则用车辆当前所在城市' },
    },
    handler: 'regionDistricts',
  },
  {
    name: 'places.save',
    brief: '存常用地址',
    desc: '把一个地点存成常用地址（家、公司、常去的健身房等），之后用户说"回家"就能直接导航。坐标来自 navigation.search 结果里的 location。',
    permission: '彩',
    params: {
      alias: { type: 'string', required: true, desc: '别名，如"家""公司"' },
      address: { type: 'string', required: true, desc: '完整地址，供用户核对' },
      location: { type: 'string', required: true, desc: '坐标"经度,纬度"' },
    },
    handler: 'placesSave',
  },
  {
    name: 'places.list',
    brief: '列常用地址',
    desc: '看看存了哪些常用地址。用户说"回家""去公司"而你不确定存没存时，先查这个。',
    permission: '彩',
    params: {},
    handler: 'placesList',
  },
  {
    name: 'places.remove',
    brief: '删一条常用地址',
    desc: '删掉一条存过的常用地址。改名 = 先 remove 再 save。',
    permission: '彩',
    params: { alias: { type: 'string', required: true, desc: '要删的别名，如"家"' } },
    handler: 'placesRemove',
  },
  {
    name: 'map.control',
    brief: '地图缩放/全览/2D3D/朝向',
    desc: '控制导航地图的显示。action 是一次性的动作（放大/缩小/看全程/回到自车位），' +
      'style 和 heading 是模式开关，可以跟 action 一起传。用户说"看下整条路线"用 overview，' +
      '"回到当前位置"用 follow。只影响地图怎么显示，不影响导航本身。',
    permission: '彩',
    params: {
      action: { type: 'enum', values: ['zoomIn', 'zoomOut', 'overview', 'follow'],
        desc: '放大一档 / 缩小一档 / 路线全览 / 跟随自车' },
      style: { type: 'enum', values: ['2d', '3d', 'satellite'], desc: '平面 / 立体 / 卫星底图' },
      heading: { type: 'enum', values: ['north', 'vehicle'], desc: '北朝上或车头朝上' },
      traffic: { type: 'boolean', desc: '实时路况图层开关（红黄绿）' },
      cruise: { type: 'enum', values: ['start', 'stop'], desc: '模拟行驶：车标沿当前路线跑一遍（演示用，需要正在导航）' },
    },
    handler: 'mapControl',
  },
  {
    name: 'traffic.status',
    brief: '查路况拥堵情况',
    desc: '查一个地方的实时交通态势（拥堵评价 + 畅通/缓行/拥堵占比）。不传 location 查车辆附近。' +
      '想在地图上直接看红黄绿，用 map.control 开 traffic 图层——一个给你读，一个给用户看。',
    permission: '彩',
    params: {
      location: { type: 'string', desc: '地名，如"春熙路"。不传查车辆当前位置附近' },
      radius: { type: 'number', desc: '半径米数，默认 2000' },
    },
    handler: 'trafficStatus',
  },
  {
    name: 'navigation.searchAlong',
    brief: '沿途周边搜服务点',
    desc: `找附近或沿途的地方（充电站、加油站、服务区、停车场、厕所、餐厅等），结果自动上屏，带编号。
      口头只说"找到几个，最近的是XX"这种一句话结论，别把每个的名字、距离逐条念——屏幕上有。
不传 near 时：导航中沿路线前方找，没导航就找车辆附近；不传 keyword 时按车型自动选（电车找充电站、油车找加油站）。
**可以多次调用来组合出复杂需求**——传 near 就能以任意坐标为中心再搜一圈。
例："找个周围有饺子馆的充电站" = 先调一次拿到几个充电站及其 location，
再对每个 location 传 near + keyword:"饺子" + radius:800 各搜一次，哪个有结果就是它。
找到后把该地点的 location 作为 waypoints 传给 navigation.setDestination 即可顺路去。`,
    permission: '彩',
    params: {
      keyword: { type: 'string', desc: '要找什么，如"充电站""服务区""饺子"。不传则按车型自动选' },
      near: { type: 'string', desc: '搜索中心坐标"经度,纬度"。不传则自动用路线前方或车辆当前位置' },
      radius: { type: 'number', range: [100, 50000], desc: '搜索半径（米），默认 5000。找"某地周围步行可达的店"时用 500-1000' },
    },
    handler: 'navSearchAlong',
  },
  {
    name: 'navigation.compareRoutes',
    brief: '多路线方案对比',
    desc: '对比去同一个目的地的几条路线（耗时/里程/过路费/红绿灯数），方案列表会自动上屏，带编号。口头只说关键差别和你的建议（"最快那条要两块过路费，另外两条免费"），别把三条的耗时里程逐条念一遍。用户问"走哪条快""要不要走高速""过路费多少"时用。用户选定后再调 navigation.setDestination 并传对应的 preference。',
    permission: '彩',
    params: {
      poiId: { type: 'string', desc: 'navigation.search 返回的 POI id' },
      address: { type: 'string', desc: '地址或地点名称，没有 poiId 时用这个' },
      waypoints: { type: 'array', items: 'string', desc: '途经点坐标，可选' },
    },
    handler: 'navCompareRoutes',
  },
  {
    name: 'navigation.control',
    brief: '暂停恢复结束导航',
    desc: '控制导航会话：resume 从暂停恢复/pause 暂停/cancel 取消。start 一般用不上——navigation.setDestination 成功后会自动开始导航；只有目的地已经设过、又被 pause 了，现在要重新开始，才需要用 start（或者干脆用 resume，效果一样）。',
    permission: '彩',
    params: {
      action: { type: 'enum', values: ['start', 'resume', 'pause', 'cancel'], required: true, desc: '动作' },
    },
    handler: 'navControl',
  },
  {
    name: 'navigation.getStatus',
    brief: '读导航当前状态',
    desc: '读取当前导航状态：是否在导航、目的地、ETA、剩余里程、电量是否够到达。导航中时会附带 traffic（实时路况），拿不到就没有这个字段，不代表出错。',
    permission: '彩',
    params: {},
    handler: 'navGetStatus',
  },

  /* ── L2 应用级：天气（真实接高德） ── */
  {
    name: 'weather.query',
    brief: '查城市天气预报',
    fast: true,
    desc: '查询某个地点的天气，同时返回实况与未来几天预报。查询成功后天气卡会自动显示在屏幕上，你只负责口头播报重点，不要再建卡。查不到这个地点时会得到 unavailable。'
      + '**注意**：这是气象服务的城市级数据，跟车上传感器（车外温度、当前天况）测的"此刻这里"不是一回事，'
      + '两者对不上很正常，别当成矛盾去质问用户——车里冷不冷、雨大不大以传感器为准。',
    permission: '彩',
    params: {
      location: { type: 'string', required: true, desc: '真实地名（"北京"、"望京"）或"经度,纬度"数字坐标。查当前位置的天气：把车辆状态里"当前位置(经度,纬度)"的数字原样抄进来（形如 104.065861,30.657401）。绝不要传 "LOCATION"、"vehicle.location"、"当前位置" 这类字样——会查到错误城市' },
    },
    handler: 'weatherQuery',
  },

  /* ── 语音 ── */
  {
    name: 'stock.query',
    brief: '查股价指数汇率',
    desc: '查股票/指数/汇率实时行情（腾讯行情，秒级）。query 给名字（"茅台"、"恒生指数"）' +
      '会自动搜索解析；也可直接给代码：A股 sh600519/sz000001，港股 hkHSI，美股 usAAPL，' +
      '汇率 whUSDCNY。结果自动上指标卡，你口头报现价和涨跌就行，不用再建卡。' +
      '多只并列问就并行调多次。',
    permission: '彩',
    fast: true,
    params: {
      query: { type: 'string', required: true, desc: '股票/指数名字或代码' },
    },
    handler: 'stockQuery',
  },
  {
    name: 'holiday.query',
    brief: '查节假日调休',
    desc: '查节假日安排：今天是不是假期/调休班、下一个假期是什么时候、最近哪个周末要补班。' +
      '不用传参数，按当前日期算。',
    permission: '彩',
    params: {},
    handler: 'holidayQuery',
  },
  {
    name: 'poem.today',
    brief: '来一句今日诗词',
    desc: '取一句应景的古诗词（含作者与出处）。适合开机问候、用户想听点有意思的时候。' +
      'message 里就是完整诗句，直接念。',
    permission: '彩',
    params: {},
    handler: 'poemToday',
  },
  {
    name: 'theme.set',
    brief: '切日间/夜间主题',
    fast: true,
    desc: '切换车机屏主题。day 日间浅色 / night 夜间深色。',
    permission: '彩',
    params: {
      mode: { type: 'enum', values: ['day', 'night'], required: true, desc: '日间或夜间' },
    },
    writes: [{ path: 'hmi.theme', from: 'mode' }],
  },
  {
    name: 'wallpaper.set',
    brief: '换壁纸（可 AI 生成）',
    desc: '换车机屏壁纸。source=preset 用内置（name 传 aurora 极光 / dusk 暮色 / forest 山林）；' +
      'source=generate 按 prompt 现场 AI 生成一张（约 0.3 元，用户明确要才用，' +
      '画面描述写清风格，壁纸会自动加暗化保证卡片可读）；source=none 恢复默认。',
    permission: '彩',
    params: {
      source: { type: 'enum', values: ['preset', 'generate', 'none'], required: true, desc: '来源' },
      name: { type: 'enum', values: ['aurora', 'dusk', 'forest'], desc: 'preset 时选哪张' },
      prompt: { type: 'string', desc: 'generate 时的画面描述' },
    },
    handler: 'wallpaperSet',
  },
  {
    name: 'voice.speak',
    brief: '主动播报一句话',
    desc: '通过车内音响向用户播报一段话。用于解释、确认、反馈。',
    mic: true,
    permission: '彩',
    params: {
      text: { type: 'string', required: true, desc: '要播报的内容，口语化、简短' },
      tone: { type: 'enum', values: ['neutral', 'warm', 'urgent'], desc: '语气' },
    },
    handler: 'speak',
  },
  {
    name: 'voice.ask',
    brief: '向用户提问出选择卡',
    desc: '向用户提问并给出候选项，用于消歧或征求选择——不是二次确认（二次确认走返回的 confirmToken，不用这个）。问题和选项会自动显示成屏上的选择卡（带序号），你不用建卡。**它只管上屏，不会替你说话**——问题必须由你在这一轮的回复里亲口问出来。**用户是开车的人，只能用说的回答，不能点屏幕**——所以话术里要说"你说第几个就行/告诉我要哪个"，绝不能说"点一下""你选一个点击"。用户的回答会在下一轮对话里出现。',
    mic: true,
    permission: '彩',
    params: {
      question: { type: 'string', required: true, desc: '问题内容，口语化' },
      options: { type: 'array', items: 'string', desc: '候选项，供确认卡展示' },
    },
    handler: 'ask',
  },
  {
    name: 'voice.config',
    brief: '换朗读音色、调语速',
    desc: '设置语音播报的音色与语速。**先不带参数调一次拿可选音色清单**（含名字和' +
      '男女声标注），再按用户的意思挑一个把 name 一字不差传回来。用户说"换个声音"' +
      '"声音温柔一点""说慢一点"时用它。改完立即生效，不用重启。',
    permission: '彩',
    params: {
      voice: { type: 'string', desc: '音色名，必须来自查询返回的 voices 清单' },
      rate: { type: 'number', range: [0.5, 1.5], desc: '语速倍率，1 是正常，默认 0.92' },
    },
    handler: 'voiceConfig',
  },

  /* ── 卡片调度（无APP化核心） ── */
  /* ══════════ 媒体：传输控制（内容源无关，音乐/电台/视频共用） ══════════ */
  {
    name: 'media.control',
    brief: '播放暂停上下曲',
    fast: true,
    desc: '播放控制：继续/暂停/停止/上一首/下一首。点过歌之后同一批搜索结果就是播放队列，next/prev 沿队列走；放完也会自动播下一首，不用你操心。play 是"恢复当前内容"，想换内容请用 music.play / radio.play / video.play。stop 会把正在放的整个清掉、播放器卡跟着退场，只是想停一下用 pause。',
    permission: '彩',
    params: { action: { type: 'enum', values: ['play', 'pause', 'stop', 'next', 'prev', 'toggle'], required: true, desc: '动作。toggle 是播放/暂停切换（屏幕按钮用它）' } },
    handler: 'mediaControl',
  },
  {
    name: 'media.volume',
    brief: '调音量',
    fast: true,
    desc: '媒体音量。level 传绝对值（0-100），delta 传增减量（"大声点"用 +10 这种）。超出范围会自动夹住而不是报错。',
    permission: '彩',
    params: {
      level: { type: 'number', range: [0, 100], desc: '目标音量' },
      delta: { type: 'number', range: [-100, 100], desc: '相对增减' },
    },
    handler: 'mediaVolume',
  },
  {
    name: 'media.seek',
    brief: '跳播放进度',
    desc: '跳到某个时间点或快进快退。电台是直播流，会返回 rejected。',
    permission: '彩',
    params: {
      position: { type: 'number', range: [0, 86400], desc: '目标秒数' },
      delta: { type: 'number', desc: '相对秒数，快退传负数' },
    },
    handler: 'mediaSeek',
  },
  {
    name: 'media.mode',
    brief: '循环随机播放模式',
    fast: true,
    desc: '播放模式：顺序/随机/单曲循环。电台没有播放模式，会返回 rejected。',
    permission: '彩',
    params: { mode: { type: 'enum', values: ['sequential', 'shuffle', 'repeatOne'], required: true, desc: '模式' } },
    handler: 'mediaMode',
  },
  {
    name: 'media.queue',
    brief: '看播放队列',
    desc: '看播放队列：正在放什么、接下来几首、最近放过什么。点一首歌后同批搜索结果自动排队。',
    permission: '彩',
    params: {},
    handler: 'mediaQueue',
  },
  {
    name: 'media.favorite',
    brief: '收藏当前曲目',
    desc: '收藏正在播的内容。歌和电台存在同一份收藏里，用户说"收藏"不用分类型。',
    permission: '彩',
    params: {},
    handler: 'mediaFavorite',
  },
  {
    name: 'media.favorites',
    brief: '列收藏列表',
    desc: '列出收藏过的内容，列表会自动显示到屏幕上带编号，你说一句"你收藏了几个"就行，别逐条念。',
    permission: '彩',
    params: {},
    handler: 'mediaFavorites',
  },

  /* ══════════ 音乐（iTunes，30 秒预览） ══════════ */
  {
    name: 'music.search',
    brief: '搜歌不播',
    desc: '搜歌。可以搜歌名、歌手、专辑。结果自动上屏带编号，你只说一句"搜到几首"就行，别逐条念。**iTunes 只提供 30 秒预览，放不了整首**，这是版权限制，用户问起来就照实说。',
    permission: '彩',
    params: {
      query: { type: 'string', required: true, desc: '歌名/歌手/专辑，中英文都行' },
      limit: { type: 'number', range: [1, 20], desc: '最多返回几首，默认 8' },
    },
    handler: 'musicSearch',
  },
  {
    name: 'music.play',
    brief: '搜歌并播放入队',
    fast: true,
    desc: '放歌。用户说"放周杰伦的晴天"就直接传 query，不用先 search——搜到会自动播第一首，省一轮。用户从搜索结果里选了第几个，传那一条的 trackId。',
    permission: '彩',
    params: {
      trackId: { type: 'number', desc: 'music.search 返回的 id' },
      query: { type: 'string', desc: '没有 id 时按关键词现搜现播' },
    },
    handler: 'musicPlay',
  },

  /* ══════════ 电台（Radio Browser，全球 5 万+ 台） ══════════ */
  {
    name: 'podcast.search',
    brief: '搜播客节目',
    desc: '搜播客节目（iTunes 目录，覆盖小宇宙/喜马拉雅等主流中文播客的 RSS）。' +
      '结果自动上候选卡。要直接听就用 podcast.play，不用先搜。',
    permission: '彩',
    params: {
      query: { type: 'string', required: true, desc: '节目名或主题关键词' },
    },
    handler: 'podcastSearch',
  },
  {
    name: 'podcast.play',
    brief: '播播客最新一集',
    desc: '搜到就播。默认放最新一集；episode 传 2 表示第二新的一集。' +
      '单集通常几十分钟，是完整内容不是试听。整批单集会入播放队列，"下一集"直接切。',
    permission: '彩',
    fast: true,
    params: {
      query: { type: 'string', desc: '节目名，如"故事FM"' },
      showId: { type: 'number', desc: 'podcast.search 结果里的节目 id（有就优先用）' },
      episode: { type: 'number', desc: '第几新的一集，默认 1（最新）' },
    },
    handler: 'podcastPlay',
  },
  {
    name: 'radio.search',
    brief: '搜网络电台',
    desc: '找电台。可以按台名搜，也可以按分类（news/jazz/pop/classical/talk 这类英文 tag）、国家、语言筛。结果自动上屏带编号，你说一句"找到几个"就行。注意：只返回加密流的台，有些台因为用不加密的流放不了，这是车机的限制。',
    permission: '彩',
    params: {
      query: { type: 'string', desc: '台名，比如"中国之声"' },
      category: { type: 'string', desc: '英文分类 tag，如 news / jazz / pop / classical' },
      country: { type: 'string', desc: '国家英文名，如 China' },
      language: { type: 'string', desc: '语言英文名，如 chinese' },
      limit: { type: 'number', range: [1, 20], desc: '最多返回几个，默认 10' },
    },
    handler: 'radioSearch',
  },
  {
    name: 'radio.play',
    brief: '搜台并播放',
    fast: true,
    desc: '放电台。用户说"放中国之声"直接传 query，不用先 search。从搜索结果里选的传 stationId。',
    permission: '彩',
    params: {
      stationId: { type: 'string', desc: 'radio.search 返回的 id' },
      query: { type: 'string', desc: '没有 id 时按台名现搜现播' },
    },
    handler: 'radioPlay',
  },

  /* ══════════ 新闻（NewsAPI） ══════════ */
  {
    name: 'news.headlines',
    brief: '今日头条新闻',
    fast: true,
    desc: '看某个领域的最新新闻。**中文拿不到编辑推荐的头条**（数据源限制），返回的是按关键词搜、按时间排的最新几条，返回里的 real=false 就是这个意思——播报时说"我给你找了今天的科技新闻"，**不要说"这是今天的头条"**。列表自动上屏带编号，你说一句有几条就行，别逐条念标题。',
    permission: '彩',
    params: {
      category: { type: 'enum', values: ['general', 'technology', 'business', 'sports', 'entertainment', 'health', 'science'], desc: '领域，默认 general' },
      language: { type: 'enum', values: ['zh', 'en'], desc: '语言，默认 zh' },
    },
    handler: 'newsHeadlines',
  },
  {
    name: 'news.search',
    brief: '按话题搜新闻',
    fast: true,
    desc: '按关键词搜新闻。列表自动上屏带编号。',
    permission: '彩',
    params: {
      query: { type: 'string', required: true, desc: '关键词' },
      language: { type: 'enum', values: ['zh', 'en'], desc: '语言，默认 zh' },
    },
    handler: 'newsSearch',
  },
  {
    name: 'news.read',
    brief: '念一条新闻正文',
    desc: '把列表里第几条的正文取出来念给用户听——车机场景是听不是看，用户说"读第二条"就用这个。要先调过 headlines 或 search 才有列表。',
    permission: '彩',
    params: { index: { type: 'number', range: [1, 20], required: true, desc: '第几条，从 1 开始' } },
    handler: 'newsRead',
  },

  /* ══════════ 短视频（Pexels） ══════════ */
  {
    name: 'video.search',
    brief: '搜短视频',
    desc: '找短视频。素材库风格（风景、城市、动物、美食这类），**不是社交平台的推荐流**，没有点赞评论。用英文关键词命中率高得多。结果自动上屏带编号。',
    permission: '彩',
    params: {
      query: { type: 'string', required: true, desc: '关键词，英文命中率更高，如 city drive / cat / cooking' },
      limit: { type: 'number', range: [1, 15], desc: '最多几条，默认 8' },
    },
    handler: 'videoSearch',
  },
  {
    name: 'video.play',
    brief: '搜视频并播放',
    fast: true,
    desc: '播短视频。**车一动就会被拒**（行车安全），拒绝时把原因和替代方案告诉用户——可以改放音乐或电台。用户说"放个视频"直接传 query 即可。',
    permission: '彩',
    params: {
      videoId: { type: 'number', desc: 'video.search 返回的 id' },
      query: { type: 'string', desc: '没有 id 时按关键词现搜现播' },
    },
    handler: 'videoPlay',
  },

  /* ══════════ 联网搜索 ══════════ */
  {
    name: 'video.generate',
    brief: 'AI 生成一段视频',
    desc: '按描述生成一段短视频（约 5 秒，Seedance 等模型）。异步的：调完立刻返回，' +
      '一两分钟后生成完会自动开始播放，你先告诉用户在做了。行驶中不会弹画面（安全约束）。' +
      '花真钱（约 1-2 元/条），用户没明确要生成视频就别调。',
    permission: '彩',
    params: {
      prompt: { type: 'string', required: true, desc: '画面描述，说清主体/动作/风格' },
      duration: { type: 'number', desc: '时长秒数，默认 5' },
      ratio: { type: 'enum', values: ['16:9', '9:16', '1:1'], desc: '画幅，默认 16:9' },
    },
    handler: 'videoGenerate',
  },
  {
    name: 'music.generate',
    brief: 'AI 写一段音乐',
    desc: '按描述生成一段 30 秒音乐（Lyria，48kHz 立体声，可含人声）。生成完直接开始播放。' +
      '描述里可以给风格、心情、场景，比如"给孩子的轻快生日歌，唱到妞妞的名字"。' +
      '花真钱（约 3 毛/段），用户没明确要就别调。',
    permission: '彩',
    params: {
      prompt: { type: 'string', required: true, desc: '想要什么样的音乐' },
      instrumental: { type: 'boolean', desc: 'true = 纯音乐不要人声' },
    },
    handler: 'musicGenerate',
  },
  {
    name: 'web.search',
    brief: '联网搜索现查',
    // 每次搜索 15 秒起——问句写全一次问够，别拆成三四次搜（用户在车里等不起）
    desc: '联网查东西。车里的知识、新闻之外的实时信息、你不确定的事实，都用这个而不是凭记忆答。结果会上屏，用户能回看数字和人名。**每次搜索要 15 秒起步——把问句写全（对象+时间范围+要什么数据）一次问够，别拆成几次搜，用户在车里等不起。**返回的答案往往很长，别整段念——挑一两句最关键的说，剩下的让用户看屏幕。每次调用都会花钱，别为了闲聊或者你本来就知道的常识调它。',
    permission: '彩',
    params: { query: { type: 'string', required: true, desc: '要查的问题，一句话说清' } },
    handler: 'webSearch',
  },

  {
    name: 'card.show',
    brief: '建卡片上屏',
    desc: '在桌面 Agent 区新建一张卡片。先用 desktop.getLayout 看桌面上有没有现成的卡可以复用——已有就用 card.update，尺寸不够就用 card.resize，都不行才新建。',
    permission: '彩',
    params: {
      template: {
        type: 'enum', values: TEMPLATE_IDS, required: true,
        // 模板说明书必须随 schema 到达模型——之前这里只有"卡片模板"三个字，
        // canvas 的 html/text 契约和像素画布模型根本看不到，等于模板不存在
        // （实拍：调研报告没走生成式卡）。systemOnly 的不教——模型建不了
        desc: '卡片模板。各模板用途与 data 形状：\n' + CARD_TEMPLATES
          .filter(t => !t.systemOnly)
          .map(t => `- ${t.id}：${t.desc}`)
          .join('\n'),
      },
      size: {
        type: 'enum', values: [...ALL_SIZES], required: true,
        desc: '尺寸，从小到大：chip 一个数字（车速、电量这种）/ strip 一行字 / bar 一行字加条进度 / ' +
          '1/6 基准卡（天气、单条反馈）/ wide 略宽 / 1/3 两格 / 1/2 整行 / ' +
          '2/3 左侧大方块（地图专用）/ full 全屏（临时征用，关闭后自动还原）。' +
          '**桌面挤的时候小档位很有用**：一张 chip 只占 1/24 屏，够写清"还在放什么歌"，' +
          '比整张卡被收起来强。每个模板有自己的可用档位，用不了会告诉你支持哪些。',
      },
      ttl: {
        type: 'string', required: true,
        desc: '这张卡该活多久。' +
          '**默认用 untilDismissed**（一直留着，桌面满了会自动腾位）—— 天气、续航、' +
          '播放器、执行结果这类"看一眼就知道"的内容都用它，别给它们设秒数，' +
          '用户还在看的时候卡片自己消失是最招人烦的事。' +
          '只有**在等用户回应**的卡才设秒数：你问了"要哪个"、"确认吗"，' +
          '而用户可能压根不打算答 —— 挂在那儿就是一直在问一个他早就跳过的问题。' +
          '这种给 20~60 秒，问句越短给得越少。' +
          '另外还有 untilTaskEnd（本轮任务一结束就退，适合中间步骤的临时提示）' +
          '和 persistent（常驻，几乎用不到）。',
      },
      /**
       * key 一直是声明着的，但原描述只说「逻辑标识，如 windows、nav。同 key 的卡
       * 会被复用」—— 模型读不出"我重排报告时该复用它"。实拍后果：子 Agent
       * 因为内容溢出反复重排，每次建新卡，屏幕上堆了 6 张同一份报告的不同版本
       * （用户原话"满屏幕都是"）。**说清什么时候该用，比有这个参数更重要。**
       */
      key: { type: 'string',
        desc: '这张卡的身份。**同一份内容改版、重排、换尺寸重发时必须用同一个 key**，' +
          '屏幕上就是刷新那一张而不是再堆一张 —— 不给 key 每次都是新卡，' +
          '试排几次桌面就满了。上下两篇、左右两栏这种真的是两张，才给不同的 key。' +
          '常规用法同理：windows、nav 这类固定内容一直用同一个 key。' },
      data: { type: 'object', desc: '卡片内容，字段取决于模板' },
      kind: { type: 'enum', values: ['task', 'system'], desc: '卡片类别，默认 task' },
      urgency: {
        type: 'enum', values: ['ambient', 'normal', 'urgent', 'critical'],
        desc: '这事有多急，默认 normal。ambient 背景信息（可以被挤掉）/ normal 常规 / urgent 等着用户回应（不会被挤掉）/ critical 安全相关（不会被挤掉，也不会被缩小，会盖住整屏）。别为了让卡活得久就往高了报——真出安全事件时就没有更高一档了。',
      },
    },
    handler: 'cardShow',
  },
  {
    name: 'card.update',
    brief: '更新卡片数据',
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
    brief: '调卡片大小',
    desc: '改变卡片尺寸。空间不够时系统会自动腾位。',
    permission: '彩',
    params: {
      cardId: { type: 'string', required: true, desc: '卡片 id' },
      size: {
        type: 'enum', values: [...ALL_SIZES.filter(z => z !== 'full')], required: true,
        desc: '目标尺寸（chip 最小 → 2/3 最大）。每张卡只接受自己模板声明过的那几种，改不了的会告诉你支持哪些',
      },
    },
    handler: 'cardResize',
  },
  {
    name: 'card.dismiss',
    brief: '撤掉卡片',
    desc: '移除一张卡片。',
    permission: '彩',
    params: { cardId: { type: 'string', required: true, desc: '卡片 id' } },
    handler: 'cardDismiss',
  },
  {
    name: 'card.focus',
    brief: '高亮提示一张卡',
    desc: '把卡片提到主位并高亮，同时刷新它的活跃时间，避免被挤掉。**排在台下（桌面满时的等位区）的卡 focus 即召回**：立即上台，必要时挤走不重要的——用户说"看天气/把XX调出来"就 getLayout 找到 staged 里的 id 然后 focus 它。',
    permission: '彩',
    params: { cardId: { type: 'string', required: true, desc: '卡片 id' } },
    handler: 'cardFocus',
  },
  {
    name: 'desktop.getLayout',
    brief: '读桌面布局',
    desc: '读取当前桌面布局：有哪些卡片、多大、还剩几格。编排卡片前先看这个。导航卡等基础卡片由系统按状态自动管理，你只需要为搜索候选、临时提醒这类内容建卡。返回里的 staged 是台下排队的卡（桌面满时不消失，排队等空位）——召回用 card.focus。',
    permission: '彩',
    params: {},
    handler: 'deskLayout',
  },
  // 2026-08-10 卡片编排重设计：无常驻卡、无固定区，desktop.pin/unpin 暂时移除。
  // 后续引入常驻卡时恢复（语义改为"标记为常驻"而非"移区"），保留灰级确认。

  /* ── 黑级：永久禁区，配置里存在但永不暴露给 Agent ── */
  {
    name: 'brake.apply',
    desc: '施加制动力。',
    permission: '黑',
    params: { force: { type: 'number', range: [0, 1], required: true, desc: '制动力度' } },
  },
  /* ══════════ 记忆（显式，长期） ══════════ */
  {
    name: 'automation.create',
    brief: '建自动任务（情景模式）',
    desc: '把用户的自动化意愿建成规则："每天下午四点开空调""下雨自动关窗""我说跑晨报就跑晨报"。' +
      'when 是触发条件（空数组=手动任务，靠说话或点卡片运行）；do 是动作序列——' +
      '车控查询用 {tool,args}（机制直接执行），需要你临场判断的用 {prompt}（到时会叫醒你处理，' +
      '如"推荐当天值得关注的股票"）。ask:true 表示执行前先问用户。建好自动上卡，用户能看到你理解成了什么。',
    permission: '彩',
    params: {
      name: { type: 'string', required: true, desc: '任务名，短一点，如"雨天模式"' },
      when: { type: 'array', desc: '触发条件（全部满足才触发；空=手动任务）',
        items: { type: 'object', properties: {
          kind: { type: 'string', enum: ['time', 'signal'] },
          at: { type: 'string', description: 'kind=time 时的每天时刻，HH:MM' },
          path: { type: 'string', description: 'kind=signal 时的信号路径，如 vehicle.gear' },
          op: { type: 'string', enum: ['==', '!=', '>', '<', '>=', '<='] },
          value: { description: '比较值' },
        }, required: ['kind'] } },
      do: { type: 'array', required: true, desc: '动作序列，按顺序执行',
        items: { type: 'object', properties: {
          tool: { type: 'string', description: '工具名（车控/查询这类确定动作）' },
          args: { type: 'object', description: '工具参数' },
          prompt: { type: 'string', description: '或者：到时叫醒你处理的一句话任务' },
        } } },
      ask: { type: 'boolean', desc: '触发时先弹确认，用户点了才执行' },
    },
    handler: 'automationCreate',
  },
  {
    name: 'automation.list',
    brief: '看已有的自动任务',
    desc: '列出全部自动任务并上卡。data.rules 就是任务码（JSON），用户要"分享/导出"时念给他或建卡展示。',
    permission: '彩',
    params: {},
    handler: 'automationList',
  },
  {
    name: 'automation.toggle',
    brief: '启停自动任务',
    desc: '启用/停用一条自动任务。不传 on 就翻转当前状态（卡片上点一下走的就是这条）。',
    permission: '彩',
    params: {
      id: { type: 'string', desc: '任务 id' },
      name: { type: 'string', desc: '或者用任务名找' },
      on: { type: 'boolean', desc: '开或关；不传=翻转' },
    },
    handler: 'automationToggle',
  },
  {
    name: 'automation.delete',
    brief: '删自动任务',
    desc: '删除一条自动任务。',
    permission: '彩',
    params: {
      id: { type: 'string', desc: '任务 id' },
      name: { type: 'string', desc: '或者用任务名找' },
    },
    handler: 'automationDelete',
  },
  {
    name: 'automation.run',
    brief: '立即运行一条任务',
    desc: '手动执行一条任务（多用于无条件的手动任务；ask 类任务用户确认后也用它跑）。',
    permission: '彩',
    params: {
      id: { type: 'string', desc: '任务 id' },
      name: { type: 'string', desc: '或者用任务名找' },
    },
    handler: 'automationRun',
  },
  {
    name: 'memory.remember',
    brief: '记住用户偏好',
    desc: '用户说"记住…""以后都…"这类长期偏好时调用，存成一条文本。存完要向用户复述确认。' +
      '只记**用户明说要记**的；你自己猜的规律不许存。这些偏好每次对话都会注入给你，落实靠你自己。',
    permission: '彩',
    params: { text: { type: 'string', required: true, desc: '一句话的偏好，如"空调默认 24 度""出风别对着脸吹"' } },
    handler: 'memoryRemember',
  },
  {
    name: 'memory.forget',
    brief: '删掉记住的偏好',
    desc: '用户说"别记了""把那条删了"时调用，按内容片段模糊匹配删除。',
    permission: '彩',
    params: { text: { type: 'string', required: true, desc: '要删的偏好的关键词' } },
    handler: 'memoryForget',
  },
  {
    name: 'memory.list',
    brief: '列出记住的事',
    desc: '用户问"你记住了什么"时调用，清单会上屏。',
    permission: '彩',
    params: {},
    handler: 'memoryList',
  },
  /* ══════════════ 路上的故事：AI 儿童有声绘本（2026-08-14） ══════════════
   *
   * 六个 Tool 只做**机制**：存档案、画定妆、生成一章、成书、导出。
   * 每章几页、什么时候该问孩子、快到站怎么收尾 —— 全是**章法**，
   * 归模型按技能包决定，所以页数是参数不是常量。
   * 代码里出现 `if (chapter === 1) pages = 3` 就是把策略写进了机制。
   */
  {
    name: 'story.profile',
    brief: '记下孩子的名字年龄和这次想讲明白的道理',
    desc: '建立或更新孩子档案。家长不该每次填表——一次录入，之后每次只说一句' +
      '「给妞妞讲个关于分享的故事」就够。lesson 是家长真正在意的字段：' +
      '分享、勇敢、刷牙、不怕黑、交通安全（最后这个在车里讲场景绝配）。',
    permission: '彩',
    params: {
      name: { type: 'string', desc: '孩子怎么称呼' },
      age: { type: 'number', desc: '几岁——决定用词深浅和故事长度' },
      interests: { type: 'array', desc: '喜欢什么，如 ["小熊","下雨天"]，写进故事让它贴着孩子来' },
      lesson: { type: 'string', desc: '这次想讲明白的道理' },
    },
    handler: 'storyProfile',
  },
  {
    name: 'story.cast',
    brief: '把孩子的照片画成故事主角',
    desc: '按家长给的照片生成一张动漫版**定妆照**。' +
      '**画完就停下来问「像不像」，不要接着调 story.begin** —— 这是全书唯一' +
      '需要家长把关的一步：之后每一页都拿这张当参考图，主角不像就是整本都不像，' +
      '而一本要画七八张。屏幕上有「就是他」和「再画一张」两个按钮，' +
      '家长点了或者开口说了你才往下走。' +
      '它也是角色一致性的锚：每页锚在同一张上（**不是拿上一页**），' +
      '所以误差不累积、某页画歪单页重画就行。' +
      'style 默认扁平童书风——写实风细节多、跨页漂移大，这不只是审美选择。',
    permission: '彩',
    params: {
      look: { type: 'string', required: true,
        desc: '锁死的形象不变量，如「短发、齐刘海、黄色连衣裙、5 岁女孩」。' +
          '这几条会写进每一页的提示词，别每次换说法' },
      style: { type: 'string', desc: '画风，默认「扁平矢量童书插画，柔和暖色」' },
    },
    handler: 'storyCast',
  },
  {
    name: 'story.begin',
    brief: '开一本新绘本，讲第一章',
    desc: '按主题开篇。**必须等家长认可定妆照之后再调。**' +
      '**pages 必须给满 3 条**——刚好够「谁·在哪·出事了」一个完整的开头，' +
      '把孩子拉进去；只给 1 条等于开了个头就没了，孩子还没进入故事就要被追问。' +
      '每页一到两句话（约 25–45 字）配一张插图，插图后台并发画、到位了屏幕自己开口。' +
      '**调完之后只说一句衔接的话，不要把 line 的内容再念一遍** —— ' +
      '屏幕会逐页朗读并逐字点亮，你抢着念等于同一段讲两遍，而且你几秒就念完了插图还在画。' +
      '把车窗外的真实世界织进故事（正在过的桥、外面的天气、要去的地方）——' +
      '孩子抬头看窗外故事和现实对上了，这是手机上的绘本做不到的事。' +
      '讲完这一章系统会自动问孩子「你觉得后面会发生什么」。',
    permission: '彩',
    params: {
      title: { type: 'string', required: true, desc: '书名' },
      pages: { type: 'array', required: true,
        /**
         * 元素形状必须是**机器可读**的。只声明"是个数组"时实拍看到模型
         * 连着猜错两次（`pageCount:"3"`、`pages:{item:[...]}`），第三次才蒙对 ——
         * 三次调用两次被拒，用户干等。
         */
        items: {
          type: 'object',
          properties: {
            line: { type: 'string', description: '念给孩子听的一句话，一屏一句，别写成一段' },
            scene: { type: 'string', description: '这一页画什么，一句画面描述即可；主角形象不用重复写，系统会带上定妆照' },
          },
          required: ['line', 'scene'],
        },
        desc: '这一章的页，**第一章必须给满 3 条**。每条 {line, scene}' },
    },
    handler: 'storyBegin',
  },
  {
    name: 'story.continue',
    brief: '接着孩子说的往下写一章',
    desc: '按孩子刚才说的续写。**每章给 2 页**——2 页约 40 秒，孩子的注意力刚好在这个尺度上，' +
      '问得太晚他已经跑神了。先复述一遍孩子的想法再往下编（「哇，会飞的自行车！」——' +
      '让他知道被听见了，这一秒比什么都重要），idea 会记进书里，导出的封底要单列出来。' +
      '复述完就交给屏幕，**正文不要自己念**。',
    permission: '彩',
    params: {
      idea: { type: 'string', required: true, desc: '孩子说了什么，原话记下来' },
      pages: { type: 'array', required: true,
        items: {
          type: 'object',
          properties: {
            line: { type: 'string', description: '念给孩子听的一句话，一屏一句' },
            scene: { type: 'string', description: '这一页画什么，一句画面描述即可' },
          },
          required: ['line', 'scene'],
        },
        desc: '这一章的页，**给满 2 条**。每条 {line, scene}' },
    },
    handler: 'storyContinue',
  },
  {
    name: 'story.finish',
    brief: '收尾成书',
    desc: '孩子说「结束吧/不玩了/就到这儿」，或者快到站了，就收尾。' +
      'ending 是最后一页，要给个像样的结局别硬停。收完会出成书页，家长可以导出。',
    permission: '彩',
    params: {
      ending: { type: 'string', required: true, desc: '结尾那一句' },
      scene: { type: 'string', desc: '结尾这一页画什么' },
    },
    handler: 'storyFinish',
  },
  {
    name: 'story.export',
    brief: '把这本书做成可以发给别人的网页',
    desc: '导出成**自包含的 H5 单文件**：图片全部内嵌，双击就能打开，不用网。' +
      '这是家长真正会转发给爷爷奶奶的东西——车上的体验是过程，它才是留下来的。',
    permission: '彩',
    params: {},
    handler: 'storyExport',
  },
  {
    name: 'story.page',
    brief: '翻页/暂停（屏幕按钮直调，不叫醒模型）',
    desc: '绘本卡上的翻页与暂停。用户点屏幕时手势层直调这个，不进对话。',
    permission: '彩',
    params: { dir: { type: 'enum', values: ['prev', 'next', 'toggle'], required: true, desc: '往哪翻' } },
    handler: 'storyPage',
  },
]
/**
 * 能力目录的**给人看的那一面**。目录卡上的条目是能力域（车窗/空调/导航……），
 * 用语言 + icon 介绍——函数名是模型和平台之间的接口，不是给用户看的
 * （实拍反馈："现在感觉像个工程化界面"）。
 *
 * match 是 Tool 名前缀：加一个新 Tool 时若前缀已在表里，目录自动长出来；
 * 前缀不在表里则默默不进目录——card / voice / desktop 这类管道工具正好被筛掉。
 */
export const CAPABILITY_DOMAINS: Array<{ match: string[]; icon: string; label: string; blurb: string }> = [
  { match: ['window'], icon: '🪟', label: '车窗', blurb: '四扇窗独立开合，说"开一半"也行' },
  { match: ['climate'], icon: '❄️', label: '空调', blurb: '温度、风量、出风口，冷了热了直接说' },
  { match: ['seat', 'steeringWheel'], icon: '💺', label: '座椅方向盘', blurb: '加热、通风、按摩、前后与靠背，方向盘也能热' },
  { match: ['sunroof'], icon: '🌅', label: '天窗', blurb: '玻璃开合，遮阳帘也能单独拉' },
  { match: ['mirror'], icon: '🪞', label: '后视镜', blurb: '折叠收起、镜面加热除雾' },
  { match: ['voice'], icon: '🗣️', label: '语音', blurb: '换播报音色（有男女声可挑）、调语速' },
  { match: ['airPurifier'], icon: '🌀', label: '空气净化', blurb: '外面味儿大时开一下' },
  { match: ['door', 'trunk', 'chargePort', 'childLock'], icon: '🚪', label: '门与舱口', blurb: '车门、后备箱、充电口、儿童锁' },
  { match: ['ambientLight', 'fragrance', 'light'], icon: '💡', label: '灯光香氛', blurb: '氛围灯、香氛、近光远光雾灯示宽灯、前后排阅读灯' },
  { match: ['wiper'], icon: '🌧️', label: '雨刷', blurb: '手动挡位或自动感应' },
  { match: ['driveSetting'], icon: '🎛️', label: '驾驶设置', blurb: '驾驶模式、能量回收、悬架高度' },
  { match: ['navigation', 'region', 'places'], icon: '🧭', label: '导航', blurb: '找地方、规划对比路线、沿途搜索、常用地址、地图缩放全览' },
  { match: ['weather'], icon: '🌤️', label: '天气', blurb: '查任何城市的现在和未来几天' },
  { match: ['music'], icon: '🎵', label: '音乐', blurb: '搜歌放歌，自动接着放下一首' },
  { match: ['radio'], icon: '📻', label: '电台', blurb: '全球网络电台想听哪台搜哪台' },
  { match: ['news'], icon: '📰', label: '新闻', blurb: '今日头条、按话题搜、念给你听' },
  { match: ['video'], icon: '🎬', label: '视频', blurb: '短视频，行驶中会自动只留声音' },
  { match: ['media'], icon: '🎚️', label: '播放控制', blurb: '换曲、音量、进度、收藏，通用于音乐电台' },
  { match: ['web'], icon: '🔍', label: '联网搜索', blurb: '答不上来的现查' },
  { match: ['memory'], icon: '🧠', label: '记忆', blurb: '"记住我喜欢 24 度"，下次直接照做' },
]
