/** 跨窗口消息总线：postMessage 与 BroadcastChannel 双通道，file:// 下也能工作 */
export type BusMsg =
  | { type: 'hello' }
  | { type: 'state'; target: Record<string, number>; meta: Record<string, any> }
  | { type: 'voice'; s?: string; text?: string | null; who?: 'user' | 'agent' }
  /**
   * 横幅通道（第二条显示通道）。拒绝原因、约束不满足、能力缺失、
   * 卡片被挤出的告知都走它 —— 这些是**对某个动作的解释**，不是内容本身，
   * 塞进桌面会占掉 1/6 格子还跟内容卡长得一样。
   * reason 决定语义色（rejected 红 / constraint 橙 / evicted 蓝 / done 绿）。
   */
  | { type: 'banner'; on: boolean; title?: string; desc?: string; code?: string; reason?: string; ttl?: number; jump?: boolean }
  | { type: 'highlight'; ids: string[] }
  | { type: 'card'; action: 'show' | 'dismiss'; id: string; zone?: string; size?: string; title?: string; body?: string }
  /**
   * 车机屏 → 控制面板的唯一一类上报。播放器元素在车机屏那边（放控制面板的话，
   * 投屏后声音在错误的机器上），但播放会产生状态：放完了、放不出来、被浏览器拦了。
   *
   * **边界：只上报设备事实，不上报决定。** "放完了"是事实，"该放下一首了"是决定，
   * 后者归控制面板那边的规则管。这条界线以后容易被侵蚀。
   */
  /**
   * 生成式卡的自检上报：消毒剥了什么、内容有没有溢出。
   * 跟 mediaEvent 同一条边界 —— **只上报设备事实，不上报决定**。
   * "溢出了"是事实，"该换个档位"是决定，后者归控制面板那边管。
   */
  | { type: 'canvasNote'; cardId: string; stripped?: string[]; overflow?: boolean; contentPx?: number }
  /**
   * 用户在屏上的动作（触控/沙箱组件的 cockpit.action）。
   * 跟 mediaEvent 同一条边界：**上报的是用户动作这个事实**，怎么处置归 director。
   */
  | { type: 'userAction'; cardId: string; act: string; value?: string }
  | { type: 'mediaEvent'; event: 'ended' | 'error' | 'blocked' | 'ready'; detail?: string }

/** 去重记忆的容量。够覆盖同一条消息的多通道投递即可，不需要记住整个会话 */
export const DEDUPE_CAP = 64

/**
 * 收到过这个 id 吗（true = 重复，该丢弃）。
 *
 * send() 一条消息走三条通道，接收端两个入口共用一个 handle——不去重的话
 * 用户点一次「下一曲」会跳两首歌。抽成纯函数是因为 createBus 依赖
 * window/BroadcastChannel，node 测试环境构造不出来。
 * 没有 id 的消息（外部来源、旧版本页面）一律放行：宁可重复也不吞消息。
 */
export function createDedupe() {
  const seen = new Set<string>()
  return (id?: string): boolean => {
    if (!id) return false
    if (seen.has(id)) return true
    seen.add(id)
    // Set 迭代序即插入序，删第一个就是删最老的
    if (seen.size > DEDUPE_CAP) seen.delete(seen.values().next().value as string)
    return false
  }
}

export function createBus(onMsg: (m: BusMsg) => void) {
  let bc: BroadcastChannel | null = null
  try { bc = new BroadcastChannel('cockpit-sim') } catch { /* file:// 可能不支持 */ }

  let peer: Window | null = null
  const isDup = createDedupe()
  // 发送方前缀：两个窗口各自从 1 开始计数，只有计数器会撞车
  const src = Math.random().toString(36).slice(2, 8)
  let seq = 0
  const handle = (m: any) => {
    if (!m || !m.type) return
    if (isDup(m.__id)) return   // 同一条消息经第二条通道又来了一次
    onMsg(m as BusMsg)
  }

  addEventListener('message', e => {
    if (e.data?.type === 'hello' && e.source) peer = e.source as Window
    handle(e.data)
  })
  if (bc) bc.onmessage = e => handle(e.data)

  return {
    send(m: BusMsg) {
      const tagged = { ...m, __id: `${src}-${++seq}` }
      try { if (peer && !(peer as any).closed) peer.postMessage(tagged, '*') } catch { /* noop */ }
      try { if (opener) (opener as Window).postMessage(tagged, '*') } catch { /* noop */ }
      bc?.postMessage(tagged)
    },
    setPeer(w: Window | null) { peer = w },
    get connected() { return !!peer || !!opener },
  }
}
