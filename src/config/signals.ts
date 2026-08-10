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

  /* ── 车门（用于不变量断言与后续 Demo） ── */
  { alias: 'cabin.door.driver.isOpen', vssPath: 'Vehicle.Cabin.Door.Row1.DriverSide.IsOpen',
    type: 'boolean', label: '主驾车门',
    access: 'READ_WRITE', changeMode: 'ONCHANGE', permission: '灰', initial: false },

  { alias: 'cabin.childLock', vssPath: 'Vehicle.Cabin.Door.Row2.DriverSide.IsChildLockActive',
    type: 'boolean', label: '儿童锁',
    access: 'READ_WRITE', changeMode: 'ONCHANGE', permission: '彩', initial: false },

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
    access: 'READ', changeMode: 'ONCHANGE', initial: 'cloudy' },

  /* ── 感知（非 VSS 标准域，标注为扩展） ── */
  { alias: 'perception.voiceSource', vssPath: 'Vehicle.Cabin.X-Ext.VoiceSourceSeat',
    type: 'enum', values: ['driver', 'passenger', 'rearLeft', 'rearRight'], label: '说话人位置',
    access: 'READ', changeMode: 'ONCHANGE', initial: 'driver' },

  { alias: 'perception.occupancy.rearLeft', vssPath: 'Vehicle.Cabin.Seat.Row2.DriverSide.IsOccupied',
    type: 'boolean', label: '左后有人',
    access: 'READ', changeMode: 'ONCHANGE', initial: false },
]
