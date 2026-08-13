import type { Skill } from './index'

/**
 * 生成卡片的设计规范——**场景无关**（产品红线：不许绑场景，"任何意料之外的
 * 需求都能生成美观的卡片"）。教的是怎么把 canvas 卡做得像回事：
 * 结构、配色、图标、图表、代码规范、输出格式。
 */
export const CARDCRAFT_SKILL: Skill = {
  name: '生成卡片',
  whenToUse: '用 canvas 建卡前必读',
  tools: ['card.show', 'card.dismiss'],
  inject: `canvas 卡设计规范（不分内容类型，一律照此）：
【结构】从上到下四段，缺内容的段可省，顺序不乱：
  ① 标题行：flex 两端对齐——左标题 38px/700，右侧弱化补充（日期/范围）22px #5C6675
  ② 主信息：一个 64-80px/800 的核心数字或一句结论；旁边可跟 28px 语义色的变化量
  ③ 内容区：要点逐行 <div>，24-26px、line-height 1.8，行首 emoji 当图标（📈 ⚠️ ✅ 💡）；
     超过 5 行必须提炼——整段长文塞进卡片就是文字墙，宁可少说
  ④ 脚注：20px #8A94A6，来源/时间，来源写名字不写网址
【配色】只用这几个：正文 #1B2430 / 次要 #5C6675 / 弱 #8A94A6 / 强调 #1E6FD9 /
  好·涨 #DB4045 / 坏·跌 #1B9E68 / 警示 #C97A16（涨跌按中国习惯红涨绿跌），别自造颜色
【图表】有数据序列就画 svg，别只写数字：
  折线 <svg viewBox="0 0 560 110" style="width:100%;height:110px">
    <polyline points="…" fill="none" stroke="#1E6FD9" stroke-width="4" stroke-linecap="round"/></svg>
  柱状用若干 <rect>。坐标按真实数据换算（y 越小越靠上），点数 6-10 个就够
【代码规范】只用 div/span/svg + style 属性；布局用 flex；禁 ul/table/style 标签；
  画布不能滚动，超出直接裁——按模板说明里的像素预算排，排不下就删内容不缩字号
【输出】data.html 是纯片段（无 html/body 包裹）；data.text 必填：两句话的纯文字兜底
【收尾】交付卡建好后，把过程中自动上屏的查证/中间结果卡用 card.dismiss 收掉，
  交付物只留一张；语音只说三句以内结论，卡上的内容一个字不念`,
}
