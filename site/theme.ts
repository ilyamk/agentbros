/**
 * The site's one stylesheet: a night at an art-deco studio lot, taken from the logo and the README art.
 * No web fonts and no external requests: deco display faces that ship with the major systems, then system UI.
 */
export const SITE_CSS = `
:root{
  color-scheme:dark;
  --night:#07080c;--night-2:#0d1017;--panel:#12161f;--panel-2:#181d29;
  --ivory:#f5ecd6;--muted:#b9b2a2;--dim:#857f72;
  --gold:#f1c24f;--gold-2:#d99a2b;--gold-deep:#8a5a14;--gold-line:rgba(241,194,79,.28);--gold-soft:rgba(241,194,79,.1);
  --cyan:#56e0d4;--cyan-soft:rgba(86,224,212,.12);--red:#c7362b;--green:#7fd18b;--amber:#f59e0b;
  --display:"Futura","Futura PT","Century Gothic","Avenir Next","Josefin Sans","Gill Sans",system-ui,sans-serif;
  --body:system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;
  --mono:ui-monospace,"SF Mono","JetBrains Mono",Menlo,Consolas,monospace;
  --radius:14px;--wrap:76rem;--gutter:clamp(1rem,4vw,2.5rem);
}
*{box-sizing:border-box}
html{scroll-behavior:smooth;-webkit-text-size-adjust:100%}
body{margin:0;background:var(--night);color:var(--ivory);font:1rem/1.65 var(--body);overflow-x:hidden;
  background-image:radial-gradient(60rem 30rem at 50% -10rem,rgba(241,194,79,.09),transparent 70%),radial-gradient(40rem 30rem at 100% 30%,rgba(86,224,212,.05),transparent 70%)}
img{max-width:100%;height:auto;display:block}
a{color:var(--gold);text-decoration-thickness:1px;text-underline-offset:.22em}
a:hover{color:#ffe08a}
:focus-visible{outline:3px solid var(--cyan);outline-offset:3px;border-radius:4px}
.skip{position:absolute;left:-9999px;top:0}.skip:focus{left:1rem;top:1rem;z-index:20;background:var(--night);padding:.75rem 1rem;border:1px solid var(--gold)}
.wrap{max-width:var(--wrap);margin:0 auto;padding:0 var(--gutter)}
[hidden]{display:none!important}
code,kbd,pre{font-family:var(--mono);font-size:.88em}
code{background:var(--panel-2);border:1px solid rgba(255,255,255,.06);padding:.1em .4em;border-radius:6px;color:#e8dcc0;overflow-wrap:anywhere}
pre{background:#05060a;border:1px solid var(--gold-line);border-radius:var(--radius);padding:1rem 1.2rem;overflow-x:auto;white-space:pre-wrap;overflow-wrap:anywhere;color:#e8dcc0}
pre.cmd{white-space:pre;overflow-wrap:normal}
pre .p{color:var(--cyan)}pre .c{color:var(--dim)}

/* Top bar */
.top{position:sticky;top:0;z-index:10;background:rgba(7,8,12,.82);backdrop-filter:saturate(140%) blur(10px);-webkit-backdrop-filter:saturate(140%) blur(10px);border-bottom:1px solid var(--gold-line)}
.top .wrap{display:flex;align-items:center;gap:1.25rem;min-height:4rem}
.brand{display:flex;align-items:center;gap:.7rem;text-decoration:none;color:var(--ivory);flex:none}
.brand img{width:44px;height:auto}
.brand span{font:700 .95rem/1 var(--display);letter-spacing:.16em;text-transform:uppercase}
.brand small{display:block;font:500 .62rem/1.4 var(--display);letter-spacing:.42em;color:var(--gold)}
.nav{display:flex;gap:.25rem;flex-wrap:wrap;margin-left:auto;min-width:0}
.nav a{color:var(--muted);text-decoration:none;font:600 .78rem/1 var(--display);letter-spacing:.14em;text-transform:uppercase;padding:.6rem .7rem;border-radius:999px}
.nav a:hover,.nav a[aria-current=page]{color:var(--night);background:var(--gold)}
.nav .gh{color:var(--gold);border:1px solid var(--gold-line)}
@media (max-width:860px){.top .wrap{flex-wrap:wrap;padding-top:.6rem;padding-bottom:.6rem}.nav{margin-left:0;width:100%;overflow-x:auto;flex-wrap:nowrap;scrollbar-width:none}.nav::-webkit-scrollbar{display:none}.nav a{flex:none}}

/* Type */
.eyebrow{font:700 .74rem/1 var(--display);letter-spacing:.32em;text-transform:uppercase;color:var(--gold);display:flex;align-items:center;gap:.8rem;margin:0 0 1rem}
.eyebrow::before,.eyebrow::after{content:"";height:1px;width:2.5rem;background:linear-gradient(90deg,transparent,var(--gold))}
.eyebrow::after{background:linear-gradient(90deg,var(--gold),transparent)}
.eyebrow.left::before{display:none}
h1,h2,h3{font-family:var(--display);line-height:1.08;margin:0 0 .6em;letter-spacing:.02em}
h1{font-size:clamp(2.3rem,6.4vw,4.8rem);font-weight:800;text-transform:uppercase;letter-spacing:.04em}
h2{font-size:clamp(1.7rem,3.8vw,2.8rem);font-weight:800;text-transform:uppercase;letter-spacing:.05em}
h3{font-size:1.15rem;font-weight:700;letter-spacing:.04em}
.gilt{background:linear-gradient(180deg,#fff3c4 0%,var(--gold) 45%,var(--gold-2) 70%,#fbe39a 100%);-webkit-background-clip:text;background-clip:text;color:transparent;text-shadow:0 0 40px rgba(241,194,79,.25)}
.lede{font-size:clamp(1.05rem,1.6vw,1.25rem);color:var(--muted);max-width:44rem}
.center{text-align:center}.center .lede{margin-left:auto;margin-right:auto}.center .eyebrow{justify-content:center}
.muted{color:var(--muted)}.small{font-size:.88rem}

/* Sections */
section{padding:clamp(3.5rem,8vw,6.5rem) 0}
.band{background:linear-gradient(180deg,var(--night-2),var(--night));border-top:1px solid var(--gold-line);border-bottom:1px solid var(--gold-line)}
.deco{height:22px;margin:0 auto;max-width:28rem;background:
  linear-gradient(90deg,transparent,var(--gold-line) 20%,var(--gold-line) 80%,transparent) center/100% 1px no-repeat,
  radial-gradient(circle,var(--gold) 0 3px,transparent 3.5px) center/22px 22px no-repeat}

/* Hero */
.hero{position:relative;padding:0;min-height:min(92vh,56rem);display:grid;grid-template-columns:minmax(0,1fr);align-items:end;isolation:isolate;overflow:hidden;border-bottom:1px solid var(--gold-line)}
.hero>img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;object-position:50% 30%;z-index:-2}
.hero::after{content:"";position:absolute;inset:0;z-index:-1;background:linear-gradient(180deg,rgba(7,8,12,.15) 0%,rgba(7,8,12,.35) 40%,rgba(7,8,12,.92) 78%,var(--night) 100%)}
.hero .wrap{padding-top:8rem;padding-bottom:clamp(2.5rem,6vw,4.5rem);width:100%}
.hero h1{max-width:15ch}
.hero .lede{color:#e6dcc4}
.actions{display:flex;flex-wrap:wrap;gap:.8rem;margin-top:1.8rem}
.btn{display:inline-flex;align-items:center;gap:.55rem;padding:.9rem 1.35rem;border-radius:999px;font:700 .8rem/1 var(--display);letter-spacing:.16em;text-transform:uppercase;text-decoration:none;border:1px solid var(--gold);color:var(--gold);background:rgba(7,8,12,.55)}
.btn:hover{background:var(--gold-soft);color:#ffe08a}
.btn.primary{background:linear-gradient(180deg,#ffd970,var(--gold) 50%,var(--gold-2));color:#1a1206;border-color:#ffe08a;box-shadow:0 10px 40px -10px rgba(241,194,79,.6),inset 0 1px 0 rgba(255,255,255,.5)}
.btn.primary:hover{color:#000;filter:brightness(1.06)}
.prompt{overflow-wrap:anywhere;margin-top:2rem;max-width:42rem;display:flex;gap:.8rem;align-items:flex-start;background:rgba(5,6,10,.75);border:1px solid var(--gold-line);border-radius:var(--radius);padding:1rem 1.2rem;font:500 .95rem/1.5 var(--mono);color:#e8dcc0}
.prompt b{color:var(--cyan);font-weight:700}

/* Marquee stats */
.marquee{margin-top:-1px;background:linear-gradient(180deg,#1a1408,#0e0b06);border-top:1px solid var(--gold-deep);border-bottom:1px solid var(--gold-deep);position:relative}
.marquee::before,.marquee::after{content:"";position:absolute;left:0;right:0;height:8px;background:radial-gradient(circle,#ffe7a3 0 2px,rgba(241,194,79,.35) 2.6px,transparent 3.4px) 0 50%/18px 8px repeat-x}
.marquee::before{top:4px}.marquee::after{bottom:4px}
.stats{display:grid;grid-template-columns:repeat(5,1fr);gap:0;padding:1.9rem 0}
.stat{text-align:center;padding:.4rem .5rem;border-left:1px solid rgba(241,194,79,.18)}
.stat:first-child{border-left:0}
.stat b{display:block;font:800 clamp(1.8rem,4vw,2.8rem)/1 var(--display);color:var(--gold);letter-spacing:.02em}
.stat span{display:block;margin-top:.4rem;font:600 .68rem/1.35 var(--display);letter-spacing:.2em;text-transform:uppercase;color:var(--muted)}
@media (max-width:600px){.hero>img{object-position:50% 0}.hero .eyebrow{display:none}}
@media (max-width:720px){.stats{grid-template-columns:repeat(2,1fr);row-gap:1.2rem}.stat{border-left:0}.stat:last-child{grid-column:1/-1}}

/* Grids and cards */
.grid{display:grid;gap:1.25rem;grid-template-columns:repeat(auto-fill,minmax(min(100%,17.5rem),1fr))}
.grid.wide{grid-template-columns:repeat(auto-fill,minmax(min(100%,22rem),1fr))}
.grid.four{grid-template-columns:repeat(auto-fill,minmax(min(100%,15rem),1fr))}
.card{position:relative;background:linear-gradient(180deg,var(--panel),var(--night-2));border:1px solid rgba(241,194,79,.16);border-radius:var(--radius);overflow:hidden;display:flex;flex-direction:column}
.card:hover{border-color:var(--gold-line);box-shadow:0 20px 50px -30px rgba(241,194,79,.45)}
.card .body{padding:1.1rem 1.2rem 1.3rem;display:flex;flex-direction:column;gap:.45rem;flex:1}
.card h3{margin:0}
.card h3 a{color:var(--ivory);text-decoration:none}
.card h3 a::after{content:"";position:absolute;inset:0}
.card h3 a:hover{color:var(--gold)}
.card p{margin:0;color:var(--muted);font-size:.93rem}
.card .media{aspect-ratio:3/2;overflow:hidden;background:#05060a}
.card .media img{width:100%;height:100%;object-fit:cover}
.card .strip{background:#05060a;border-bottom:1px solid rgba(255,255,255,.05)}
.card .strip img{width:100%;aspect-ratio:1198/278;object-fit:cover}
.card .meta{margin-top:auto;padding-top:.5rem;display:flex;flex-wrap:wrap;gap:.4rem}
.tag{display:inline-flex;align-items:center;gap:.3rem;font:700 .64rem/1 var(--display);letter-spacing:.16em;text-transform:uppercase;padding:.38rem .55rem;border-radius:999px;border:1px solid rgba(255,255,255,.12);color:var(--muted);background:rgba(255,255,255,.03)}
.tag.gold{color:var(--gold);border-color:var(--gold-line);background:var(--gold-soft)}
.tag.cyan{color:var(--cyan);border-color:rgba(86,224,212,.35);background:var(--cyan-soft)}
.tag.beta{color:#1a1206;background:var(--amber);border-color:var(--amber)}
.tag.ready{color:#08130a;background:var(--green);border-color:var(--green)}
.poster-badge{position:absolute;top:.8rem;right:.8rem;z-index:1}

/* Departments */
.dept{text-align:center;padding:1.6rem 1.2rem;border:1px solid rgba(241,194,79,.14);border-radius:var(--radius);background:radial-gradient(18rem 10rem at 50% 0,rgba(241,194,79,.08),transparent 70%),var(--night-2)}
.dept img{width:84px;margin:0 auto .9rem}
.dept h3{text-transform:uppercase;letter-spacing:.1em;font-size:.95rem}
.dept p{color:var(--muted);font-size:.9rem;margin:.2rem 0 .8rem}

/* Steps */
.steps{display:grid;gap:1.25rem;grid-template-columns:repeat(auto-fit,minmax(min(100%,18rem),1fr));counter-reset:step}
.step{padding:1.6rem;border-radius:var(--radius);border:1px solid rgba(241,194,79,.16);background:var(--night-2);position:relative}
.step::before{counter-increment:step;content:counter(step,decimal-leading-zero);font:800 2.6rem/1 var(--display);color:transparent;-webkit-text-stroke:1px var(--gold);display:block;margin-bottom:.8rem}
.step p{color:var(--muted);margin:.3rem 0 0}
.quote{font-family:var(--mono);font-size:.88rem;color:#e8dcc0;border-left:2px solid var(--cyan);padding:.2rem 0 .2rem .8rem;margin:.8rem 0 0}

/* Split blocks */
.split{display:grid;gap:clamp(1.5rem,4vw,3.5rem);grid-template-columns:1.1fr .9fr;align-items:center}
.split.rev{grid-template-columns:.9fr 1.1fr}
.split.top{align-items:start}.sticky{position:sticky;top:5.5rem}
@media (max-width:860px){.split,.split.rev{grid-template-columns:1fr}.sticky{position:static}}
.frame{border:1px solid var(--gold-line);border-radius:var(--radius);overflow:hidden;box-shadow:0 30px 80px -40px rgba(0,0,0,.9),0 0 0 6px rgba(241,194,79,.04)}
.list{list-style:none;padding:0;margin:1.2rem 0 0;display:grid;gap:.75rem}
.list li{padding-left:1.6rem;position:relative;color:var(--muted)}
.list li::before{content:"";position:absolute;left:0;top:.55em;width:.6rem;height:.6rem;transform:rotate(45deg);background:var(--gold)}
.list b{color:var(--ivory)}

/* Page header */
.pagehead{padding:clamp(3rem,7vw,5rem) 0 clamp(1.5rem,4vw,2.5rem);border-bottom:1px solid var(--gold-line);background:radial-gradient(50rem 18rem at 50% 0,rgba(241,194,79,.12),transparent 70%)}
.pagehead h1{font-size:clamp(2rem,5vw,3.6rem)}
.crumbs{font:600 .72rem/1 var(--display);letter-spacing:.2em;text-transform:uppercase;margin-bottom:1rem}
.crumbs a{color:var(--muted);text-decoration:none}.crumbs a:hover{color:var(--gold)}

/* Filters */
.filters{display:flex;flex-wrap:wrap;gap:.8rem;align-items:end;margin:0 0 1.5rem;padding:1rem;border:1px solid rgba(241,194,79,.14);border-radius:var(--radius);background:var(--night-2)}
.filters label{display:grid;gap:.35rem;font:700 .66rem/1 var(--display);letter-spacing:.18em;text-transform:uppercase;color:var(--muted);flex:1 1 11rem}
input,select{font:500 .95rem/1.3 var(--body);color:var(--ivory);background:var(--panel-2);border:1px solid rgba(255,255,255,.12);border-radius:10px;padding:.6rem .7rem;width:100%;max-width:100%}
.chips{display:flex;flex-wrap:wrap;gap:.45rem;margin:0 0 1.2rem}
.chip{font:700 .7rem/1 var(--display);letter-spacing:.14em;text-transform:uppercase;padding:.6rem .85rem;border-radius:999px;border:1px solid rgba(255,255,255,.14);background:transparent;color:var(--muted);cursor:pointer}
.chip[aria-pressed=true]{background:var(--gold);color:#1a1206;border-color:var(--gold)}
.chip span{opacity:.7;margin-left:.25rem}
.count{font:600 .8rem/1 var(--display);letter-spacing:.14em;text-transform:uppercase;color:var(--muted);margin:0 0 1rem}

/* Needs board */
.job{border:1px solid rgba(241,194,79,.16);border-radius:var(--radius);background:var(--night-2);padding:1.15rem 1.2rem;display:flex;flex-direction:column;gap:.55rem}
.job h3{font-family:var(--body);font-size:1.02rem;font-weight:700;letter-spacing:0;line-height:1.35;overflow-wrap:anywhere}
.job p{margin:0;color:var(--muted);font-size:.92rem;overflow-wrap:anywhere}
.job details{font-size:.88rem;color:var(--muted)}
.job summary{cursor:pointer;color:var(--ivory);font-weight:600}
.job ul{margin:.4rem 0 0;padding-left:1.1rem}
.job li{overflow-wrap:anywhere}
.job .row{display:flex;flex-wrap:wrap;gap:.4rem;align-items:center}
.job .go{margin-top:auto;display:flex;flex-wrap:wrap;gap:.6rem;padding-top:.4rem}
.job .go a{font:700 .7rem/1 var(--display);letter-spacing:.14em;text-transform:uppercase;text-decoration:none;padding:.55rem .8rem;border-radius:999px;border:1px solid var(--gold-line)}
.job .go a.claim{background:var(--gold);color:#1a1206;border-color:var(--gold)}
.board-cat{margin:2.5rem 0 1rem;display:flex;align-items:baseline;gap:.8rem;flex-wrap:wrap}
.board-cat h2{font-size:1.3rem;margin:0}
.board-cat p{margin:0;color:var(--muted)}
.more{margin-top:1rem}
.more>summary{cursor:pointer;list-style:none;display:inline-flex;font:700 .74rem/1 var(--display);letter-spacing:.16em;text-transform:uppercase;color:var(--gold);padding:.7rem 1rem;border:1px solid var(--gold-line);border-radius:999px}
.more>summary::-webkit-details-marker{display:none}
.more[open]>summary{margin-bottom:1rem}

/* Tables and facts */
.table{overflow-x:auto;border:1px solid rgba(241,194,79,.14);border-radius:var(--radius)}
table{border-collapse:collapse;width:100%;font-size:.93rem}
th,td{text-align:left;padding:.75rem .9rem;border-bottom:1px solid rgba(255,255,255,.06);vertical-align:top;overflow-wrap:anywhere}
th{font:700 .68rem/1.3 var(--display);letter-spacing:.16em;text-transform:uppercase;color:var(--gold)}
tr:last-child td,tr:last-child th{border-bottom:0}
.facts{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,13rem),1fr));gap:.8rem;margin:1rem 0 2rem}
.fact{padding:.9rem 1rem;border:1px solid rgba(241,194,79,.14);border-radius:12px;background:var(--night-2)}
.fact b{display:block;font:800 1.5rem/1.1 var(--display);color:var(--gold)}
.fact span{font:600 .66rem/1.3 var(--display);letter-spacing:.16em;text-transform:uppercase;color:var(--muted)}
.prose{max-width:48rem}
.prose h2{font-size:1.35rem;margin-top:2.2rem}
.prose li{color:var(--muted);margin:.3rem 0}

/* Empty states */
.empty{border:1px dashed var(--gold-line);border-radius:var(--radius);padding:clamp(1.5rem,4vw,2.5rem);text-align:center;background:radial-gradient(20rem 10rem at 50% 0,rgba(241,194,79,.07),transparent 70%)}
.empty p{color:var(--muted);max-width:36rem;margin:.4rem auto 1.2rem}
.posters{display:grid;grid-template-columns:repeat(3,1fr);gap:1rem;max-width:40rem;margin:0 auto 1.5rem}
.posters img{border-radius:10px;border:1px solid var(--gold-line);aspect-ratio:2/3;object-fit:cover;width:100%}

/* Footer */
.foot{border-top:1px solid var(--gold-line);padding:3rem 0 2.5rem;background:linear-gradient(180deg,var(--night),#040507)}
.foot .wrap{display:grid;gap:2rem;grid-template-columns:1.4fr 1fr 1fr}
@media (max-width:760px){.foot .wrap{grid-template-columns:1fr}}
.foot h4{font:700 .72rem/1 var(--display);letter-spacing:.22em;text-transform:uppercase;color:var(--gold);margin:0 0 .9rem}
.foot ul{list-style:none;padding:0;margin:0;display:grid;gap:.5rem}
.foot a{color:var(--muted);text-decoration:none}.foot a:hover{color:var(--gold)}
.foot p{color:var(--dim);font-size:.85rem;margin:.6rem 0 0}

/* Bulbs: a slow chase on the marquee rows, off for reduced motion */
@media (prefers-reduced-motion:no-preference){
  .marquee::before,.marquee::after{animation:chase 2.4s linear infinite}
  .marquee::after{animation-direction:reverse}
  @keyframes chase{to{background-position:18px 50%}}
}
@media print{.top,.foot,.filters,.chips{display:none}body{background:#fff;color:#000}}
`;
