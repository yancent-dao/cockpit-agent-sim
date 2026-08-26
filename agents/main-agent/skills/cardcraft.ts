import type { Skill } from './index'

/**
 * 生成卡片的设计规范——**场景无关**（产品红线：不许绑场景，"任何意料之外的
 * 需求都能生成美观的卡片"）。教的是怎么把 canvas 卡做得像回事：
 * 结构、配色、图标、图表、代码规范、输出格式。
 */
export const CARDCRAFT_SKILL: Skill = {
  name: '生成卡片',
  whenToUse: '用 canvas 自由排版建卡。做报告/图表/自定义界面前必读',
  tools: ['card.show', 'card.dismiss'],
  inject: `canvas 卡设计规范（不分内容类型，一律照此）。
【铁律】卡片环境已内置一套 HMI 类，**只用类拼结构，不手写 style 排版**——
你挑类填内容，版式就不会错。可用类（就这些，别自造）：
  .hd（标题行）> b 标题 + i 右侧弱化说明
  .hero（主信息）> b 核心大数字/一句结论 + em 变化量（配 .up 红涨/.down 绿跌）
  .rows > .row（要点行）> span.ic 行首 emoji 图标 + 正文 + small 附注
  .grid2 > .cell（两列小格，对比/多指标用）
  .pill（标签）　.foot（脚注：来源/时间，写名字不写网址）
  语义色类：.up .down .good .bad .warn .acc
【骨架示例】（填空，别改结构）：
<div class="hd"><b>今日行情</b><i>08-18 收盘</i></div>
<div class="hero"><b>1286.21</b><em class="down">-6.88 (-0.53%)</em></div>
<div class="rows">
  <div class="row"><span class="ic">📈</span>成交额放大三成<small>较昨日</small></div>
  <div class="row"><span class="ic">💡</span>机构目标价中位数 191</div>
</div>
<div class="foot">数据来自腾讯行情</div>
【图表】有数据序列就画 svg（唯一允许手写样式的地方）：
  <svg viewBox="0 0 560 110" style="width:100%;height:110px">
  <polyline points="…" fill="none" stroke="#1E6FD9" stroke-width="4" stroke-linecap="round"/></svg>
  柱状用 <rect> 填 #1E6FD9；涨跌色 #DB4045 / #1B9E68。坐标按真实数据换算，6-10 个点
【负面清单】以下直接算错：整卡居中、渐变背景、自造颜色、style 里写字号边距、
  超过 5 行的 .row（提炼！）、ul/table/style 标签、指望滚动（超出即裁，删内容不缩字号）
【尺寸】竖向内容（排行/长列表/成文）用 2/3 或 tower；横向信息流 1/2；单指标 1/6
【输出】data.html 纯片段（无 html/body）；data.text 必填：两句话纯文字兜底
【收尾】交付卡建好后 card.dismiss 收掉过程中的中间结果卡，交付物只留一张；
  语音三句以内说结论，卡上内容一个字不念`,
}
