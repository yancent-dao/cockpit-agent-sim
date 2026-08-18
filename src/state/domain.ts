/**
 * 领域状态仓 —— 记忆系统的第三级（瞬时=信号 / 会话 / **领域** / 长期）。
 *
 * 队列、历史、收藏不是车辆状态：信号 store 对齐 VSS，它的边界注释早警告过
 * "这条界线不划清，车速转速电流都会往里挤"。它们也不是遥测。
 * 它们是内容域的数据——"下一曲""再放刚才那首""播放我的收藏"能成立的地基。
 *
 * 存储可注入（测试传假的，浏览器传 localStorage）——沿用 clock 注入的先例。
 * **队列刻意不持久化**：它跟播放态绑定，刷新后播放不会恢复，
 * 恢复一条悬空的队列只会让"下一曲"播出用户没在听的东西。
 * 收藏和历史持久化（常用地址、城市选择的 localStorage 先例）。
 */

export interface DomainStorage {
  get(key: string): string | null
  set(key: string, value: string): void
}

/** 一条可播放的内容。字段就是要写进 media.* 信号组的那些 */
export interface QueueTrack {
  source: string
  track: string
  artist: string
  streamUrl: string
  artwork?: string
  videoActive?: boolean
}

export interface QueryEntry { kind: string; entity: string; brief: string }

const memoryStorage = (): DomainStorage => {
  const m = new Map<string, string>()
  return { get: k => m.get(k) ?? null, set: (k, v) => m.set(k, v) }
}

/** 浏览器里用 localStorage，Node（测试/pilot）自动退化为内存 */
export const defaultStorage = (): DomainStorage => {
  try {
    if (typeof localStorage !== 'undefined') return {
      get: k => localStorage.getItem(k),
      set: (k, v) => localStorage.setItem(k, v),
    }
  } catch { /* 隐私模式下 localStorage 会抛 */ }
  return memoryStorage()
}

const HISTORY_CAP = 50
const QUERY_CAP = 20

export function createDomainState(storage: DomainStorage = defaultStorage(),
                                  rng: () => number = Math.random) {
  const load = <T>(key: string, fallback: T): T => {
    try { const raw = storage.get(key); return raw ? JSON.parse(raw) as T : fallback }
    catch { return fallback }   // 存坏了就当没存过，别让一条脏数据废掉整个仓
  }
  const save = (key: string, v: unknown) => { try { storage.set(key, JSON.stringify(v)) } catch { /* 满了就算了 */ } }

  /* ── 队列（会话级，不持久化） ── */
  let qItems: QueueTrack[] = []
  let qCursor = -1
  let qOrigin = ''

  const clampNext = (i: number) => (i >= 0 && i < qItems.length ? i : -1)

  const queue = {
    set(items: QueueTrack[], cursor: number, origin: string) {
      qItems = [...items]; qCursor = clampNext(cursor); qOrigin = origin
    },
    current: () => (qCursor >= 0 ? qItems[qCursor] : null),
    size: () => qItems.length,
    origin: () => qOrigin,
    /** 接下来几首（不动 cursor）——播放器卡的"接下来"块用 */
    peek: (n: number) => qItems.slice(qCursor + 1, qCursor + 1 + n),
    list: () => [...qItems],
    /** 用户手动"下一曲"：任何模式都前进——他都开口了，重放同一首是抬杠 */
    next(_mode?: string): QueueTrack | null {
      const i = clampNext(qCursor + 1)
      if (i < 0) return null
      qCursor = i
      return qItems[i]
    },
    prev(): QueueTrack | null {
      const i = clampNext(qCursor - 1)
      if (i < 0) return null
      qCursor = i
      return qItems[i]
    },
    /** 屏幕点播：跳到第 i 首（0 起）。越界回 null，调用方给人话 */
    jump(i: number): QueueTrack | null {
      const j = clampNext(Math.trunc(i))
      if (j < 0) return null
      qCursor = j
      return qItems[j]
    },
    /**
     * 自动续播（ended 触发）：这里才看模式——
     * repeatOne 重放当前；shuffle 随机挑一首别的；sequential 顺序前进，到尾停。
     */
    advance(mode?: string): QueueTrack | null {
      if (qCursor < 0) return null
      if (mode === 'repeatOne') return qItems[qCursor]
      if (mode === 'shuffle' && qItems.length > 1) {
        let i = qCursor
        while (i === qCursor) i = Math.floor(rng() * qItems.length)
        qCursor = i
        return qItems[i]
      }
      return queue.next(mode)
    },
  }

  /* ── 播放历史（持久化，环形 50） ── */
  let hist = load<QueueTrack[]>('cockpit.history', [])
  const history = {
    push(t: QueueTrack) {
      hist = [t, ...hist].slice(0, HISTORY_CAP)
      save('cockpit.history', hist)
    },
    recent: (n: number) => hist.slice(0, n),
  }

  /* ── 查询历史（持久化，环形 20）——"刚才查的成都多少度"的答案来源 ── */
  let qs = load<QueryEntry[]>('cockpit.queries', [])
  const queries = {
    push(e: QueryEntry) {
      qs = [e, ...qs].slice(0, QUERY_CAP)
      save('cockpit.queries', qs)
    },
    recent: (n: number) => qs.slice(0, n),
  }

  /* ── 收藏（持久化）——修"刷新即丢" ── */
  let favs = load<QueueTrack[]>('cockpit.favorites', [])
  const favorites = {
    /** 返回是否新增。按 streamUrl 判重——同一首歌不同搜索批次的对象不同 */
    add(f: QueueTrack): boolean {
      if (favs.some(x => x.streamUrl === f.streamUrl)) return false
      favs = [...favs, f]
      save('cockpit.favorites', favs)
      return true
    },
    remove(streamUrl: string) {
      favs = favs.filter(x => x.streamUrl !== streamUrl)
      save('cockpit.favorites', favs)
    },
    list: () => [...favs],
  }

  /* ── 歌词（会话级，不持久化——跟队列一个道理：刷新后悬空的歌词只会配错歌） ── */
  const lyricMap = new Map<string, string>()
  const lyrics = {
    set(track: string, lrc: string) {
      lyricMap.set(track, lrc)
      // 上限 8：一路开下来听不了几首，缓存是给"上一曲切回来"用的
      while (lyricMap.size > 8) lyricMap.delete(lyricMap.keys().next().value!)
    },
    for: (track: string): string | null => lyricMap.get(track) ?? null,
  }

  return { queue, history, queries, favorites, lyrics }
}

export type DomainState = ReturnType<typeof createDomainState>
