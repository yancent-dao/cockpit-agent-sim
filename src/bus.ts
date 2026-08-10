/** 跨窗口消息总线：postMessage 与 BroadcastChannel 双通道，file:// 下也能工作 */
export type BusMsg =
  | { type: 'hello' }
  | { type: 'state'; target: Record<string, number>; meta: Record<string, any> }
  | { type: 'voice'; s?: string; text?: string | null; who?: 'user' | 'agent' }
  | { type: 'reject'; on: boolean; title?: string; desc?: string }
  | { type: 'highlight'; ids: string[] }
  | { type: 'card'; action: 'show' | 'dismiss'; id: string; zone?: string; size?: string; title?: string; body?: string }

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
