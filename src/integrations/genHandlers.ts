/**
 * 生成式媒体 handlers：视频生成 · 音乐生成（OpenRouter 白捡批）。
 *
 * 视频要 30 秒到几分钟——**不能占着工具超时干等**：立即返回"在生成"，
 * 后台等结果，好了直接接管播放（媒体信号一变，播放器卡自己出来）。
 * 行驶禁播视频的约束照走 media.videoActive 那道闸，生成的和搜来的一视同仁。
 */
import type { Store } from '../core/store'
import type { ToolResult } from '../tools/registry'
import type { VideoGenClient } from './orvideo'
import type { MusicGenClient } from './ormusic'

export function createGenHandlers(
  store: Store,
  orvideo: () => VideoGenClient | undefined,
  ormusic: () => MusicGenClient | undefined,
) {
  /** 一次写齐播放态（跟 mediaHandlers.playTrack 同责）。gate=约束闸的结果 */
  const play = (source: string, track: string, url: string, artwork = '') => {
    // setMany：一次通知，不漏中间态（同 mediaHandlers.playTrack）
    store.setMany([
      ['media.source', source],
      ['media.track', track],
      ['media.artist', 'AI 生成'],
      ['media.artwork', artwork],
      ['media.streamUrl', url],
      ['media.playing', true],
    ])
  }

  return {
    videoGenerate: async (args: any): Promise<ToolResult> => {
      const cp = orvideo()
      if (!cp) return { status: 'unavailable', code: 'NO_CP', message: '视频生成没配（要 OpenRouter Key）' }
      const prompt = String(args.prompt ?? '').trim()
      if (!prompt) return { status: 'rejected', code: 'INVALID_PARAMS', message: '要生成什么样的视频？' }
      // 立即返回，后台等。生成完先过行驶禁播的闸再接管播放
      void cp.generate(prompt, { model: args.model, duration: args.duration, ratio: args.ratio })
        .then(({ url }) => {
          const gate = store.set('media.videoActive', true)
          if (gate.status !== 'ok') return   // 车在动：不弹画面。约束的解释权在闸那里
          play('video', `生成：${prompt.slice(0, 20)}`, url)
        })
        .catch(() => { /* 失败静默——演示场景下横幅归属后续打磨 */ })
      return { status: 'ok', data: { started: true },
        message: '视频在生成了，通常要一两分钟，好了会自动开始放（约 1-2 元一条）' }
    },

    musicGenerate: async (args: any): Promise<ToolResult> => {
      const cp = ormusic()
      if (!cp) return { status: 'unavailable', code: 'NO_CP', message: '音乐生成没配（要 OpenRouter Key）' }
      const prompt = String(args.prompt ?? '').trim()
      if (!prompt) return { status: 'rejected', code: 'INVALID_PARAMS', message: '要什么样的音乐？' }
      try {
        const blob = await cp.generate(prompt, { instrumental: args.instrumental })
        const url = URL.createObjectURL(blob)
        play('music', `生成：${prompt.slice(0, 20)}`, url)
        return { status: 'ok', data: { seconds: 30 },
          message: `写好了，在放。30 秒的小段子，想要完整歌曲说一声（约 3 毛一段）` }
      } catch (e) {
        return { status: 'failed', code: 'MUSIC_ERROR', message: `音乐没生成出来：${e instanceof Error ? e.message : e}` }
      }
    },
  }
}
