/**
 * NewsAPI 适配。
 *
 * 两个实测出来的落差，选它时就认了：
 *
 * 1. **`country=cn` 的头条返回 0 条**（加 category 也是 0）。中文只能走
 *    everything 搜索，源偏窄（36氪、IT之家这类科技媒体为主）。所以
 *    headlines 按语言分流：中文用 everything + 领域关键词 + 按时间排，
 *    英文走真 top-headlines。返回里带 `real` 标明是不是真头条，
 *    让 Agent 有机会说"我给你搜了今天的科技新闻"而不是"这是今天的头条"。
 *
 * 2. **免费层 CORS 只对 localhost 开放，且明确禁止部署**，100 次/天。
 *    新闻是唯一一个只在 npm run dev 下能演的能力。要拿出去演示得换国内 CP，
 *    那时候重写这个文件就行，Tool 契约不用动。
 */
import type { Fetcher } from './amap'
import { api, UPSTREAM } from '../config/upstream'

export interface Article {
  title: string
  description: string
  content: string
  source: string
  url: string
  image: string
  publishedAt: string
}

export class NewsError extends Error {
  constructor(message: string, readonly code?: string) { super(message) }
}

/** 中文没有真头条，用领域关键词凑——这是 NewsAPI 的限制不是我们的选择 */
const ZH_TOPIC: Record<string, string> = {
  general: '中国 OR 国际 OR 社会',
  technology: '科技 OR 人工智能 OR 互联网',
  business: '经济 OR 市场 OR 财经',
  sports: '体育 OR 比赛',
  entertainment: '娱乐 OR 电影 OR 明星',
  health: '健康 OR 医疗',
  science: '科学 OR 研究',
}

const toArticle = (a: any): Article => ({
  title: a.title ?? '',
  description: a.description ?? '',
  // content 被 NewsAPI 截断成 200 字并带 "[+1234 chars]" 尾巴，去掉更干净
  content: String(a.content ?? '').replace(/\s*\[\+\d+\s*chars\]\s*$/, ''),
  source: a.source?.name ?? '',
  url: a.url ?? '',
  image: a.urlToImage ?? '',
  publishedAt: a.publishedAt ?? '',
})

export interface NewsResult {
  articles: Article[]
  /** 是不是真·头条。中文永远是 false，话术里不能说"头条" */
  real: boolean
}

export function createNewsClient(fetcher: Fetcher, key: () => string) {
  async function get(path: string, params: Record<string, string>): Promise<any> {
    const k = key()
    if (!k) throw new NewsError('没配新闻服务的 Key', 'NO_KEY')
    const p = new URLSearchParams({ ...params, apiKey: k, pageSize: params.pageSize ?? '8' })
    /**
     * 代理失败退直连（2026-08-17 实测）：newsapi.org 在 Node 侧被 DNS 污染
     * （解析到 108.160.169.171 超时），浏览器侧常因系统代理是通的。
     * 可达性的墙代理不解决——接管道不能把原本能用的弄坏。
     */
    let res
    try { res = await fetcher(`${api('newsapi')}/v2/${path}?${p}`) }
    catch { res = await fetcher(`${UPSTREAM.newsapi}/v2/${path}?${p}`) }
    const json = await res.json()
    if (json.status !== 'ok')
      throw new NewsError(json.message ?? '新闻服务返回异常', json.code ?? 'NEWS_ERROR')
    return json
  }

  return {
    /** 分类头条。中文降级成关键词搜索并如实标注 */
    async headlines(category = 'general', lang = 'zh'): Promise<NewsResult> {
      if (lang === 'zh') {
        const json = await get('everything', {
          q: ZH_TOPIC[category] ?? ZH_TOPIC.general,
          language: 'zh', sortBy: 'publishedAt',
        })
        return { articles: (json.articles ?? []).map(toArticle), real: false }
      }
      const json = await get('top-headlines', { category, language: 'en' })
      return { articles: (json.articles ?? []).map(toArticle), real: true }
    },

    async search(query: string, lang = 'zh'): Promise<Article[]> {
      const json = await get('everything', { q: query, language: lang, sortBy: 'publishedAt' })
      return (json.articles ?? []).map(toArticle)
    },
  }
}

export type NewsClient = ReturnType<typeof createNewsClient>
