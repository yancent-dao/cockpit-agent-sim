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
  /** 依赖的信号：该信号 equipped=false 时，能力目录里此 Tool 标记为未选装 */
  requires?: string
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

  /* ── 能力目录：由 Tool Registry 自动生成，供能力目录卡渲染 ── */
  {
    name: 'capability.list',
    desc: '把本车能力清单显示到屏幕上（全屏能力目录卡），并返回清单数据。**这是唯一能让用户在屏幕上看到能力清单的方式**——你自己凭记忆背清单，用户屏幕上什么都不会出现，而且容易背漏或背错。所以只要用户问"你能做什么/会啥/帮我干嘛"，先调它，再口头概括一两句。调用后不要再说"屏幕上已显示"之类的话除非你真的调过它。不传 domain 返回全部；传 domain 只看某一类（如 window、card）。',
    permission: '彩',
    params: {
      domain: { type: 'string', desc: '按能力名前缀过滤，如 "window" 只看车窗相关能力' },
    },
    handler: 'capabilityList',
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
    writes: [{ path: 'cabin.window.{window}.position', from: 'position' }],
    expand: { window: { all: ['driver', 'passenger', 'rearLeft', 'rearRight'] } },
    escalate: [{ when: ['vehicle.speed', '>', 5], to: '灰' }],
    confirmPrompt: '车辆正在行驶，确认要调整车窗吗？',
  },

  /* ── 空调（v0.1 简化：单分区，不做左右独立温区） ── */
  {
    name: 'climate.set',
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
    desc: '控制座椅。seat 传 all 可一次控制四个座椅（仅对加热/通风生效，滑动和靠背只有前排有）。可以一次传多个字段，只传要改的即可。',
    permission: '彩',
    params: {
      seat: {
        type: 'enum', values: ['driver', 'passenger', 'rearLeft', 'rearRight', 'all'],
        required: true, desc: '目标座椅',
      },
      heating: { type: 'number', range: [0, 3], desc: '加热档位 0-3' },
      ventilation: { type: 'number', range: [0, 3], desc: '通风档位 0-3' },
      slide: { type: 'number', range: [0, 100], desc: '前后位置百分比，仅前排' },
      recline: { type: 'number', range: [0, 100], desc: '靠背角度百分比，仅前排' },
    },
    writes: [
      { path: 'seat.{seat}.heating', from: 'heating' },
      { path: 'seat.{seat}.ventilation', from: 'ventilation' },
      { path: 'seat.{seat}.slide', from: 'slide' },
      { path: 'seat.{seat}.recline', from: 'recline' },
    ],
    expand: { seat: { all: ['driver', 'passenger', 'rearLeft', 'rearRight'] } },
  },

  /* ── 方向盘 ── */
  {
    name: 'steeringWheel.set',
    desc: '控制方向盘加热档位。',
    permission: '彩',
    params: { heating: { type: 'number', range: [0, 3], required: true, desc: '加热档位 0-3' } },
    writes: [{ path: 'cabin.steeringWheel.heating', from: 'heating' }],
  },

  /* ── 天窗：未选装，用于反幻觉验证 ── */
  {
    name: 'sunroof.set',
    desc: '控制全景天窗开度。',
    permission: '彩',
    params: { position: { type: 'number', range: [0, 100], required: true, desc: '开度百分比 0-100' } },
    writes: [{ path: 'cabin.sunroof.glass.position', from: 'position' }],
    requires: 'cabin.sunroof.glass.position',
  },

  /* ── 车门：灰级，需二次确认 ── */
  {
    name: 'door.set',
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
    desc: '开关充电口盖。',
    permission: '彩',
    params: { action: { type: 'enum', values: ['open', 'close'], required: true, desc: '动作' } },
    writes: [{ path: 'cabin.chargePort.isOpen', from: 'action', map: { open: true, close: false } }],
  },

  /* ── 儿童锁 ── */
  {
    name: 'childLock.set',
    desc: '开关后排儿童锁。开启后后排车窗与车门将无法控制。',
    permission: '彩',
    params: { enabled: { type: 'boolean', required: true, desc: '是否开启' } },
    writes: [{ path: 'cabin.childLock', from: 'enabled' }],
  },

  /* ── 氛围灯（v0.1 简化：整车一个分区，不做前后独立） ── */
  {
    name: 'ambientLight.set',
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
    desc: '开关车灯。',
    permission: '彩',
    params: {
      light: { type: 'enum', values: ['headlight', 'trunkLight'], required: true, desc: '目标灯具' },
      state: { type: 'enum', values: ['on', 'off', 'auto'], required: true, desc: '状态' },
    },
    writes: [{ path: 'cabin.light.{light}.state', from: 'state' }],
  },

  /* ── 驾驶设置：灰级（行驶中） ── */
  {
    name: 'driveSetting.set',
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
    desc: '设置导航目的地并规划路线，调用成功后导航自动开始，导航卡会由系统自动出现在桌面上——你不需要也不应该再调 card.show 或 navigation.control 的 start。poiId（来自 navigation.search 的结果）和 address 二选一传。',
    permission: '彩',
    params: {
      alias: { type: 'string', desc: '常用地址别名，如"家""公司"。用户说"回家"时优先用这个，不用再搜' },
      poiId: { type: 'string', desc: 'navigation.search 返回的 POI id' },
      address: { type: 'string', desc: '地址或地点名称，没有 alias/poiId 时用这个' },
      preference: { type: 'enum', values: ['default', 'fastest', 'avoidHighway', 'avoidCongestion', 'avoidToll'], desc: '路线偏好，默认 default' },
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
    desc: '看看存了哪些常用地址。用户说"回家""去公司"而你不确定存没存时，先查这个。',
    permission: '彩',
    params: {},
    handler: 'placesList',
  },
  {
    name: 'navigation.searchAlong',
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
    desc: '控制导航会话：resume 从暂停恢复/pause 暂停/cancel 取消。start 一般用不上——navigation.setDestination 成功后会自动开始导航；只有目的地已经设过、又被 pause 了，现在要重新开始，才需要用 start（或者干脆用 resume，效果一样）。',
    permission: '彩',
    params: {
      action: { type: 'enum', values: ['start', 'resume', 'pause', 'cancel'], required: true, desc: '动作' },
    },
    handler: 'navControl',
  },
  {
    name: 'navigation.getStatus',
    desc: '读取当前导航状态：是否在导航、目的地、ETA、剩余里程、电量是否够到达。导航中时会附带 traffic（实时路况），拿不到就没有这个字段，不代表出错。',
    permission: '彩',
    params: {},
    handler: 'navGetStatus',
  },

  /* ── L2 应用级：天气（真实接高德） ── */
  {
    name: 'weather.query',
    desc: '查询某个地点的天气，同时返回实况与未来几天预报。查询成功后天气卡会自动显示在屏幕上，你只负责口头播报重点，不要再建卡。查不到这个地点时会得到 unavailable。',
    permission: '彩',
    params: {
      location: { type: 'string', required: true, desc: '地点名称，如"北京"、"望京"' },
    },
    handler: 'weatherQuery',
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
  {
    name: 'voice.ask',
    desc: '向用户提问并给出候选项，用于消歧或征求选择——不是二次确认（二次确认走返回的 confirmToken，不用这个）。问题和选项会自动显示成屏上的选择卡（带序号），你不用建卡。**它只管上屏，不会替你说话**——问题必须由你在这一轮的回复里亲口问出来。**用户是开车的人，只能用说的回答，不能点屏幕**——所以话术里要说"你说第几个就行/告诉我要哪个"，绝不能说"点一下""你选一个点击"。用户的回答会在下一轮对话里出现。',
    permission: '彩',
    params: {
      question: { type: 'string', required: true, desc: '问题内容，口语化' },
      options: { type: 'array', items: 'string', desc: '候选项，供确认卡展示' },
    },
    handler: 'ask',
  },

  /* ── 卡片调度（无APP化核心） ── */
  /* ══════════ 媒体：传输控制（内容源无关，音乐/电台/视频共用） ══════════ */
  {
    name: 'media.control',
    desc: '播放控制：继续/暂停/停止/上一首/下一首。跟正在放的是什么无关。注意 play 是"恢复当前内容"，想换内容请用 music.play / radio.play / video.play。stop 会把正在放的整个清掉、播放器卡跟着退场，只是想停一下用 pause。',
    permission: '彩',
    params: { action: { type: 'enum', values: ['play', 'pause', 'stop', 'next', 'prev'], required: true, desc: '动作' } },
    handler: 'mediaControl',
  },
  {
    name: 'media.volume',
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
    desc: '播放模式：顺序/随机/单曲循环。电台没有播放模式，会返回 rejected。',
    permission: '彩',
    params: { mode: { type: 'enum', values: ['sequential', 'shuffle', 'repeatOne'], required: true, desc: '模式' } },
    handler: 'mediaMode',
  },
  {
    name: 'media.queue',
    desc: '看接下来要播什么。这台车一次只放一首，所以基本都会告诉你没有播放列表。',
    permission: '彩',
    params: {},
    handler: 'mediaQueue',
  },
  {
    name: 'media.favorite',
    desc: '收藏正在播的内容。歌和电台存在同一份收藏里，用户说"收藏"不用分类型。',
    permission: '彩',
    params: {},
    handler: 'mediaFavorite',
  },
  {
    name: 'media.favorites',
    desc: '列出收藏过的内容，列表会自动显示到屏幕上带编号，你说一句"你收藏了几个"就行，别逐条念。',
    permission: '彩',
    params: {},
    handler: 'mediaFavorites',
  },

  /* ══════════ 音乐（iTunes，30 秒预览） ══════════ */
  {
    name: 'music.search',
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
    name: 'radio.search',
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
    desc: '把列表里第几条的正文取出来念给用户听——车机场景是听不是看，用户说"读第二条"就用这个。要先调过 headlines 或 search 才有列表。',
    permission: '彩',
    params: { index: { type: 'number', range: [1, 20], required: true, desc: '第几条，从 1 开始' } },
    handler: 'newsRead',
  },

  /* ══════════ 短视频（Pexels） ══════════ */
  {
    name: 'video.search',
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
    desc: '播短视频。**车一动就会被拒**（行车安全），拒绝时把原因和替代方案告诉用户——可以改放音乐或电台。用户说"放个视频"直接传 query 即可。',
    permission: '彩',
    params: {
      videoId: { type: 'number', desc: 'video.search 返回的 id' },
      query: { type: 'string', desc: '没有 id 时按关键词现搜现播' },
    },
    handler: 'videoPlay',
  },

  {
    name: 'card.show',
    desc: '在桌面 Agent 区新建一张卡片。先用 desktop.getLayout 看桌面上有没有现成的卡可以复用——已有就用 card.update，尺寸不够就用 card.resize，都不行才新建。',
    permission: '彩',
    params: {
      template: { type: 'enum', values: TEMPLATE_IDS, required: true, desc: '卡片模板' },
      size: { type: 'enum', values: ['1/6', '1/3', '1/2', '2/3', 'full'], required: true, desc: '尺寸：1/6 单格 / 1/3 两格 / 1/2 整行 / 2/3 左侧大方块（地图专用）/ full 全屏（临时征用，关闭后自动还原）。每个模板有自己的可用档位，用不了会告诉你支持哪些。' },
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
      size: { type: 'enum', values: ['1/6', '1/3', '1/2', '2/3'], required: true, desc: '目标尺寸。每张卡只接受自己模板声明过的那几种，改不了的会告诉你支持哪些' },
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
    desc: '读取当前桌面布局：有哪些卡片、多大、还剩几格。编排卡片前先看这个。导航卡等基础卡片由系统按状态自动管理，你只需要为搜索候选、临时提醒这类内容建卡。',
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
]
