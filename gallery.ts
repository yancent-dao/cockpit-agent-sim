/**
 * 卡片画廊 —— **开发用**，不进产品路径。
 *
 * 把每张模板在自己声明的每个档位下真渲染一遍，按真实像素比例排出来。
 * 存在的理由：「相邻两档内容必须不同」这条纪律靠单测只能验到 blocks，
 * 版式挤不挤、空不空必须用眼睛看，而一张张手动摆出来太慢。
 */
import { CARD_TEMPLATES } from './src/config/cards'
import { CARD_FORMS } from './src/config/forms'
import { cardBody, tierClass, accentClass } from './src/screen/render'
import { boxOf } from './src/config/grid'
import { tokensFor } from './src/design/tokens'

const S = 0.34
const st = document.createElement('style')
st.textContent = tokensFor('screen') + `
.card{position:relative;border:1px solid rgba(255,255,255,.62);background:rgba(255,255,255,.72);
  border-radius:var(--r-l);box-shadow:0 18px 50px -18px rgba(0,0,0,.5);overflow:hidden;
  padding:calc(22px*var(--u)) calc(26px*var(--u));display:flex;flex-direction:column;color:var(--tx-1)}
.card>h3{flex:none;display:flex;align-items:center;gap:calc(12px*var(--u));
  margin-bottom:calc(12px*var(--u));font-size:calc(var(--t-title)*var(--u));
  font-weight:500;color:var(--tx-2);letter-spacing:.06em}
.bd{flex:1;min-height:0;display:flex;flex-direction:column}
`
document.head.append(st)
// 车机屏的完整样式表也拉进来，否则各模板的排版全是裸的
fetch('/screen.html').then(r => r.text()).then(html => {
  const css = html.match(/<style>([\s\S]*?)<\/style>/)?.[1] ?? ''
  const s2 = document.createElement('style'); s2.textContent = css; document.head.append(s2)
})

const DATA: Record<string, any> = {
  control: { title: '车窗', items: [{ label: '主驾', value: 60, unit: '%' }, { label: '副驾', value: 0, unit: '%' }, { label: '左后', value: 0, unit: '%' }, { label: '右后', value: 0, unit: '%' }] },
  confirm: { title: '需要确认', question: '要打开车门吗？', why: '开门是不可逆操作，所以每次都问一句', options: ['确认', '取消'] },
  feedback: { title: '车窗', text: '已开窗', detail: '主驾车窗已开到 60%' },
  notice: { title: '没能执行', text: '行驶中不能开车门', why: '车速 42 km/h，车门锁定是行车安全策略', suggestion: '停稳挂 P 挡之后再说一次就行' },
  list: { title: '搜索结果', items: Array.from({ length: 16 }, (_, i) => ({ label: `${i + 1} 春熙路${i}`, sub: `${(i * 0.7 + 1).toFixed(1)}km` })) },
  info: { title: '车况', text: '胎压正常，电量 68%，续航约 420 公里。', items: [{ label: '四轮胎压', value: '2.4 bar' }, { label: '下次保养', value: '3200 km' }] },
  weather: { title: '成都天气', now: { temperature: 30, weather: '晴', wind: '东南风 2 级', humidity: 58 }, range: { high: 31, low: 22 }, hourly: Array.from({ length: 12 }, (_, i) => ({ hour: 10 + i, temp: 26 + (i % 5), pop: i === 6 ? 70 : 10 })), forecast: Array.from({ length: 5 }, (_, i) => ({ date: `2026-08-1${i + 5}`, dayTemp: 31 - i, nightTemp: 22 - i })) },
  capability: { title: '我能做的事', items: Array.from({ length: 30 }, (_, i) => ({ label: '能力' + i, desc: '一句话说明' })) },
  storybook: { title: '妞妞和小熊的雨天', chapter: 1, page: 2, total: 3, pending: 1, line: '小雨点打在桥上，妞妞把伞举得高高的，说：「小熊，你躲进来吧。」', ideas: ['会飞的自行车', '会说话的路灯'] },
  carousel: { title: '附近的咖啡馆', page: 0, items: Array.from({ length: 8 }, (_, i) => ({ label: ['三联咖啡', 'Manner', '星巴克臻选', '% Arabica', "Peet's", '瑞幸', '皮爷', 'Seesaw'][i], sub: `${(i * 0.4 + 0.4).toFixed(1)}km · 4.${5 + (i % 4)}分` })) },
  compare: { title: '三条路线', columns: [{ label: '推荐', badge: '最快', rows: [{ k: '到达', v: '14:26', best: true }, { k: '距离', v: '6.2km' }, { k: '过路费', v: '0' }] }, { label: '避拥堵', badge: '＋4 分', rows: [{ k: '到达', v: '14:30' }, { k: '距离', v: '7.8km' }, { k: '过路费', v: '0' }] }, { label: '走高速', badge: '−3 分', rows: [{ k: '到达', v: '14:23' }, { k: '距离', v: '9.4km' }, { k: '过路费', v: '10 元' }] }] },
  progress: { title: '后台任务 · 3 件', items: [{ label: '查上证行情', state: 'running', detail: '已查完 2/3 数据源', percent: 64 }, { label: '查明天天气', state: 'done', detail: '已完成 · 点开看' }, { label: '整理会议纪要', state: 'running', detail: '排队中', percent: 0 }] },
  metric: { title: '续航', value: 420, unit: '公里', sub: '电量 68% · 空调开着', percent: 68, trend: '↑2' },
  chart: { title: '近 7 天电耗', kind: 'bar', unit: 'kWh/100km', series: [{ label: '周一', value: 13 }, { label: '周二', value: 17 }, { label: '周三', value: 11 }, { label: '周四', value: 21 }, { label: '周五', value: 15 }, { label: '周六', value: 9 }, { label: '周日', value: 16 }] },
  image: { title: '宽窄巷子', url: '', caption: '成都市青羊区金河路口', meta: '距您 3.4 公里' },
  generic: { title: '车况', text: '胎压正常，电量 68%。', items: [{ label: '左前', value: 2.4 }, { label: '右前', value: 2.4 }] },
}

const wrap = document.getElementById('wrap')!
for (const t of CARD_TEMPLATES) {
  if (!CARD_FORMS[t.id] || !t.sizes) continue
  const h2 = document.createElement('h2')
  h2.textContent = `${t.label} · ${t.id}`
  const row = document.createElement('div'); row.className = 'row'
  for (const size of t.sizes) {
    const b = boxOf(size)
    const fig = document.createElement('figure')
    // 缩放容器：外层按缩放后的尺寸占位，内层保持真实像素再 scale ——
    // 直接把 frame 的高度设成缩放后的值会把卡片压扁（第一版就是这么错的）
    fig.style.width = `${b.w * S}px`
    fig.innerHTML = `<div class="frame" style="overflow:hidden">
      <div class="card ${tierClass(size)} ${accentClass(t.id, DATA[t.id])}" style="width:100%;height:100%">
        <h3><span class="ttl">${DATA[t.id]?.title ?? t.label}</span></h3>
        <div class="bd">${cardBody({ id: 'g', template: t.id, size, kind: 'task', data: DATA[t.id] ?? {} } as any)}</div>
      </div></div>
      <figcaption>${size} · ${b.w}×${b.h}\n</figcaption>`
    const holder = fig.firstElementChild as HTMLElement
    holder.style.height = `${b.h * S}px`     // 外层占位
    ;(holder.firstElementChild as HTMLElement).style.cssText +=
      `;width:${b.w}px;height:${b.h}px;transform:scale(${S});transform-origin:top left`
    row.append(fig)
  }
  wrap.append(h2, row)
}
