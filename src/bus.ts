/** 跨窗口消息总线：postMessage 与 BroadcastChannel 双通道，file:// 下也能工作 */
export type BusMsg =
  | { type: 'hello' }
  | { type: 'state'; target: Record<string, number>; meta: Record<string, any> }
  | { type: 'voice'; s?: string; text?: string | null; who?: 'user' | 'agent' }
  | { type: 'reject'; on: boolean; title?: string; desc?: string }
  | { type: 'highlight'; ids: string[] }
  | { type: 'card'; action: 'show' | 'dismiss'; id: string; zone?: string; size?: string; title?: string; body?: string }
  /**
   * 车机屏 → 控制面板的唯一一类上报。播放器元素在车机屏那边（放控制面板的话，
   * 投屏后声音在错误的机器上），但播放会产生状态：放完了、放不出来、被浏览器拦了。
   *
   * **边界：只上报设备事实，不上报决定。** "放完了"是事实，"该放下一首了"是决定，
   * 后者归控制面板那边的规则管。这条界线以后容易被侵蚀。
   */
  | { type: 'mediaEvent'; event: 'ended' | 'error' | 'blocked' | 'ready'; detail?: string }

export function createBus(onMsg: (m: BusMsg) => void) {
  let bc: BroadcastChannel | null = null
  try { bc = new BroadcastChannel('cockpit-sim') } catch { /* file:// 可能不支持 */ }

  let peer: Window | null = null
  const handle = (m: any) => { if (m && m.type) onMsg(m as BusMsg) }

  addEventListener('message', e => {
    if (e.data?.type === 'hello' && e.source) peer = e.source as Window
    handle(e.data)
  })
  if (bc) bc.onmessage = e => handle(e.data)

  return {
    send(m: BusMsg) {
      try { if (peer && !(peer as any).closed) peer.postMessage(m, '*') } catch { /* noop */ }
      try { if (opener) (opener as Window).postMessage(m, '*') } catch { /* noop */ }
      bc?.postMessage(m)
    },
    setPeer(w: Window | null) { peer = w },
    get connected() { return !!peer || !!opener },
  }
}
