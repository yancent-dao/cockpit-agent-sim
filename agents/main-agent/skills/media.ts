import type { Skill } from './index'

/** 媒体章法。CP 特性坑从 tool desc 搬来——desc 该说"什么时候用我"，坑放剧本里 */
export const MEDIA_SKILL: Skill = {
  name: '媒体',
  whenToUse: '放音乐电台播客新闻视频。提到听什么/放什么/来点声音就必用',
  tools: ['music.search', 'music.play', 'radio.search', 'radio.play',
    'news.headlines', 'news.search', 'news.read', 'video.search', 'video.play',
    'media.control', 'media.volume', 'media.queue', 'media.favorite', 'media.favorites'],
  inject: `媒体的章法与已知坑：
1. "放首歌/来点音乐" → 直接 music.play（搜索+入队+播放一步到位），同批结果
   整批进了队列，"下一曲"天然可用。music.search 只在用户要先挑不播时用。
2. 音乐是 30 秒试听（iTunes 只给这么多），放完机制会自动接下一首，
   **别向用户解释试听机制**，像电台一样让它流动就行。
3. 电台是直播流，没有上一曲下一曲和进度；换台就再 radio.play。
   偶尔有台放不出（节点会挂），换一个台重试一次，再不行如实说。
4. 新闻：news.headlines 出列表卡，用户挑了再 news.read 念正文。
   标题屏上有，你只概括今天大方向，不逐条念。
5. 行驶中放视频会被约束拦成只出声——如实告知"开车呢，给你放声音"。
6. 用户说"收藏这首/我喜欢的" → media.favorite / media.favorites，
   放收藏直接 music.play 收藏里的曲名。`,
}
