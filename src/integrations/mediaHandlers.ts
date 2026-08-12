/**
 * 媒体 handler。传输控制不认内容源——不管在放音乐、电台还是短视频，
 * 「暂停」「音量」「收藏」都是同一套动作，这正是 Android Auto MediaSession
 * 和 CarPlay MPRemoteCommandCenter 的模型。内容检索各归各的 CP。
 */
import type { Store } from '../core/store'
import type { Desk } from '../cards/desk'
import type { ToolResult } from '../tools/registry'

export interface Favorite {
  source: string
  track: string
  artist: string
  streamUrl: string
  artwork: string
}

const NOTHING: ToolResult = {
  status: 'rejected', code: 'NOTHING_PLAYING',
  message: '现在没在放东西',
  suggestion: '说个歌名或者电台名，我放给你听',
}

/** 电台是直播流，切歌/进度/播放模式这些对它没意义 */
const radioNo = (what: string): ToolResult => ({
  status: 'rejected', code: 'NOT_APPLICABLE',
  message: `在放电台，${what}对直播流没用`,
  suggestion: '想换台的话说个台名，或者让我给你放歌',
})

export function createMediaHandlers(store: Store, desk?: () => Desk | undefined) {
  /** 收藏跨源统一：歌和电台放一份里，用户说"我收藏的"不用分是哪类 */
  const favorites: Favorite[] = []

  const nowPlaying = (): Favorite | null =>
    store.get('media.source') === 'none' || !store.get('media.track')
      ? null
      : {
          source: String(store.get('media.source')),
          track: String(store.get('media.track')),
          artist: String(store.get('media.artist')),
          streamUrl: String(store.get('media.streamUrl')),
          artwork: String(store.get('media.artwork')),
        }

  return {
    mediaControl: (args: any): ToolResult => {
      const cur = nowPlaying()
      if (!cur) return NOTHING
      switch (args.action) {
        case 'play':
          store.set('media.playing', true)
          return { status: 'ok', data: { playing: true }, changed: ['media.playing'] }
        case 'pause':
          store.set('media.playing', false)
          return { status: 'ok', data: { playing: false }, changed: ['media.playing'] }
        case 'stop':
          // 停止不是暂停：把正在播的内容整个清掉，播放器卡也跟着退场
          for (const [k, v] of [['media.playing', false], ['media.source', 'none'],
            ['media.streamUrl', ''], ['media.track', ''], ['media.artist', ''], ['media.artwork', '']] as const)
            store.set(k as string, v as any)
          return { status: 'ok', data: { stopped: true } }
        case 'next':
        case 'prev':
          if (cur.source === 'radio') return radioNo('切上下首')
          return {
            status: 'unavailable', code: 'NO_QUEUE',
            message: '还没有播放列表，一次只放一首',
            suggestion: '直接说下一首想听什么',
          }
        default:
          return { status: 'rejected', code: 'INVALID_PARAMS', message: `不认识的动作 ${args.action}` }
      }
    },

    mediaVolume: (args: any): ToolResult => {
      const cur = Number(store.get('media.volume'))
      // 夹在范围里而不是报错——用户说"再大点"时不该因为已经很大了就失败
      const next = Math.max(0, Math.min(100,
        args.level !== undefined ? Number(args.level) : cur + Number(args.delta ?? 0)))
      store.set('media.volume', next)
      return { status: 'ok', data: { volume: next }, changed: ['media.volume'] }
    },

    mediaSeek: (args: any): ToolResult => {
      const cur = nowPlaying()
      if (!cur) return NOTHING
      if (cur.source === 'radio') return radioNo('快进快退')
      // 进度不在信号里（它是遥测不是状态），车机屏那边自己跳
      return {
        status: 'ok',
        data: { seek: args.position !== undefined ? { to: args.position } : { by: args.delta } },
        message: '好',
      }
    },

    mediaMode: (args: any): ToolResult => {
      if (store.get('media.source') === 'radio') return radioNo('播放模式')
      store.set('media.mode', args.mode)
      return { status: 'ok', data: { mode: args.mode }, changed: ['media.mode'] }
    },

    mediaQueue: (): ToolResult => ({
      status: 'unavailable', code: 'NO_QUEUE',
      message: '这台车一次只放一首，没有播放列表',
      suggestion: '想连着听的话，说个歌手或者风格，我一首一首放',
    }),

    mediaFavorite: (): ToolResult => {
      const cur = nowPlaying()
      if (!cur) return NOTHING
      if (favorites.some(f => f.streamUrl === cur.streamUrl))
        return { status: 'ok', data: { already: true }, message: `${cur.track} 已经在收藏里了` }
      favorites.push(cur)
      return { status: 'ok', data: { saved: cur }, message: `收藏了 ${cur.track}` }
    },

    mediaFavorites: (): ToolResult => {
      if (favorites.length)
        desk?.()?.render({
          key: 'favorites', template: 'list', kind: 'task', ttl: 120, refreshTtl: true,
          data: {
            title: '我的收藏',
            items: favorites.map(f => ({ label: f.track, sub: `${f.artist} · ${SRC_CN[f.source] ?? f.source}` })),
          },
        })
      return { status: 'ok', data: { items: favorites } }
    },
  }
}

const SRC_CN: Record<string, string> = { music: '音乐', radio: '电台', video: '视频' }
