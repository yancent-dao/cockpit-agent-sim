/**
 * 媒体卡分源样式表（媒体卡重设计 v2 §03，2026-08-19）。
 *
 * 五源共用同一套骨架（顶行元信息带 / 主区 / 底带），**差异全部由这张表驱动**：
 * 弥散色、徽标、进度带形态、主控语义。渲染代码里不许出现
 * `if source === 'music'` 的散逻辑——加新源 = 这里加一行。
 */

export interface SourceStyle {
  /** 徽标文案（含 emoji 图形） */
  badge: string
  /** 徽标底色 / 主键色 */
  accent: string
  /** 弥散底（低饱和，垫在白玻璃下，强度 ≤ .14） */
  glow: string
  /**
   * 进度带形态：
   * bar     可点定位的进度条 + 剩余时间（音乐/播客/新闻）
   * live    直播——电平动画 + 已收听时长，无进度（电台）
   * overlay 沉入画面底部渐隐浮层（视频）
   */
  progress: 'bar' | 'live' | 'overlay'
  /**
   * 主控语义：
   * tracks 上一首/下一首（音乐；新闻=上一条/下一条）
   * skip   ±15s/+30s 贴主键（播客）
   * single 只有播放/暂停（电台，直播没有上下）
   */
  ctl: 'tracks' | 'skip' | 'single'
}

export const SOURCE_STYLE: Record<string, SourceStyle> = {
  music: { badge: '♫ 音乐', accent: '#1D4ED8', glow: 'rgba(36,86,201,.13)', progress: 'bar', ctl: 'tracks' },
  radio: { badge: '📻 电台', accent: '#C05A14', glow: 'rgba(224,122,42,.12)', progress: 'live', ctl: 'single' },
  podcast: { badge: '🎙 播客', accent: '#6D28D9', glow: 'rgba(124,58,237,.10)', progress: 'bar', ctl: 'skip' },
  news: { badge: '📰 新闻播报', accent: '#1E40AF', glow: 'rgba(30,64,175,.10)', progress: 'bar', ctl: 'tracks' },
  video: { badge: '🎬 视频', accent: '#0B0F16', glow: 'rgba(11,15,22,.10)', progress: 'overlay', ctl: 'tracks' },
}

/** 未知源回退音乐样式——新源上线前这里先不炸 */
export const sourceStyle = (s: string): SourceStyle => SOURCE_STYLE[s] ?? SOURCE_STYLE.music
