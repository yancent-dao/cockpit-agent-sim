/**
 * 把一本绘本打包成**自包含的 H5 单文件**。
 *
 * 这是这个产品真正的交付物 —— 车上的体验是过程，H5 是留下来的东西，
 * 家长会把它发给爷爷奶奶。所以它必须：图片全部 base64 内嵌、
 * 不引用任何外部资源、双击就能开、不用网也不用我们的服务器。
 *
 * 朗读用浏览器原生 `SpeechSynthesis`：零依赖零成本，而且它有 `onboundary`
 * 能做逐字点亮 —— 第三方 TTS 多数反而不给这个时间戳。
 *
 * ## 一条纪律：书里的文字是模型生成的
 *
 * 跟生成式卡同一个判据 —— 模型写的东西进 HTML 之前必须消毒。
 * 这里不需要生成式卡那套白名单解析器（绘本只有纯文本，没有排版标签），
 * 所以直接全量转义就够，**fail-closed**。
 */
import type { Book, BookPage } from '../state/story'

/** 封面要用的额外素材，来自孩子档案与定妆照 */
export interface BookMeta {
  name?: string
  age?: number
  cast?: string
}

const esc = (s: unknown) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;')

const fmtDate = (t: number) => {
  const d = new Date(t)
  return `${d.getFullYear()} 年 ${d.getMonth() + 1} 月 ${d.getDate()} 日`
}

/**
 * 图片去重：同一张图在多页出现时只内嵌一次，用 id 引用。
 * base64 图一张就一两百 KB，重复内嵌会让体积成倍涨，而微信有发送上限。
 */
function dedupe(pages: BookPage[], cover?: string) {
  const ids = new Map<string, string>()
  const put = (url?: string) => {
    if (!url) return undefined
    if (!ids.has(url)) ids.set(url, `i${ids.size}`)
    return ids.get(url)
  }
  const coverId = put(cover)
  const pageIds = pages.map(p => put(p.image))
  return { ids, coverId, pageIds }
}

export function buildBookHtml(book: Book, meta: BookMeta = {}): string {
  const { ids, coverId, pageIds } = dedupe(book.pages, meta.cast)
  // 每张图声明成一个 CSS 变量，用到的地方引用它 —— 这就是"只内嵌一次"的落地方式
  const imgVars = [...ids].map(([url, id]) => `--${id}:url("${url}")`).join(';')

  const who = meta.name ? esc(meta.name) : '小朋友'
  const age = meta.age ? `${meta.age} 岁` : ''
  const trip = book.trip ? `在去${esc(book.trip)}的路上` : '在路上'

  const pageHtml = book.pages.map((p, i) => `
  <section class="pg">
    ${pageIds[i] ? `<div class="art" style="background-image:var(--${pageIds[i]})"></div>`
      : '<div class="art noart"></div>'}
    <div class="cap"><p>${esc(p.text)}</p></div>
  </section>`).join('')

  const ideaHtml = book.ideas.length
    ? `<div class="ideas"><h3>${who}想出来的</h3><p>${book.ideas.map(esc).join(' · ')}</p></div>`
    : ''

  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${esc(book.title)}</title>
<style>
:root{${imgVars};--ink:#2B2118;--paper:#FDFBF7;--warm:#B45309;--line:#E7E3DC}
*{box-sizing:border-box;margin:0;padding:0;-webkit-tap-highlight-color:transparent}
html,body{height:100%;overflow:hidden;background:var(--paper);color:var(--ink);
  font-family:"PingFang SC","Noto Sans CJK SC",system-ui,sans-serif}
#deck{height:100%;position:relative}
section{position:absolute;inset:0;display:flex;flex-direction:column;
  opacity:0;pointer-events:none;transition:opacity .45s ease}
section.on{opacity:1;pointer-events:auto}
.art{flex:1.4;background-size:cover;background-position:center;min-height:0;
  animation:kb 18s ease-in-out infinite alternate}
/* Ken Burns：极缓慢的推拉，静态图立刻有动画感。纯 CSS，零成本 */
@keyframes kb{from{transform:scale(1)}to{transform:scale(1.07)}}
.noart{background:linear-gradient(160deg,#FDE9C0,#C7E0FF)}
.cap{flex:1;display:flex;align-items:center;padding:7vw 8vw;background:var(--paper)}
.cap p{font-size:clamp(19px,5.4vw,30px);line-height:1.85;font-weight:500}
.cap p .lit{background:#FDE68A;border-radius:4px;padding:0 3px}
/* 封面 */
#cover{justify-content:flex-end;background:linear-gradient(165deg,#FEF3C7,#FDBA74 60%,#F97316)}
#cover .face{position:absolute;left:50%;top:26%;transform:translate(-50%,-50%);
  width:44vw;max-width:280px;aspect-ratio:1;border-radius:50%;background-size:cover;
  background-position:center;border:5px solid rgba(255,255,255,.92);
  box-shadow:0 10px 30px -10px rgba(0,0,0,.35)}
#cover .t{padding:0 8vw 14vh;color:#fff;text-shadow:0 2px 14px rgba(0,0,0,.3)}
#cover h1{font-size:clamp(26px,8vw,44px);line-height:1.25;font-weight:600}
#cover .by{margin-top:12px;font-size:clamp(13px,3.6vw,17px);opacity:.95;line-height:1.7}
/* 封底 */
#back{justify-content:center;padding:10vw 8vw;gap:22px;background:var(--paper)}
#back h2{font-size:clamp(20px,5.6vw,28px);line-height:1.7;font-weight:600}
.ideas{border-top:1px solid var(--line);padding-top:18px}
.ideas h3{font-size:13px;letter-spacing:.1em;color:var(--warm);margin-bottom:6px}
.ideas p{font-size:clamp(16px,4.4vw,20px);line-height:1.8}
/* 控制条 */
#bar{position:fixed;left:0;right:0;bottom:0;display:flex;align-items:center;
  justify-content:space-between;padding:14px 20px calc(14px + env(safe-area-inset-bottom));
  font-size:13px;color:#8B8378;background:linear-gradient(transparent,rgba(253,251,247,.96) 40%)}
#say{color:var(--warm);font-weight:600;padding:6px 12px;border:1px solid var(--line);
  border-radius:99px;background:#fff;cursor:pointer}
#nav{display:flex;gap:16px;font-size:18px;color:var(--warm);cursor:pointer;user-select:none}
</style></head><body>
<div id="deck">
  <section id="cover" class="on">
    ${coverId ? `<div class="face" style="background-image:var(--${coverId})"></div>` : ''}
    <div class="t"><h1>${esc(book.title)}</h1>
      <div class="by">${who}${age ? ' · ' + age : ''}<br>${fmtDate(book.createdAt)}</div></div>
  </section>${pageHtml}
  <section id="back">
    <h2>这个故事是<br>${who}和大人<br>${trip}<br>一起写的</h2>
    ${ideaHtml}
  </section>
</div>
<div id="bar"><span id="pn"></span><span id="say">🔊 念给我听</span>
  <span id="nav"><b data-d="-1">‹</b><b data-d="1">›</b></span></div>
<script>
(function(){
  var pages=[].slice.call(document.querySelectorAll('#deck section'));
  var i=0, bar=document.getElementById('pn');
  function show(n){
    i=Math.max(0,Math.min(pages.length-1,n));
    pages.forEach(function(p,k){p.classList.toggle('on',k===i)});
    bar.textContent=(i+1)+' / '+pages.length;
    stop();
  }
  function go(d){show(i+d)}
  document.getElementById('nav').addEventListener('click',function(e){
    var d=e.target.getAttribute('data-d'); if(d) go(+d);
  });
  // 左右滑翻页。竖向滑动不拦，免得挡住系统手势
  var x0=null,y0=null;
  document.addEventListener('touchstart',function(e){x0=e.touches[0].clientX;y0=e.touches[0].clientY},{passive:true});
  document.addEventListener('touchend',function(e){
    if(x0===null)return; var dx=e.changedTouches[0].clientX-x0, dy=e.changedTouches[0].clientY-y0;
    if(Math.abs(dx)>48&&Math.abs(dx)>Math.abs(dy)) go(dx<0?1:-1);
    x0=null;
  },{passive:true});
  document.addEventListener('keydown',function(e){
    if(e.key==='ArrowRight'||e.key===' ') go(1);
    if(e.key==='ArrowLeft') go(-1);
  });
  // 朗读：浏览器原生。onboundary 给逐字点亮，第三方 TTS 多数不给这个时间戳
  var cur=null;
  function stop(){ try{speechSynthesis.cancel()}catch(_){} clearLit(); }
  function clearLit(){
    var m=document.querySelectorAll('.lit');
    [].forEach.call(m,function(el){el.replaceWith(el.textContent)});
  }
  document.getElementById('say').addEventListener('click',function(){
    if(!('speechSynthesis' in window))return;
    var p=pages[i].querySelector('.cap p, h2, h1'); if(!p)return;
    var text=p.textContent; clearLit();
    var u=new SpeechSynthesisUtterance(text); u.lang='zh-CN'; u.rate=.92;
    u.onboundary=function(ev){
      if(ev.name!=='word'&&ev.charIndex==null)return;
      var s=ev.charIndex||0, e=s+(ev.charLength||2);
      p.innerHTML=esc(text.slice(0,s))+'<span class="lit">'+esc(text.slice(s,e))+'</span>'+esc(text.slice(e));
    };
    u.onend=function(){p.textContent=text};
    speechSynthesis.speak(u); cur=u;
  });
  function esc(s){return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}
  show(0);
})();
</script></body></html>`
}

/** 文件名用书名 + 日期。路径分隔符和冒号在某些系统上直接存不下来 */
export function bookFileName(book: Book): string {
  const safe = book.title.replace(/[/\\:*?"<>|]/g, '').trim() || '我们的故事'
  const d = new Date(book.createdAt)
  const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`
  return `${safe}-${stamp}.html`
}
