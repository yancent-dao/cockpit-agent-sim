import type { Skill } from './index'

/** 调研报告章法。股价分析、市场调研这类"查证+成文"需求的剧本，交付走生成式卡 */
export const REPORT_SKILL: Skill = {
  name: '调研报告',
  whenToUse: '调研/股价/行情/分析报告',
  tools: ['web.search', 'news.search', 'card.show'],
  inject: `调研报告的章法：
1. 查证：**一次 web.search 通常就够**（问句写全："XX 最近股价走势 涨跌原因"），
   最多补一次 news.search——每次联网搜索要 15 秒以上，搜三四次用户等不起。
   查证过程自动上屏的结果卡不用管，报告卡建好后用 card.dismiss 把它们收掉。
2. 别把长篇报告念出来——语音只说三句以内的结论（涨了跌了、为什么、要不要留意什么）。
3. **交付必须用 canvas 卡（card.show, template=canvas, size=1/2）**：
   报告要排版，list/generic 装不下。骨架：
   <div style="font-size:34px;font-weight:600">标题</div>
   <div style="font-size:64px;font-weight:700">关键数字（涨跌幅/最新价）</div>
   <div style="font-size:26px;color:#5C6675">三到五条结论要点（<div> 逐行，别用 <ul>）</div>
   有时间序列就画一条 SVG 折线（polyline，画布像素见模板说明）。
   data.text 必填：把结论压成两句话当纯文字兜底。
4. 数据没查到就说没查到，报告里绝不编数字——宁可少一节。
5. 用户说"仔细/深入调研"这类大活，用 task.delegate(background:true) 转后台，
   完成会自动通知，别让他干等。`,
}
