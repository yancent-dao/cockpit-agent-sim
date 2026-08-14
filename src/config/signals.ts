import type { Signal } from '../core/types'

/**
 * v0.1 信号集 —— 语音控车窗 Demo 所需
 *
 * ⚠️ vssPath 待逐条核验：VSS v6.0 (2026-01) 含破坏性变更
 *    （座椅信号重构、部分 Left/Right → DriverSide/PassengerSide、单位大小写）
 *    冻结前必须对照 COVESA 官方 catalog 核对。当前值为待验证的推定路径。
 */
export const SIGNALS: Signal[] = [
  /* ── 行驶与动力 ── */
  { alias: 'vehicle.speed', vssPath: 'Vehicle.Speed',
    type: 'number', range: [0, 220], unit: 'km/h', label: '车速',
    access: 'READ', changeMode: 'CONTINUOUS', initial: 0 },

  { alias: 'vehicle.gear', vssPath: 'Vehicle.Powertrain.Transmission.CurrentGear',
    type: 'enum', values: ['p', 'r', 'n', 'd'], label: '挡位',
    valueLabels: { p: 'P', r: 'R', n: 'N', d: 'D' },
    access: 'READ', changeMode: 'ONCHANGE', initial: 'p' },

  { alias: 'powertrain.soc', vssPath: 'Vehicle.Powertrain.TractionBattery.StateOfCharge.Current',
    type: 'number', range: [0, 100], unit: '%', label: '电量',
    access: 'READ', changeMode: 'CONTINUOUS', initial: 68 },

  /* ── 车窗（本 Demo 主角） ── */
  { alias: 'cabin.window.driver.position', vssPath: 'Vehicle.Cabin.Door.Row1.DriverSide.Window.Position',
    type: 'number', range: [0, 100], unit: '%', label: '主驾车窗',
    access: 'READ_WRITE', changeMode: 'ONCHANGE', permission: '彩', transition: 4000, initial: 0 },

  { alias: 'cabin.window.passenger.position', vssPath: 'Vehicle.Cabin.Door.Row1.PassengerSide.Window.Position',
    type: 'number', range: [0, 100], unit: '%', label: '副驾车窗',
    access: 'READ_WRITE', changeMode: 'ONCHANGE', permission: '彩', transition: 4000, initial: 0 },

  { alias: 'cabin.window.rearLeft.position', vssPath: 'Vehicle.Cabin.Door.Row2.DriverSide.Window.Position',
    type: 'number', range: [0, 100], unit: '%', label: '左后车窗',
    access: 'READ_WRITE', changeMode: 'ONCHANGE', permission: '彩', transition: 4000, initial: 0 },

  { alias: 'cabin.window.rearRight.position', vssPath: 'Vehicle.Cabin.Door.Row2.PassengerSide.Window.Position',
    type: 'number', range: [0, 100], unit: '%', label: '右后车窗',
    access: 'READ_WRITE', changeMode: 'ONCHANGE', permission: '彩', transition: 4000, initial: 0 },

  /* ── 车门（四门 + 后备箱） ── */
  { alias: 'cabin.door.driver.isOpen', vssPath: 'Vehicle.Cabin.Door.Row1.DriverSide.IsOpen',
    type: 'boolean', label: '主驾车门',
    access: 'READ_WRITE', changeMode: 'ONCHANGE', permission: '灰', initial: false },

  { alias: 'cabin.door.passenger.isOpen', vssPath: 'Vehicle.Cabin.Door.Row1.PassengerSide.IsOpen',
    type: 'boolean', label: '副驾车门',
    access: 'READ_WRITE', changeMode: 'ONCHANGE', permission: '灰', initial: false },

  { alias: 'cabin.door.rearLeft.isOpen', vssPath: 'Vehicle.Cabin.Door.Row2.DriverSide.IsOpen',
    type: 'boolean', label: '左后车门',
    access: 'READ_WRITE', changeMode: 'ONCHANGE', permission: '灰', initial: false },

  { alias: 'cabin.door.rearRight.isOpen', vssPath: 'Vehicle.Cabin.Door.Row2.PassengerSide.IsOpen',
    type: 'boolean', label: '右后车门',
    access: 'READ_WRITE', changeMode: 'ONCHANGE', permission: '灰', initial: false },

  { alias: 'cabin.trunk.isOpen', vssPath: 'Vehicle.Body.Trunk.Rear.IsOpen',
    type: 'boolean', label: '后备箱',
    access: 'READ_WRITE', changeMode: 'ONCHANGE', permission: '灰', initial: false },

  { alias: 'cabin.chargePort.isOpen', vssPath: 'Vehicle.Body.ChargingPort.IsOpen',
    type: 'boolean', label: '充电口',
    access: 'READ_WRITE', changeMode: 'ONCHANGE', permission: '彩', initial: false },

  { alias: 'cabin.childLock', vssPath: 'Vehicle.Cabin.Door.Row2.DriverSide.IsChildLockActive',
    type: 'boolean', label: '儿童锁',
    access: 'READ_WRITE', changeMode: 'ONCHANGE', permission: '彩', initial: false },

  /* ── 空调（单分区） ── */
  { alias: 'cabin.climate.power', vssPath: 'Vehicle.Cabin.HVAC.IsAirConditioningActive',
    type: 'boolean', label: '空调开关',
    access: 'READ_WRITE', changeMode: 'ONCHANGE', permission: '彩', initial: false },

  { alias: 'cabin.climate.targetTemp', vssPath: 'Vehicle.Cabin.HVAC.Station.Row1.Driver.Temperature',
    type: 'number', range: [16, 30], unit: '°C', label: '空调温度',
    access: 'READ_WRITE', changeMode: 'ONCHANGE', permission: '彩', initial: 22 },

  { alias: 'cabin.climate.fanSpeed', vssPath: 'Vehicle.Cabin.HVAC.Station.Row1.Driver.FanSpeed',
    type: 'number', range: [0, 7], label: '空调风量',
    access: 'READ_WRITE', changeMode: 'ONCHANGE', permission: '彩', initial: 3 },

  { alias: 'cabin.climate.airflow', vssPath: 'Vehicle.Cabin.HVAC.Station.Row1.Driver.AirDistribution',
    type: 'enum', values: ['face', 'feet', 'faceFeet', 'defrost'], label: '出风模式',
    valueLabels: { face: '吹面', feet: '吹脚', faceFeet: '面脚同时', defrost: '除霜' },
    access: 'READ_WRITE', changeMode: 'ONCHANGE', permission: '彩', initial: 'faceFeet' },

  { alias: 'cabin.climate.auto', vssPath: 'Vehicle.Cabin.HVAC.IsAutoModeActive',
    type: 'boolean', label: '空调自动模式',
    access: 'READ_WRITE', changeMode: 'ONCHANGE', permission: '彩', initial: false },

  { alias: 'cabin.climate.recirculation', vssPath: 'Vehicle.Cabin.HVAC.IsRecirculationActive',
    type: 'boolean', label: '内循环',
    access: 'READ_WRITE', changeMode: 'ONCHANGE', permission: '彩', initial: false },

  { alias: 'cabin.climate.frontDefrost', vssPath: 'Vehicle.Cabin.HVAC.IsFrontDefrosterActive',
    type: 'boolean', label: '前挡除雾',
    access: 'READ_WRITE', changeMode: 'ONCHANGE', permission: '彩', initial: false },

  { alias: 'cabin.climate.rearDefrost', vssPath: 'Vehicle.Cabin.HVAC.IsRearDefrosterActive',
    type: 'boolean', label: '后挡除雾',
    access: 'READ_WRITE', changeMode: 'ONCHANGE', permission: '彩', initial: false },

  /* ── 座椅（v0.1 简化：滑动/靠背仅前排；后排标 equipped:false 走 NOT_EQUIPPED，不是裸错误） ── */
  { alias: 'seat.driver.heating', vssPath: 'Vehicle.Cabin.Seat.Row1.DriverSide.Heating',
    type: 'number', range: [0, 3], label: '主驾座椅加热',
    access: 'READ_WRITE', changeMode: 'ONCHANGE', permission: '彩', initial: 0 },
  { alias: 'seat.passenger.heating', vssPath: 'Vehicle.Cabin.Seat.Row1.PassengerSide.Heating',
    type: 'number', range: [0, 3], label: '副驾座椅加热',
    access: 'READ_WRITE', changeMode: 'ONCHANGE', permission: '彩', initial: 0 },
  { alias: 'seat.rearLeft.heating', vssPath: 'Vehicle.Cabin.Seat.Row2.DriverSide.Heating',
    type: 'number', range: [0, 3], label: '左后座椅加热',
    access: 'READ_WRITE', changeMode: 'ONCHANGE', permission: '彩', initial: 0 },
  { alias: 'seat.rearRight.heating', vssPath: 'Vehicle.Cabin.Seat.Row2.PassengerSide.Heating',
    type: 'number', range: [0, 3], label: '右后座椅加热',
    access: 'READ_WRITE', changeMode: 'ONCHANGE', permission: '彩', initial: 0 },

  { alias: 'seat.driver.ventilation', vssPath: 'Vehicle.Cabin.Seat.Row1.DriverSide.Ventilation',
    type: 'number', range: [0, 3], label: '主驾座椅通风',
    access: 'READ_WRITE', changeMode: 'ONCHANGE', permission: '彩', initial: 0 },
  { alias: 'seat.passenger.ventilation', vssPath: 'Vehicle.Cabin.Seat.Row1.PassengerSide.Ventilation',
    type: 'number', range: [0, 3], label: '副驾座椅通风',
    access: 'READ_WRITE', changeMode: 'ONCHANGE', permission: '彩', initial: 0 },
  { alias: 'seat.rearLeft.ventilation', vssPath: 'Vehicle.Cabin.Seat.Row2.DriverSide.Ventilation',
    type: 'number', range: [0, 3], label: '左后座椅通风',
    access: 'READ_WRITE', changeMode: 'ONCHANGE', permission: '彩', initial: 0 },
  { alias: 'seat.rearRight.ventilation', vssPath: 'Vehicle.Cabin.Seat.Row2.PassengerSide.Ventilation',
    type: 'number', range: [0, 3], label: '右后座椅通风',
    access: 'READ_WRITE', changeMode: 'ONCHANGE', permission: '彩', initial: 0 },

  { alias: 'seat.driver.slide', vssPath: 'Vehicle.Cabin.Seat.Row1.DriverSide.Position',
    type: 'number', range: [0, 100], unit: '%', label: '主驾座椅前后',
    access: 'READ_WRITE', changeMode: 'ONCHANGE', permission: '彩', transition: 3000, initial: 50 },
  { alias: 'seat.passenger.slide', vssPath: 'Vehicle.Cabin.Seat.Row1.PassengerSide.Position',
    type: 'number', range: [0, 100], unit: '%', label: '副驾座椅前后',
    access: 'READ_WRITE', changeMode: 'ONCHANGE', permission: '彩', transition: 3000, initial: 50 },
  { alias: 'seat.rearLeft.slide', vssPath: 'Vehicle.Cabin.Seat.Row2.DriverSide.Position',
    type: 'number', range: [0, 100], unit: '%', label: '左后座椅前后',
    access: 'READ_WRITE', changeMode: 'ONCHANGE', permission: '彩', initial: 50, equipped: false },
  { alias: 'seat.rearRight.slide', vssPath: 'Vehicle.Cabin.Seat.Row2.PassengerSide.Position',
    type: 'number', range: [0, 100], unit: '%', label: '右后座椅前后',
    access: 'READ_WRITE', changeMode: 'ONCHANGE', permission: '彩', initial: 50, equipped: false },

  { alias: 'seat.driver.recline', vssPath: 'Vehicle.Cabin.Seat.Row1.DriverSide.Backrest.Recline',
    type: 'number', range: [0, 100], unit: '%', label: '主驾座椅靠背',
    access: 'READ_WRITE', changeMode: 'ONCHANGE', permission: '彩', transition: 3000, initial: 30 },
  { alias: 'seat.passenger.recline', vssPath: 'Vehicle.Cabin.Seat.Row1.PassengerSide.Backrest.Recline',
    type: 'number', range: [0, 100], unit: '%', label: '副驾座椅靠背',
    access: 'READ_WRITE', changeMode: 'ONCHANGE', permission: '彩', transition: 3000, initial: 30 },
  { alias: 'seat.rearLeft.recline', vssPath: 'Vehicle.Cabin.Seat.Row2.DriverSide.Backrest.Recline',
    type: 'number', range: [0, 100], unit: '%', label: '左后座椅靠背',
    access: 'READ_WRITE', changeMode: 'ONCHANGE', permission: '彩', initial: 30, equipped: false },
  { alias: 'seat.rearRight.recline', vssPath: 'Vehicle.Cabin.Seat.Row2.PassengerSide.Backrest.Recline',
    type: 'number', range: [0, 100], unit: '%', label: '右后座椅靠背',
    access: 'READ_WRITE', changeMode: 'ONCHANGE', permission: '彩', initial: 30, equipped: false },

  /* ── 方向盘 ── */
  { alias: 'cabin.steeringWheel.heating', vssPath: 'Vehicle.Cabin.SteeringWheel.Heating',
    type: 'number', range: [0, 3], label: '方向盘加热',
    access: 'READ_WRITE', changeMode: 'ONCHANGE', permission: '彩', initial: 0 },

  /* ── 氛围灯（v0.1 简化：整车一个分区） ── */
  { alias: 'cabin.ambientLight.power', vssPath: 'Vehicle.Cabin.Light.AmbientLight.IsLightOn',
    type: 'boolean', label: '氛围灯开关',
    access: 'READ_WRITE', changeMode: 'ONCHANGE', permission: '彩', initial: false },
  { alias: 'cabin.ambientLight.color', vssPath: 'Vehicle.Cabin.Light.AmbientLight.Color',
    type: 'enum', values: ['white', 'blue', 'purple', 'pink', 'red', 'orange', 'yellow', 'green'], label: '氛围灯颜色',
    valueLabels: { white: '白', blue: '蓝', purple: '紫', pink: '粉', red: '红', orange: '橙', yellow: '黄', green: '绿' },
    access: 'READ_WRITE', changeMode: 'ONCHANGE', permission: '彩', initial: 'white' },
  { alias: 'cabin.ambientLight.brightness', vssPath: 'Vehicle.Cabin.Light.AmbientLight.Brightness',
    type: 'number', range: [0, 100], unit: '%', label: '氛围灯亮度',
    access: 'READ_WRITE', changeMode: 'ONCHANGE', permission: '彩', initial: 60 },
  { alias: 'cabin.ambientLight.effect', vssPath: 'Vehicle.Cabin.Light.AmbientLight.Effect',
    type: 'enum', values: ['static', 'breathing', 'flowing', 'musicSync'], label: '氛围灯灯效',
    valueLabels: { static: '常亮', breathing: '呼吸', flowing: '流光', musicSync: '随音乐' },
    access: 'READ_WRITE', changeMode: 'ONCHANGE', permission: '彩', initial: 'static' },

  /* ── 香氛 ── */
  { alias: 'cabin.fragrance.power', vssPath: 'Vehicle.Cabin.Fragrance.IsActive',
    type: 'boolean', label: '香氛开关',
    access: 'READ_WRITE', changeMode: 'ONCHANGE', permission: '彩', initial: false },
  { alias: 'cabin.fragrance.scent', vssPath: 'Vehicle.Cabin.Fragrance.Scent',
    type: 'enum', values: ['none', 'citrus', 'wood', 'floral', 'mint'], label: '香型',
    valueLabels: { none: '无', citrus: '柑橘', wood: '木质', floral: '花香', mint: '薄荷' },
    access: 'READ_WRITE', changeMode: 'ONCHANGE', permission: '彩', initial: 'none' },
  { alias: 'cabin.fragrance.intensity', vssPath: 'Vehicle.Cabin.Fragrance.Intensity',
    type: 'number', range: [0, 3], label: '香氛浓度',
    access: 'READ_WRITE', changeMode: 'ONCHANGE', permission: '彩', initial: 1 },

  /* ── 灯光（v0.1 简化：大灯 + 后备箱灯，阅读灯留待 v0.2） ── */
  { alias: 'cabin.light.headlight.state', vssPath: 'Vehicle.Body.Lights.Beam.Low.IsOn',
    type: 'enum', values: ['on', 'off', 'auto'], label: '大灯',
    valueLabels: { on: '开', off: '关', auto: '自动' },
    access: 'READ_WRITE', changeMode: 'ONCHANGE', permission: '彩', initial: 'auto' },
  { alias: 'cabin.light.trunkLight.state', vssPath: 'Vehicle.Body.Trunk.Rear.Light.IsOn',
    type: 'enum', values: ['on', 'off', 'auto'], label: '后备箱灯',
    valueLabels: { on: '开', off: '关', auto: '自动' },
    access: 'READ_WRITE', changeMode: 'ONCHANGE', permission: '彩', initial: 'off' },

  /* ── 驾驶设置 ── */
  { alias: 'vehicle.driveMode', vssPath: 'Vehicle.Powertrain.Transmission.PerformanceMode',
    type: 'enum', values: ['comfort', 'sport', 'eco', 'snow'], label: '驾驶模式',
    valueLabels: { comfort: '舒适', sport: '运动', eco: '经济', snow: '雪地' },
    access: 'READ_WRITE', changeMode: 'ONCHANGE', permission: '彩', initial: 'comfort' },
  { alias: 'vehicle.regenLevel', vssPath: 'Vehicle.Chassis.Axle.Row1.Wheel.Left.Brake.RegenerationLevel',
    type: 'number', range: [0, 3], label: '动能回收等级',
    access: 'READ_WRITE', changeMode: 'ONCHANGE', permission: '彩', initial: 1 },
  { alias: 'vehicle.suspensionHeight', vssPath: 'Vehicle.Chassis.Height',
    type: 'enum', values: ['low', 'normal', 'high'], label: '悬架高度',
    valueLabels: { low: '低', normal: '标准', high: '高' },
    access: 'READ_WRITE', changeMode: 'ONCHANGE', permission: '彩', initial: 'normal' },

  /* ── 未选装：反幻觉验证用（Golden Case 9） ── */
  { alias: 'cabin.sunroof.glass.position', vssPath: 'Vehicle.Cabin.Sunroof.Position',
    type: 'number', range: [0, 100], unit: '%', label: '全景天窗',
    access: 'READ_WRITE', changeMode: 'ONCHANGE', permission: '彩', transition: 6000,
    initial: 0, equipped: false },

  /* ── 环境 ── */
  { alias: 'cabin.temperature.outside', vssPath: 'Vehicle.Exterior.AirTemperature',
    type: 'number', range: [-40, 60], unit: '°C', label: '车外温度',
    access: 'READ', changeMode: 'CONTINUOUS', initial: 3 },

  { alias: 'env.weather', vssPath: 'Vehicle.Exterior.WeatherCondition',
    type: 'enum', values: ['clear', 'cloudy', 'rain', 'heavyRain', 'snow', 'fog'], label: '天气',
    valueLabels: { clear: '晴', cloudy: '多云', rain: '小雨', heavyRain: '大雨', snow: '雪', fog: '雾' },
    access: 'READ', changeMode: 'ONCHANGE', initial: 'cloudy' },

  /* ── 车辆身份（限行判定与出行推荐要用） ── */
  { alias: 'vehicle.plate', vssPath: 'Vehicle.VehicleIdentification.LicensePlate',
    type: 'string', label: '车牌号',
    access: 'READ', changeMode: 'STATIC', initial: '川A88888' },

  { alias: 'vehicle.carType', vssPath: 'Vehicle.Powertrain.Type',
    type: 'enum', values: ['fuel', 'ev', 'phev'], label: '车型',
    access: 'READ', changeMode: 'STATIC', initial: 'ev' },

  /* ── 导航（非 VSS 标准域，标注为扩展；接高德真实 API） ── */
  { alias: 'vehicle.location', vssPath: 'Vehicle.X-Ext.CurrentLocation',
    type: 'string', label: '当前位置(经度,纬度)',
    access: 'READ', changeMode: 'ONCHANGE', initial: '116.397428,39.90923' },

  { alias: 'navigation.active', vssPath: 'Vehicle.X-Ext.Navigation.Active',
    type: 'boolean', label: '导航中',
    access: 'READ_WRITE', changeMode: 'ONCHANGE', permission: '彩', initial: false },

  { alias: 'navigation.destination', vssPath: 'Vehicle.X-Ext.Navigation.Destination',
    type: 'string', label: '导航目的地',
    access: 'READ_WRITE', changeMode: 'ONCHANGE', permission: '彩', initial: '' },

  { alias: 'navigation.destinationLocation', vssPath: 'Vehicle.X-Ext.Navigation.DestinationLocation',
    type: 'string', label: '导航目的地坐标(经度,纬度)——不直接给 Agent 用，只用来重建地图图片',
    access: 'READ_WRITE', changeMode: 'ONCHANGE', permission: '彩', initial: '' },

  { alias: 'navigation.nextInstruction', vssPath: 'Vehicle.X-Ext.Navigation.NextInstruction',
    type: 'string', label: '下一步指引',
    access: 'READ_WRITE', changeMode: 'ONCHANGE', permission: '彩', initial: '' },

  { alias: 'navigation.routePolyline', vssPath: 'Vehicle.X-Ext.Navigation.RoutePolyline',
    type: 'string', label: '路线坐标串——不给 Agent 看，只用来在地图上画线',
    access: 'READ_WRITE', changeMode: 'ONCHANGE', permission: '彩', initial: '' },

  { alias: 'navigation.waypoints', vssPath: 'Vehicle.X-Ext.Navigation.Waypoints',
    type: 'string', label: '途经点坐标串（分号分隔）——用于地图标注',
    access: 'READ_WRITE', changeMode: 'ONCHANGE', permission: '彩', initial: '' },

  // 坐标能在地图上打点，但卡片上得说人话。没这个的话话术说"先去充电站再去太古里"，
  // 屏幕上只有"去成都太古里"，用户不知道要绕路
  { alias: 'navigation.waypointNames', vssPath: 'Vehicle.X-Ext.Navigation.WaypointNames',
    type: 'string', label: '途经点名称（分号分隔）',
    access: 'READ_WRITE', changeMode: 'ONCHANGE', permission: '彩', initial: '' },

  /* ══════════ 媒体（音乐 · 电台 · 短视频共用一套状态） ══════════
   * 注意这里**没有播放进度**。position 每秒变好几次，进了信号系统就是
   * 每秒重评一遍卡片规则、约束引擎为一个没人约束的值做无谓计算。
   * 进度是遥测不是状态，由车机屏本地渲染。Agent 需要知道在放什么，
   * 不需要知道播到 1 分 23 秒；真问起来现查。 */
  { alias: 'cabin.wiper.mode', vssPath: 'Vehicle.Body.Windshield.Front.Wiping.Mode',
    type: 'enum', values: ['off', 'auto', 'slow', 'medium', 'high'], label: '雨刷',
    valueLabels: { off: '关', auto: '自动感应', slow: '慢', medium: '中', high: '快' },
    access: 'READ_WRITE', changeMode: 'ONCHANGE', permission: '彩', initial: 'off' },

  { alias: 'media.source', vssPath: 'Vehicle.Cabin.Infotainment.Media.Played.Source',
    type: 'enum', values: ['none', 'music', 'radio', 'video'], label: '媒体来源',
    valueLabels: { none: '无', music: '音乐', radio: '电台', video: '视频' },
    access: 'READ_WRITE', changeMode: 'ONCHANGE', permission: '彩', initial: 'none' },

  /* ── 路上的故事（2026-08-14）：AI 儿童有声绘本 ──
   * 跟导航卡、播放器卡同一个模式：信号驱动规则、规则驱动卡片，模型零参与布局。
   * 播放进度不进 store 的那条界线在这里同样成立 —— 这几个都是**状态**不是遥测，
   * 一章才变一次，不是每秒变好几次。 */
  { alias: 'story.active', vssPath: 'Vehicle.Cabin.Infotainment.HMI.StoryActive',
    type: 'boolean', label: '正在讲故事',
    access: 'READ_WRITE', changeMode: 'ONCHANGE', permission: '彩', initial: false },

  { alias: 'story.phase', vssPath: 'Vehicle.Cabin.Infotainment.HMI.StoryPhase',
    type: 'enum', values: ['idle', 'cast', 'telling', 'asking', 'done'],
    label: '故事进行到哪一步',
    valueLabels: { idle: '没在讲', cast: '给主角定妆', telling: '讲述中', asking: '问孩子接下来', done: '成书' },
    access: 'READ_WRITE', changeMode: 'ONCHANGE', permission: '彩', initial: 'idle' },

  { alias: 'story.page', vssPath: 'Vehicle.Cabin.Infotainment.HMI.StoryPage',
    type: 'number', label: '当前第几页',
    access: 'READ_WRITE', changeMode: 'ONCHANGE', permission: '彩', initial: 0 },

  { alias: 'story.chapter', vssPath: 'Vehicle.Cabin.Infotainment.HMI.StoryChapter',
    type: 'number', label: '当前第几章',
    access: 'READ_WRITE', changeMode: 'ONCHANGE', permission: '彩', initial: 0 },

  // 进度点里那几个虚线圈靠它。"故事一边讲一边长"这件事必须让人看见，
  // 否则用户会以为卡住了
  /**
   * 这本书累计花了多少美分。**图像比文本贵一个量级** ——
   * 实测 $0.068/张（设计估算 $0.04 的 1.7 倍），一本 7 页约 $0.5。
   * 不显示的话跑几轮就烧掉 Key 的额度还不知道。用美分是为了避免浮点噪音。
   */
  { alias: 'story.cents', vssPath: 'Vehicle.Cabin.Infotainment.HMI.StoryCents',
    type: 'number', label: '这本书花了多少美分',
    access: 'READ_WRITE', changeMode: 'ONCHANGE', permission: '彩', initial: 0 },

  { alias: 'story.pending', vssPath: 'Vehicle.Cabin.Infotainment.HMI.StoryPending',
    type: 'number', label: '还有几页在画',
    access: 'READ_WRITE', changeMode: 'ONCHANGE', permission: '彩', initial: 0 },

  { alias: 'media.playing', vssPath: 'Vehicle.Cabin.Infotainment.Media.Action',
    type: 'boolean', label: '正在播放',
    access: 'READ_WRITE', changeMode: 'ONCHANGE', permission: '彩', initial: false },

  { alias: 'media.track', vssPath: 'Vehicle.Cabin.Infotainment.Media.Played.Track',
    type: 'string', label: '曲目/节目/视频标题',
    access: 'READ_WRITE', changeMode: 'ONCHANGE', permission: '彩', initial: '' },

  { alias: 'media.artist', vssPath: 'Vehicle.Cabin.Infotainment.Media.Played.Artist',
    type: 'string', label: '艺人/电台名/作者',
    access: 'READ_WRITE', changeMode: 'ONCHANGE', permission: '彩', initial: '' },

  { alias: 'media.artwork', vssPath: 'Vehicle.X-Ext.Media.Artwork',
    type: 'string', label: '封面图地址',
    access: 'READ_WRITE', changeMode: 'ONCHANGE', permission: '彩', initial: '' },

  /** 真正丢给 <audio>/<video> 的地址。车机屏据此播放 */
  { alias: 'media.streamUrl', vssPath: 'Vehicle.Cabin.Infotainment.Media.Played.URI',
    type: 'string', label: '播放地址',
    access: 'READ_WRITE', changeMode: 'ONCHANGE', permission: '彩', initial: '' },

  /**
   * 视频画面是否开着。跟 media.source='video' 不冗余——
   * source 是"在放什么"，这个是"画面开着"，真车机里确实是两回事
   * （行驶中常见的处理是画面关掉、声音继续）。
   * 单独成信号是为了让"行驶中禁止看视频"能写成一条约束，
   * 而不是塞进 handler 里的 if——约束引擎的 target 只匹配路径不看值，
   * 打在 media.source 上会连音乐一起拦掉。
   */
  { alias: 'media.videoActive', vssPath: 'Vehicle.X-Ext.Media.VideoActive',
    type: 'boolean', label: '视频画面',
    access: 'READ_WRITE', changeMode: 'ONCHANGE', permission: '彩', initial: false },

  { alias: 'media.volume', vssPath: 'Vehicle.Cabin.Infotainment.Media.Volume',
    type: 'number', range: [0, 100], unit: '%', label: '媒体音量',
    access: 'READ_WRITE', changeMode: 'ONCHANGE', permission: '彩', initial: 40 },

  { alias: 'media.mode', vssPath: 'Vehicle.X-Ext.Media.PlayMode',
    type: 'enum', values: ['sequential', 'shuffle', 'repeatOne'], label: '播放模式',
    valueLabels: { sequential: '顺序播放', shuffle: '随机播放', repeatOne: '单曲循环' },
    access: 'READ_WRITE', changeMode: 'ONCHANGE', permission: '彩', initial: 'sequential' },

  { alias: 'navigation.eta', vssPath: 'Vehicle.X-Ext.Navigation.ETA',
    type: 'number', range: [0, 999], unit: '分钟', label: '预计到达时间',
    access: 'READ_WRITE', changeMode: 'ONCHANGE', permission: '彩', initial: 0 },

  { alias: 'navigation.distanceRemaining', vssPath: 'Vehicle.X-Ext.Navigation.DistanceRemaining',
    type: 'number', range: [0, 9999], unit: 'km', label: '剩余里程',
    access: 'READ_WRITE', changeMode: 'ONCHANGE', permission: '彩', initial: 0 },

  /* ── 感知（非 VSS 标准域，标注为扩展） ── */
  { alias: 'perception.voiceSource', vssPath: 'Vehicle.Cabin.X-Ext.VoiceSourceSeat',
    type: 'enum', values: ['driver', 'passenger', 'rearLeft', 'rearRight'], label: '说话人位置',
    valueLabels: { driver: '主驾', passenger: '副驾', rearLeft: '左后', rearRight: '右后' },
    access: 'READ', changeMode: 'ONCHANGE', initial: 'driver' },

  { alias: 'perception.occupancy.rearLeft', vssPath: 'Vehicle.Cabin.Seat.Row2.DriverSide.IsOccupied',
    type: 'boolean', label: '左后有人',
    access: 'READ', changeMode: 'ONCHANGE', initial: false },
]
