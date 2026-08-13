/**
 * 媒体 handler。传输控制不认内容源——不管在放音乐、电台还是短视频，
 * 「暂停」「音量」「收藏」都是同一套动作，这正是 Android Auto MediaSession
 * 和 CarPlay MPRemoteCommandCenter 的模型。内容检索各归各的 CP。
 */
import type { Store } from '../core/store'
import type { DomainState, QueueTrack } from '../state/domain'
import type { Desk } from '../cards/desk'
import type { ToolResult } from '../tools/registry'
import type { Track, ItunesClient } from './itunes'
import type { Station, RadioClient } from './radio'
import type { Article, NewsClient } from './news'
import type { Clip, PexelsClient } from './pexels'
import type { WebSearchClient } from './websearch'

/**
 * 所有候选列表共用一个 key —— 一次只在选一样东西。
 * 实测用户让找动画片、说"算了"转而听儿歌，那张视频候选挂了四轮不走：
 * 用户放弃某个话题是没有机制信号的（那属于意图理解），但"同时只挑一样"
 * 这条约定成立，共用 key 就天然互斥了。
 */
export const CANDIDATES = 'candidates'

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

export interface MediaDeps {
  itunes?: () => ItunesClient
  radio?: () => RadioClient
  news?: () => NewsClient
  pexels?: () => PexelsClient
  websearch?: () => WebSearchClient
  /** 领域状态仓：队列/历史/收藏。不传则收藏退化为内存数组（老测试兼容），队列功能不可用 */
  state?: DomainState
}

/** 把一条队列内容写进 media.* 信号组开播。续播和 next/prev 共用这一条路 */
export function playQueueTrack(store: Store, qt: QueueTrack) {
  store.set('media.source', qt.source)
  store.set('media.track', qt.track)
  store.set('media.artist', qt.artist)
  store.set('media.artwork', qt.artwork ?? '')
  store.set('media.streamUrl', qt.streamUrl)
  store.set('media.videoActive', qt.videoActive ?? false)
  store.set('media.playing', true)
}

/**
 * ended → 自动续播。**机制，零模型调用**（公理 4：没有"理解"成分的事不叫醒模型）。
 * 兑现当年 bus 注释里的约定：『"放完了"是事实，"该放下一首"是决定，归控制面板侧规则管』
 * ——这条"规则"现在建成了。产品收益：iTunes 只给 30 秒试听，
 * 自动续播让歌单像电台一样流动。
 */
export function createAutoplay(store: Store, state: DomainState, clock: () => number = Date.now) {
  let lastAdvance = 0
  return {
    onEnded() {
      /**
       * 保险丝：距上次续播不足 5 秒又收到 ended = 流是坏的（失效预览一打开
       * 就 ended），继续跳只会链式放整个队列——用户听感"每两秒重新放一遍"。
       * 熔断：停播。横幅提示由 director 对 playing 骤停自行处理。
       */
      if (clock() - lastAdvance < 5000) {
        store.set('media.playing', false)
        return
      }
      const qt = state.queue.advance(String(store.get('media.mode') ?? 'sequential'))
      if (qt) { playQueueTrack(store, qt); state.history.push(qt); lastAdvance = clock() }
      else store.set('media.playing', false)   // 到尾了就停，不静音挂着
    },
  }
}

export function createMediaHandlers(store: Store, desk?: () => Desk | undefined, deps: MediaDeps = {}) {
  /** 收藏跨源统一，落域仓持久化（刷新不丢）。不传 state 的老用法退化为内存 */
  const memFavs: QueueTrack[] = []
  const favStore: { add(f: QueueTrack): boolean; remove(u: string): void; list(): QueueTrack[] } =
    deps.state?.favorites ?? {
      add: f => (memFavs.some(x => x.streamUrl === f.streamUrl) ? false : (memFavs.push(f), true)),
      remove: u => { const i = memFavs.findIndex(x => x.streamUrl === u); if (i >= 0) memFavs.splice(i, 1) },
      list: () => [...memFavs],
    }

  /** 上一次搜索结果，用来把"第二个"翻译成具体条目 */
  let lastResults: Track[] = []
  let lastStations: Station[] = []
  let lastArticles: Article[] = []
  let lastClips: Clip[] = []

  type CpKey = Exclude<keyof MediaDeps, 'state'>
  const need = <K extends CpKey>(k: K): NonNullable<ReturnType<NonNullable<MediaDeps[K]>>> => {
    const f = deps[k]
    if (!f) throw new Error(`${k} 能力未装配`)
    return (f as any)() 
  }

  /** 三方失败一律 unavailable —— 语义是"服务不可用"，不是"车不让做" */
  const cpFail = (e: unknown, what: string): ToolResult => ({
    status: 'unavailable', code: 'CP_ERROR',
    message: `${what}暂时不可用：${e instanceof Error ? e.message : String(e)}`,
    suggestion: '稍后再试，或者换个说法',
  })

  const noResult = (q: string): ToolResult => ({
    status: 'unavailable', code: 'NO_RESULT',
    message: `没搜到「${q}」`,
    suggestion: '换个歌名或者歌手名试试',
  })

  const brief = (t: Track) => ({ id: t.id, name: t.name, artist: t.artist, album: t.album, duration: t.duration })
  const sBrief = (s: Station) => ({ id: s.id, name: s.name, country: s.country, tags: s.tags, bitrate: s.bitrate })
  const stationSub = (s: Station) =>
    [s.country, s.tags.split(',')[0]].filter(Boolean).join(' · ')

  /**
   * 搜不到台的原因常常不是"没这个台"，而是筛掉 http 流之后一个不剩。
   * 这个区别要说出来，否则用户以为是搜索不好使
   */
  const cBrief = (c: Clip) => ({ id: c.id, title: c.title, author: c.author, duration: c.duration })
  const aBrief = (a: Article) => ({ title: a.title, source: a.source, publishedAt: a.publishedAt })

  const noNews = (q?: string): ToolResult => ({
    status: 'unavailable', code: 'NO_RESULT',
    message: q ? `没搜到关于「${q}」的新闻` : '这会儿没拿到新闻',
    suggestion: '换个说法或者换个话题试试',
  })

  const showNews = (articles: Article[], title: string) => {
    lastArticles = articles
    desk?.()?.render({
      key: 'news', template: 'list', kind: 'task', ttl: 'untilDismissed',   // 内容卡不定时蒸发（用户点名）
      data: { title, items: articles.map(a => ({ label: a.title, sub: a.source })) },
    })
  }

  const noStation = (q: string): ToolResult => ({
    status: 'unavailable', code: 'NO_RESULT',
    message: `没找到能放的「${q}」。有些台只提供不加密的流，车机放不了`,
    suggestion: '换个台名试试，或者说个分类，比如"来个新闻台""放点爵士"',
  })

  const dismissKey = (key: string) => {
    const d = desk?.()
    const c = d?.findByKey(key)
    if (c) d!.dismiss(c.id)
  }

  const showTracks = (tracks: Track[]) => {
    desk?.()?.render({
      key: CANDIDATES, template: 'list', kind: 'task', ttl: 120, refreshTtl: true,
      data: { title: '搜到这些歌', items: tracks.map(t => ({ label: t.name, sub: `${t.artist} · ${t.album}` })) },
    })
  }

  /** 一次写齐播放状态。少写一个字段，播放器卡就缺一块 */
  const playTrack = (t: Track) => {
    store.set('media.source', 'music')
    store.set('media.track', t.name)
    store.set('media.artist', t.artist)
    store.set('media.artwork', t.artwork)
    store.set('media.streamUrl', t.preview)
    store.set('media.playing', true)
  }

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
        case 'toggle': {
          // 屏幕按钮的语义是"切换"——播放中按一下暂停，暂停中按一下继续。
          // 声明表是静态数据写不了条件，切换逻辑收在机制层这一处
          const to = !store.get('media.playing')
          store.set('media.playing', to)
          return { status: 'ok', data: { playing: to }, message: to ? '继续放' : '先停一下' }
        }
        case 'play':
          store.set('media.playing', true)
          return { status: 'ok', data: { playing: true }, changed: ['media.playing'] }
        case 'pause':
          store.set('media.playing', false)
          return { status: 'ok', data: { playing: false }, changed: ['media.playing'] }
        case 'stop':
          // 停止不是暂停：把正在播的内容整个清掉，播放器卡也跟着退场
          for (const [k, v] of [['media.playing', false], ['media.source', 'none'],
            ['media.streamUrl', ''], ['media.track', ''], ['media.artist', ''], ['media.artwork', ''],
            ['media.videoActive', false]] as const)
            store.set(k as string, v as any)
          return { status: 'ok', data: { stopped: true } }
        case 'next':
        case 'prev': {
          if (cur.source === 'radio') return radioNo('切上下首')
          const st = deps.state
          if (!st || !st.queue.size()) return {
            status: 'unavailable', code: 'NO_QUEUE',
            message: '还没有播放列表，一次只放一首',
            suggestion: '直接说下一首想听什么',
          }
          // 手动切换任何模式都前进——用户都开口了，单曲循环还重放同一首是抬杠
          const qt = args.action === 'next' ? st.queue.next() : st.queue.prev()
          if (!qt) return {
            status: 'unavailable', code: 'QUEUE_END',
            message: args.action === 'next' ? '已经是最后一首了' : '已经是第一首了',
            suggestion: '想听别的直接点歌',
          }
          playQueueTrack(store, qt)
          st.history.push(qt)
          return { status: 'ok', data: { playing: qt }, message: `切到${qt.track}（${qt.artist}）` }
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

    mediaQueue: (): ToolResult => {
      const st = deps.state
      if (!st || !st.queue.size()) return {
        status: 'unavailable', code: 'NO_QUEUE',
        message: '现在没有播放列表',
        suggestion: '点一首歌，同一批搜索结果会自动排进队列',
      }
      const upcoming = st.queue.peek(5)
      return {
        status: 'ok',
        data: { current: st.queue.current(), upcoming, recent: st.history.recent(5), origin: st.queue.origin() },
        message: upcoming.length
          ? `接下来：${upcoming.map(x => x.track).join('、')}`
          : '这是队列里最后一首了',
      }
    },

    mediaFavorite: (): ToolResult => {
      const cur = nowPlaying()
      if (!cur) return NOTHING
      if (!favStore.add(cur))
        return { status: 'ok', data: { already: true }, message: `${cur.track} 已经在收藏里了` }
      return { status: 'ok', data: { saved: cur }, message: `收藏了 ${cur.track}` }
    },

    /* ══════════ 音乐（iTunes） ══════════ */

    musicSearch: async (args: any): Promise<ToolResult> => {
      try {
        const tracks = await need('itunes').search(args.query, args.limit ?? 8)
        if (!tracks.length) return noResult(args.query)
        lastResults = tracks
        showTracks(tracks)
        return { status: 'ok', data: { tracks: tracks.map(brief) } }
      } catch (e) { return cpFail(e, '音乐搜索') }
    },

    musicPlay: async (args: any): Promise<ToolResult> => {
      try {
        // 给了关键词就现搜现播，省掉"先 search 再 play"的一轮往返
        let track = args.trackId ? lastResults.find(t => t.id === Number(args.trackId)) : undefined
        if (!track) {
          const q = args.query ?? String(args.trackId ?? '')
          const found = await need('itunes').search(q, 5)
          if (!found.length) return noResult(q)
          lastResults = found
          track = found[0]
        }
        playTrack(track)
        // 同批搜索结果整批入队——"下一曲"从此有的放矢
        deps.state?.queue.set(lastResults.map(t => ({
          source: 'music', track: t.name, artist: t.artist, artwork: t.artwork, streamUrl: t.preview,
        })), lastResults.indexOf(track), 'search')
        deps.state?.history.push({ source: 'music', track: track.name, artist: track.artist, streamUrl: track.preview })
        dismissKey(CANDIDATES)   // 选完了，候选就翻篇了
        return {
          status: 'ok',
          data: { playing: brief(track) },
          // 只有 30 秒是 iTunes 的硬限制。不在返回里说清楚，Agent 会以为能放整首
          message: `在放${track.name}（${track.artist}）。iTunes 只提供 30 秒预览，放完就停`,
        }
      } catch (e) { return cpFail(e, '音乐播放') }
    },

    /* ══════════ 电台（Radio Browser） ══════════ */

    radioSearch: async (args: any): Promise<ToolResult> => {
      try {
        const stations = await need('radio').search({
          name: args.query, tag: args.category, country: args.country, language: args.language,
          limit: args.limit ?? 10,
        })
        if (!stations.length) return noStation(args.query ?? args.category ?? '')
        lastStations = stations
        desk?.()?.render({
          key: CANDIDATES, template: 'list', kind: 'task', ttl: 120, refreshTtl: true,
          data: {
            title: '搜到这些台',
            items: stations.map(s => ({ label: s.name, sub: stationSub(s) })),
          },
        })
        return { status: 'ok', data: { stations: stations.map(sBrief) } }
      } catch (e) { return cpFail(e, '电台搜索') }
    },

    radioPlay: async (args: any): Promise<ToolResult> => {
      try {
        let st = args.stationId ? lastStations.find(s => s.id === args.stationId) : undefined
        if (!st) {
          const q = args.query ?? String(args.stationId ?? '')
          const found = await need('radio').search({ name: q, limit: 5 })
          if (!found.length) return noStation(q)
          lastStations = found
          st = found[0]
        }
        store.set('media.source', 'radio')
        store.set('media.track', st.name)
        // 电台没有"艺人"，放地区和分类比留空有用
        store.set('media.artist', stationSub(st))
        store.set('media.artwork', st.favicon)
        store.set('media.streamUrl', st.url)
        store.set('media.playing', true)
        dismissKey(CANDIDATES)
        return { status: 'ok', data: { playing: sBrief(st) }, message: `在放 ${st.name}` }
      } catch (e) { return cpFail(e, '电台播放') }
    },

    /* ══════════ 新闻（NewsAPI） ══════════ */

    newsHeadlines: async (args: any): Promise<ToolResult> => {
      try {
        const lang = args.language ?? 'zh'
        const { articles, real } = await need('news').headlines(args.category ?? 'general', lang)
        if (!articles.length) return noNews()
        showNews(articles, real ? '今日头条' : '今天的新闻')
        return {
          status: 'ok',
          data: { real, articles: articles.map(aBrief) },
          // real=false 时必须说清楚，否则 Agent 会张口就是"这是今天的头条"
          message: real
            ? undefined
            : '这不是编辑推荐的头条，是按关键词搜出来、按时间排的最新几条，播报时别说"头条"',
        }
      } catch (e) { return cpFail(e, '新闻') }
    },

    newsSearch: async (args: any): Promise<ToolResult> => {
      try {
        const articles = await need('news').search(args.query, args.language ?? 'zh')
        if (!articles.length) return noNews(args.query)
        showNews(articles, `关于「${args.query}」`)
        return { status: 'ok', data: { articles: articles.map(aBrief) } }
      } catch (e) { return cpFail(e, '新闻搜索') }
    },

    newsRead: (args: any): ToolResult => {
      if (!lastArticles.length)
        return {
          status: 'rejected', code: 'NO_LIST',
          message: '还没列过新闻',
          suggestion: '先说想看哪方面的新闻，我列出来再读给你听',
        }
      const i = Number(args.index ?? 1)
      const a = lastArticles[i - 1]
      if (!a)
        return {
          status: 'rejected', code: 'OUT_OF_RANGE',
          message: `只有 ${lastArticles.length} 条`,
          suggestion: `说 1 到 ${lastArticles.length} 之间的序号`,
        }
      return {
        status: 'ok',
        data: {
          title: a.title, source: a.source,
          // NewsAPI 免费层只给 200 字正文，摘要往往比它完整，两个都给
          text: [a.description, a.content].filter(Boolean).join(' '),
        },
      }
    },

    /* ══════════ 短视频（Pexels） ══════════ */

    videoSearch: async (args: any): Promise<ToolResult> => {
      try {
        const clips = await need('pexels').search(args.query, args.limit ?? 8)
        if (!clips.length) return noResult(args.query)
        lastClips = clips
        desk?.()?.render({
          key: CANDIDATES, template: 'list', kind: 'task', ttl: 120, refreshTtl: true,
          data: { title: '找到这些视频', items: clips.map(c => ({ label: c.title, sub: `${c.author} · ${c.duration}秒` })) },
        })
        return { status: 'ok', data: { clips: clips.map(cBrief) } }
      } catch (e) { return cpFail(e, '短视频搜索') }
    },

    videoPlay: async (args: any): Promise<ToolResult> => {
      try {
        let clip = args.videoId ? lastClips.find(c => c.id === Number(args.videoId)) : undefined
        if (!clip) {
          const q = args.query ?? String(args.videoId ?? '')
          const found = await need('pexels').search(q, 5)
          if (!found.length) return noResult(q)
          lastClips = found
          clip = found[0]
        }
        // 先过安全约束再写任何播放状态。反过来的话被拒时会留下
        // "在放视频但画面没开"的半吊子状态，播放器卡就出来了
        const gate = store.set('media.videoActive', true)
        if (gate.status !== 'ok')
          return { status: 'rejected', code: gate.code ?? 'VIDEO_WHILE_DRIVING',
            message: gate.message ?? '车在动，视频画面不能开', suggestion: gate.suggestion }

        store.set('media.source', 'video')
        store.set('media.track', clip.title)
        store.set('media.artist', clip.author)
        store.set('media.artwork', clip.cover)
        store.set('media.streamUrl', clip.url)
        store.set('media.playing', true)
        dismissKey(CANDIDATES)
        return { status: 'ok', data: { playing: cBrief(clip) }, message: `在放${clip.title}` }
      } catch (e) { return cpFail(e, '短视频播放') }
    },

    /* ══════════ 联网搜索（OpenRouter :online） ══════════ */

    webSearch: async (args: any): Promise<ToolResult> => {
      try {
        const { brief, detail } = await need('websearch').search(args.query)
        // 详细内容只进卡片。语音念完就没了，数字和人名尤其记不住，得让用户能回看
        desk?.()?.render({
          key: 'websearch', template: 'generic', size: '1/2', kind: 'task', ttl: 'untilDismissed',
          data: { title: args.query, text: detail },
        })
        // **只把一句话结论返回给 Agent**。给全文的话它会整段念——实测 366 字。
        // 这是机制，不是嘱咐
        return { status: 'ok', data: { answer: brief, detailOnScreen: true },
          message: '详细内容已经在屏幕上了，你只需要说这一句结论' }
      } catch (e) { return cpFail(e, '联网搜索') }
    },

    mediaFavorites: (): ToolResult => {
      if (favStore.list().length)
        desk?.()?.render({
          key: 'favorites', template: 'list', kind: 'task', ttl: 'untilDismissed',
          data: {
            title: '我的收藏',
            items: favStore.list().map(f => ({ label: f.track, sub: `${f.artist} · ${SRC_CN[f.source] ?? f.source}` })),
          },
        })
      return { status: 'ok', data: { items: favStore.list() } }
    },
  }
}

const SRC_CN: Record<string, string> = { music: '音乐', radio: '电台', video: '视频' }
