/**
 * 车机屏的播放器。音频/视频元素必须在这边——放控制面板的话，
 * 投屏到车机屏之后声音会从错误的机器出来，演示当场就废。
 *
 * 两个绕不开的浏览器现实：
 *
 * 1. **自动播放策略**。Chrome 要求页面被用户交互过才允许出声。车机屏是
 *    window.open 出来的被动窗口，很可能一次点击都没有——第一首歌会被静默
 *    拒绝，只在控制台留一句 NotAllowedError，看起来像功能没做好。
 *    所以有 unlock()：开屏点一次遮罩，用一个静音的空播放把权限"解锁"，
 *    之后都正常。只打扰一次。
 *
 * 2. **元素不能跟着卡片文字一起重绘**。重建 <audio> 会从头开始播。
 *    所以元素挂在这里，卡片渲染只管画封面和文字。
 */

export type MediaEvent = 'ended' | 'error' | 'blocked' | 'ready'

export interface PlayerDeps {
  /** 上报设备事实（放完了 / 放不出来），不上报决定 */
  report: (event: MediaEvent, detail?: string) => void
}

export interface PlayTarget {
  url: string
  /** video 走 <video>，其余走 <audio> */
  source: 'music' | 'radio' | 'video' | 'podcast' | 'none'
  volume: number
}

export function createPlayer({ report }: PlayerDeps) {
  const audio = new Audio()
  audio.preload = 'auto'
  let video: HTMLVideoElement | null = null
  let unlocked = false
  let current = ''

  const wire = (el: HTMLMediaElement) => {
    el.onended = () => report('ended')
    el.onerror = () => report('error', el.error?.message ?? '播放失败')
    el.oncanplay = () => report('ready')
  }
  wire(audio)

  /**
   * 用一次真实的用户手势换取播放权限。必须在事件处理函数里同步调用 play()，
   * 放进 await 之后就不算"用户手势触发"了，浏览器照样拦。
   */
  function unlock() {
    unlocked = true
    audio.muted = true
    audio.play().catch(() => { /* 空源播放失败无所谓，权限已经拿到 */ })
    audio.pause()
    audio.muted = false
  }

  /** 视频元素按需建，挂进卡片给的容器 */
  function attachVideo(box: HTMLElement) {
    if (!video) {
      video = document.createElement('video')
      video.playsInline = true
      video.className = 'videoel'
      wire(video)
    }
    if (video.parentElement !== box) box.appendChild(video)
    return video
  }

  async function play(t: PlayTarget) {
    const el: HTMLMediaElement = t.source === 'video' ? (video ?? audio) : audio
    if (current !== t.url) { el.src = t.url; current = t.url }
    el.volume = Math.max(0, Math.min(1, t.volume / 100))
    try {
      await el.play()
    } catch (e) {
      // NotAllowedError = 还没解锁。这跟"地址挂了"是两回事，要分开报，
      // 不然用户看到"播放失败"会去查网络，其实只要点一下屏幕
      report(String(e).includes('NotAllowed') || !unlocked ? 'blocked' : 'error', String(e).slice(0, 120))
    }
  }

  function pause() { audio.pause(); video?.pause() }

  function stop() {
    pause()
    audio.removeAttribute('src'); audio.load()
    current = ''
  }

  /** 用户设定的音量（0-1）。duck 是乘在它上面的临时系数，不动设定本身 */
  let baseVol = 1
  let ducked = false
  const applyVol = () => {
    const x = baseVol * (ducked ? 0.2 : 1)
    audio.volume = x
    if (video) video.volume = x
  }
  const setVolume = (v: number) => { baseVol = Math.max(0, Math.min(1, v / 100)); applyVol() }
  /**
   * 播报让位（语音链路设计 §1 第 6 条）：任何 TTS 开口，媒体压到 20%，
   * 说完恢复——真车播报必 duck，不压的话导航音和歌声打架。
   */
  const duck = (on: boolean) => { if (ducked !== on) { ducked = on; applyVol() } }

  /**
   * 播放进度。**不进 store，不上 bus** —— position 每秒变好几次，
   * 进信号系统就是每秒重评一遍全部规则。这里直接读元素，走展示层。
   * 这条守的是「状态 vs 遥测」的界线，以后容易被侵蚀。
   */
  const progress = () => {
    const el: HTMLMediaElement = video && !video.paused ? video : audio
    return { current: el.currentTime, duration: el.duration }
  }

  /** 倍速（重设计 v2）：media.speed 信号 → playbackRate。音频视频都吃 */
  const setSpeed = (v: number) => {
    const r = Number.isFinite(v) && v >= 0.5 && v <= 3 ? v : 1
    audio.playbackRate = r
    if (video) video.playbackRate = r
  }

  return { unlock, play, pause, stop, setVolume, duck, attachVideo, progress, setSpeed,
    get unlocked() { return unlocked },
    get playingUrl() { return current } }
}

export type Player = ReturnType<typeof createPlayer>
