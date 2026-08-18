/**
 * C3a 星河盘（Avatar 定稿 §01/§02）。
 *
 * 状态 → 视觉参数的映射是**纯函数**（galaxyParams，配测试）；
 * 画的那半（createGalaxy）是 canvas 循环，留在车机屏跑。
 * 状态词对齐 voice 总线既有词汇——不发明命名。
 */

export interface GalaxyParams {
  /** 公转速度系数（confirm 停转 = 0） */
  speed: number
  /** 粒子整体透明度（待机压暗，余光里不打扰） */
  alpha: number
  /** 轨道收拢系数（聆听 < 1：星盘收拢，"我在听你说"） */
  gather: number
  /** 播报的径向声浪 */
  wave: boolean
  /** 待确认/拒绝走琥珀——颜色变化余光就能捕捉 */
  amber: boolean
  /** 执行态核心闪烁——每闪一下对应一次工具落地 */
  flash: boolean
}

const P = (speed: number, alpha: number, gather = 1, wave = false, amber = false, flash = false):
  GalaxyParams => ({ speed, alpha, gather, wave, amber, flash })

const STATES: Record<string, GalaxyParams> = {
  idle:       P(1, .55),
  wakeup:     P(2.5, .95),
  listening:  P(2.2, .9, .8),
  thinking:   P(4.5, .95),
  speaking:   P(1.4, .95, 1, true),
  executing:  P(1.8, .95, 1, false, false, true),
  confirming: P(0, 1, 1, false, true),
  rejected:   P(.8, .9, 1, false, true),
}

/** 未知状态回退待机——新状态词上线前这里先不炸 */
export function galaxyParams(s: string): GalaxyParams {
  return STATES[s] ?? STATES.idle
}

/**
 * 渲染循环。粒子数按小尺寸角标调过（48 粒 @ 64px 画布）；
 * 待机降帧（隔帧画）——这颗角标要在屏上活一整天。
 */
export function createGalaxy(canvas: HTMLCanvasElement, getState: () => string) {
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  const W = canvas.width, C = W / 2
  const parts = Array.from({ length: 48 }, () => ({
    a: Math.random() * Math.PI * 2,
    r: W * .07 + Math.pow(Math.random(), .7) * W * .3,
    sp: .005 + Math.random() * .007,
    ph: Math.random() * Math.PI * 2,
    sz: W / 88 * (.6 + Math.random() * 1.1),
  }))
  let frame = 0
  const draw = (t: number) => {
    requestAnimationFrame(draw)
    const s = getState()
    const p = galaxyParams(s)
    frame++
    if (p.speed <= 1 && p.alpha < .9 && frame % 2) return   // 待机降帧
    ctx.clearRect(0, 0, W, W)
    // 核辉。执行态按节拍闪：亮度跟着正弦抬头
    const flashK = p.flash ? .55 + Math.max(0, Math.sin(t / 300)) * .45 : 1
    const coreR = W * .15 * flashK
    const g = ctx.createRadialGradient(C, C, 0, C, C, coreR)
    g.addColorStop(0, p.amber ? 'rgba(245,158,11,.65)' : 'rgba(195,218,255,.6)')
    g.addColorStop(1, 'rgba(195,218,255,0)')
    ctx.fillStyle = g
    ctx.beginPath(); ctx.arc(C, C, coreR, 0, 7); ctx.fill()
    for (const pt of parts) {
      if (p.speed > 0) pt.a += pt.sp * p.speed
      let r = pt.r * p.gather
      if (p.wave) r += Math.max(0, Math.sin(t / 240 - pt.r / (W * .08))) * W * .034
      const x = C + Math.cos(pt.a) * r
      const y = C + Math.sin(pt.a) * r * .42
      // 思考态色相漫游（蓝→紫→青）：十几秒的等待要看得出"在活动"
      const hue = p.amber ? 38 : s === 'thinking' ? 214 + Math.sin(t / 480 + pt.ph) * 40 : 218
      ctx.beginPath(); ctx.arc(x, y, pt.sz, 0, 7)
      ctx.fillStyle = `hsla(${hue},85%,58%,${p.alpha})`
      ctx.fill()
    }
  }
  requestAnimationFrame(draw)
}
