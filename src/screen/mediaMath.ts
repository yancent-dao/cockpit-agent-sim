/**
 * 播放器卡的点按定位与取色——纯算术，不碰 DOM（媒体卡重设计 v2）。
 * 进度/音量 v1 用点按定位不用拖拽：行驶中拖拽本来就要降级（同滚动禁令判据），
 * 停车场景的拖拽后续再加。
 */

/** 点击横坐标 → 条上 0..1。零宽（还没布局）回 0，不除出 NaN */
export function barRatio(clientX: number, left: number, width: number): number {
  if (!width) return 0
  return Math.max(0, Math.min(1, (clientX - left) / width))
}

/** 比例 × 时长 → 目标秒。时长未知（直播/未加载）回 null——调用方据此不发 seek */
export function seekSeconds(ratio: number, duration: number): number | null {
  if (!Number.isFinite(duration) || duration <= 0) return null
  return Math.round(ratio * duration)
}

/**
 * 封面主色：像素采样、饱和度加权平均——封面的"主色"是色彩不是底灰，
 * 大片灰底不该把一抹品蓝拖没。空数据回 null（图跨域污染时调用方退源色）。
 */
export function dominantColor(px: Uint8ClampedArray): [number, number, number] | null {
  if (px.length < 4) return null
  let R = 0, G = 0, B = 0, W = 0
  for (let i = 0; i + 3 < px.length; i += 4) {
    const r = px[i], g = px[i + 1], b = px[i + 2]
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b)
    const w = 1 + (mx - mn) * 3 / 255 * 4   // 饱和像素最高 5 倍权重
    R += r * w; G += g * w; B += b * w; W += w
  }
  return [Math.round(R / W), Math.round(G / W), Math.round(B / W)]
}
