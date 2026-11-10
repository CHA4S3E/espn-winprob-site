/* Year in Review cinematic -- plays once per season, then hands off to the normal page.
 * Self-contained: injects its own scoped CSS (#yc_cine), overlay DOM (ids yc_*), and a champion emblem
 * + "Replay" button into the page hero. Public API:
 *   YearCinema.attach(payload, { seenKey })  -- adds emblem/replay button, autoplays once if enabled
 *   YearCinema.play(payload)                 -- play on demand
 * payload shape is built by buildYearCinemaPayload() in year-in-review.js. */
(function () {
  'use strict';
  if (window.YearCinema) return;

  const PREF_KEY = 'winProbYearCinema'; // default on; only 'false' disables autoplay

  /* ------------------------------ css ------------------------------ */
  const CSS = `
  #yc_cine { --display: var(--font-display, 'Doppio One', system-ui, sans-serif); --ui: var(--font-body, 'Inter', system-ui, sans-serif); --muted: #9aa3b8; --line: rgba(255,255,255,.12); --champ: #e0b23d;
    position: fixed; inset: 0; z-index: 10000; background: #05070b; color: #eef1f8; font-family: var(--ui); overflow: hidden; user-select: none; -webkit-user-select: none; text-align: left; }
  #yc_cine * { box-sizing: border-box; }
  #yc_cine.gone { opacity: 0; pointer-events: none; visibility: hidden; transition: opacity 1s ease, visibility 0s 1s; }
  #yc_cine button { font: inherit; color: inherit; cursor: pointer; }
  #yc_cine .ic { width: 1em; height: 1em; object-fit: cover; border-radius: 50%; vertical-align: -.12em; display: inline-block; }
  #yc_cine .ini { display: inline-grid; place-items: center; width: 1.3em; height: 1.3em; border-radius: 50%; font: 700 .5em var(--ui); color: #fff; vertical-align: .1em; }
  #yc_barT, #yc_barB { position: absolute; left: 0; right: 0; height: 0; background: #000; z-index: 8; transition: height 1.4s cubic-bezier(.2,.8,.2,1); pointer-events: none; }
  #yc_barT { top: 0; } #yc_barB { bottom: 0; } #yc_cine.lb #yc_barT, #yc_cine.lb #yc_barB { height: 7vh; }
  #yc_vig { position: absolute; inset: 0; z-index: 7; pointer-events: none; background: radial-gradient(ellipse at center, transparent 50%, rgba(0,0,0,.7) 100%); }
  #yc_wipe { position: absolute; top: -10%; bottom: -10%; width: 38%; left: -50%; z-index: 9; pointer-events: none; transform: skewX(-18deg); background: linear-gradient(90deg, transparent, rgba(255,255,255,.22) 45%, rgba(255,255,255,.45) 50%, rgba(255,255,255,.22) 55%, transparent); }
  #yc_wipe.go { animation: ycwipe .9s cubic-bezier(.5,0,.2,1); } @keyframes ycwipe { to { left: 130%; } }
  #yc_cine .push { animation: ycpush 16s ease-out forwards; } @keyframes ycpush { from { transform: scale(1); } to { transform: scale(1.08); } }
  #yc_cine .shake { animation: ycshk .55s cubic-bezier(.2,.8,.2,1); } @keyframes ycshk { 0% { transform: translate(0,0); } 12% { transform: translate(-14px,8px); } 28% { transform: translate(12px,-9px); } 44% { transform: translate(-8px,6px); } 62% { transform: translate(5px,-4px); } 100% { transform: translate(0,0); } }
  #yc_cine .beams { position: absolute; inset: -40%; z-index: 1; pointer-events: none; opacity: .55; mix-blend-mode: screen; background: repeating-conic-gradient(from 0deg at 50% 60%, var(--bc, #6ea0ff) 0deg 3deg, transparent 3deg 22deg); -webkit-mask-image: radial-gradient(circle at 50% 60%, #000 0%, transparent 62%); mask-image: radial-gradient(circle at 50% 60%, #000 0%, transparent 62%); animation: ycspin 60s linear infinite; }
  @keyframes ycspin { to { transform: rotate(360deg); } }
  #yc_s0y.reveal { filter: blur(18px); letter-spacing: .3em; transform: scale(1.12); }
  #yc_s0y.in { filter: none; letter-spacing: .02em; transform: none; transition: opacity 1s, filter 1.8s ease-out, letter-spacing 2.4s cubic-bezier(.2,.8,.2,1), transform 2.4s cubic-bezier(.2,.8,.2,1); }
  #yc_cine .flare { position: absolute; left: 50%; top: 50%; width: 130%; height: 3px; transform: translate(-50%, -50%) scaleX(0); background: linear-gradient(90deg, transparent, rgba(160,190,255,.9), #fff, rgba(160,190,255,.9), transparent); filter: blur(1px); z-index: 3; pointer-events: none; opacity: 0; }
  #yc_cine .flare.go { animation: ycflare 1.6s ease-out; } @keyframes ycflare { 0% { transform: translate(-50%,-50%) scaleX(0); opacity: 1; } 40% { transform: translate(-50%,-50%) scaleX(1); opacity: 1; } 100% { transform: translate(-50%,-50%) scaleX(1.2); opacity: 0; } }
  #yc_cine .rrow.lead .bar { box-shadow: 0 0 26px var(--c); filter: brightness(1.12); } #yc_cine .rrow.lead .nm::after { content: ' 👑'; }
  #yc_raceWrap.bump { animation: ycbump .5s ease-out; } @keyframes ycbump { 0% { transform: scale(1); } 30% { transform: scale(1.025); } 100% { transform: scale(1); } }
  #yc_chap { position: absolute; z-index: 4; left: 50%; top: 50%; transform: translate(-50%,-50%) scale(1.06); text-align: center; opacity: 0; pointer-events: none; transition: opacity .45s ease, transform 1.6s cubic-bezier(.2,.8,.2,1); }
  #yc_chap.on { opacity: 1; transform: translate(-50%,-50%) scale(1); }
  #yc_chap .no { font-family: var(--display); font-size: clamp(90px, 26vw, 280px); line-height: .85; background: linear-gradient(180deg, #fff, rgba(255,255,255,.1)); -webkit-background-clip: text; background-clip: text; color: transparent; }
  #yc_chap .tt { font-family: var(--display); letter-spacing: .4em; text-transform: uppercase; color: var(--muted); margin-top: 8px; }
  #yc_cine .pcol.dim { opacity: .35; transition: opacity 1s; }
  #yc_s6 .beams { opacity: 0; transition: opacity 2s; } #yc_s6 .beams.in { opacity: .7; }
  #yc_s7e { width: clamp(150px, 30vw, 260px); height: clamp(150px, 30vw, 260px); border-radius: 50%; margin: 0 auto 22px; display: grid; place-items: center; font-size: clamp(80px, 17vw, 150px); background: radial-gradient(circle at 50% 35%, color-mix(in srgb, var(--champ) 55%, #000), #0a0c12 75%); border: 4px solid var(--champ); box-shadow: 0 0 80px -6px var(--champ), inset 0 0 40px rgba(0,0,0,.5); overflow: hidden; }
  #yc_cine .emb .ic, .yc-emb .ic { width: .72em; height: .72em; vertical-align: 0; }
  .yc-emb .ini { font-size: .4em; }
  #yc_flyer { position: fixed; z-index: 10001; border-radius: 50%; display: grid; place-items: center; pointer-events: none; transform-origin: top left; overflow: hidden; background: radial-gradient(circle at 50% 35%, color-mix(in srgb, var(--champ) 55%, #000), #0a0c12 75%); border: 4px solid var(--champ); box-shadow: 0 0 80px -6px var(--champ); transition: transform 1.3s cubic-bezier(.65,0,.15,1), opacity .5s; }
  #yc_flyer .ic { width: .72em; height: .72em; object-fit: cover; border-radius: 50%; }
  #yc_flyer .ini { display: inline-grid; place-items: center; width: 1.3em; height: 1.3em; border-radius: 50%; font: 700 .4em sans-serif; color: #fff; }
  #yc_heroEmblem { --champ: #e0b23d; width: 84px; height: 84px; border-radius: 50%; margin: 0 auto 10px; display: grid; place-items: center; font-size: 44px; overflow: hidden; background: radial-gradient(circle at 50% 35%, color-mix(in srgb, var(--champ) 55%, #000), #0a0c12 75%); border: 3px solid var(--champ); box-shadow: 0 0 40px -4px var(--champ); flex: none; }
  #yc_heroEmblem.pending { opacity: 0; }
  #yc_heroEmblem.in { opacity: 1; animation: ycland .8s cubic-bezier(.2,1.4,.4,1); } @keyframes ycland { 0% { transform: scale(1.35); box-shadow: 0 0 120px 10px var(--champ); } 100% { transform: none; } }
  #yc_heroEmblem .ic { width: .72em; height: .72em; object-fit: cover; border-radius: 50%; }
  #yc_heroEmblem .ini { display: inline-grid; place-items: center; width: 1.3em; height: 1.3em; border-radius: 50%; font: 700 .4em sans-serif; color: #fff; }
  #hero.yc-champglow::after { content: ''; position: absolute; inset: 0; z-index: 2; background: radial-gradient(ellipse at 50% 40%, color-mix(in srgb, var(--yc-champ, #e0b23d) 35%, transparent), transparent 60%); pointer-events: none; animation: ycglow 2.6s ease-out forwards; } @keyframes ycglow { from { opacity: 1; } to { opacity: 0; } }
  #yc_replay { margin-top: 12px; border: 1px solid var(--border, rgba(255,255,255,.2)); background: var(--input-bg, rgba(10,12,18,.5)); color: var(--fg, inherit); border-radius: 999px; padding: 6px 14px; font: 600 12.5px var(--font-body, system-ui); cursor: pointer; }
  #yc_replay:hover { filter: brightness(1.15); }
  body.yc-lock { overflow: hidden; }
  #yc_cine .scene { position: absolute; inset: 0; display: grid; place-items: center; opacity: 0; pointer-events: none; transition: opacity .7s ease; padding: 24px; }
  #yc_cine .scene.on { opacity: 1; pointer-events: auto; }
  #yc_cine .bgfx { position: absolute; inset: 0; width: 100%; height: 100%; }
  #yc_cine .stack { position: relative; z-index: 2; width: min(960px, 100%); text-align: center; }
  #yc_cine .kicker { font-family: var(--display); letter-spacing: .28em; text-transform: uppercase; color: var(--muted); font-size: clamp(11px, 1.6vw, 15px); }
  #yc_cine .big { font-family: var(--display); font-size: clamp(54px, 13vw, 150px); line-height: .95; letter-spacing: .02em; }
  #yc_cine .reveal { opacity: 0; transform: translateY(22px) scale(.97); transition: opacity .7s ease, transform .7s cubic-bezier(.2,.9,.3,1); }
  #yc_cine .reveal.in { opacity: 1; transform: none; }
  #yc_cine .slam { opacity: 0; transform: scale(1.7); transition: opacity .25s ease-out, transform .35s cubic-bezier(.2,1.4,.4,1); }
  #yc_cine .slam.in { opacity: 1; transform: none; }
  #yc_chrome { position: absolute; z-index: 10; left: 0; right: 0; bottom: 0; padding: 14px 18px 16px; display: flex; gap: 6px; align-items: center; }
  #yc_dots { display: flex; gap: 6px; flex: 1; }
  #yc_dots i { flex: 1; height: 3px; border-radius: 2px; background: rgba(255,255,255,.16); overflow: hidden; max-width: 70px; }
  #yc_dots i b { display: block; height: 100%; width: 0; background: #fff; }
  #yc_dots i.done b { width: 100%; }
  #yc_cine .cbtn { border: 1px solid rgba(255,255,255,.2); background: rgba(10,12,18,.6); border-radius: 8px; padding: 7px 12px; font-size: 13px; font-weight: 600; }
  #yc_cine .cbtn:hover { background: rgba(255,255,255,.12); }
  #yc_hint { position: absolute; z-index: 10; top: 14px; right: 16px; color: var(--muted); font-size: 12px; }
  #yc_s0 .chips { position: absolute; inset: 0; overflow: hidden; }
  #yc_cine .streak { position: absolute; font-size: clamp(34px, 7vw, 74px); opacity: 0; animation: ycstreak 3.2s cubic-bezier(.3,.6,.2,1) forwards; filter: drop-shadow(0 0 18px var(--c)); }
  @keyframes ycstreak { 0% { opacity: 0; transform: translateX(-30vw) scale(.6); } 20% { opacity: .9; } 100% { opacity: 0; transform: translateX(110vw) scale(1.1); } }
  #yc_s0 .year { background: linear-gradient(180deg, #fff, #7d8aa8); -webkit-background-clip: text; background-clip: text; color: transparent; }
  #yc_s0 .sub { margin-top: 14px; letter-spacing: .5em; }
  #yc_cine .numrow { display: flex; justify-content: center; gap: clamp(18px, 6vw, 80px); flex-wrap: wrap; }
  #yc_cine .num .n { font-family: var(--display); font-size: clamp(60px, 14vw, 150px); line-height: 1; }
  #yc_cine .num .l { color: var(--muted); letter-spacing: .3em; text-transform: uppercase; font-size: clamp(11px, 1.6vw, 14px); margin-top: 6px; }
  #yc_raceWrap { position: relative; width: min(900px, 100%); }
  #yc_raceHead { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 14px; }
  #yc_raceWeek { font-family: var(--display); font-size: clamp(34px, 7vw, 66px); }
  #yc_raceList { position: relative; height: calc(var(--rows) * 44px); }
  #yc_cine .rrow { position: absolute; left: 0; right: 0; height: 38px; transition: transform .55s cubic-bezier(.4,.1,.2,1); display: flex; align-items: center; gap: 10px; }
  #yc_cine .rrow .rk { width: 22px; color: var(--muted); font-weight: 700; font-size: 13px; text-align: right; }
  #yc_cine .rrow .nm { width: clamp(90px, 22vw, 190px); text-align: left; font-weight: 600; font-size: clamp(12px, 1.8vw, 15px); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  #yc_cine .rrow .track { flex: 1; height: 100%; position: relative; }
  #yc_cine .rrow .bar { position: absolute; left: 0; top: 4px; bottom: 4px; border-radius: 6px; width: 0; transition: width .55s cubic-bezier(.4,.1,.2,1); }
  #yc_cine .rrow .val { position: absolute; top: 50%; transform: translateY(-50%); font-weight: 700; font-size: 13px; transition: left .55s cubic-bezier(.4,.1,.2,1); white-space: nowrap; padding-left: 8px; }
  #yc_raceCap { height: 44px; margin-top: 18px; font-weight: 700; font-size: clamp(14px, 2.2vw, 20px); }
  #yc_raceCap span { display: inline-block; padding: 8px 16px; border-radius: 999px; background: rgba(255,255,255,.09); border: 1px solid var(--line); animation: ycfade .5s ease; } @keyframes ycfade { from { opacity: 0; transform: translateY(6px); } }
  #yc_s3stack { transition: opacity .6s ease; }
  #yc_upCanvas { width: min(900px, 100%); height: clamp(240px, 42vh, 400px); display: block; margin: 16px auto 0; border-radius: 14px; background: rgba(255,255,255,.03); border: 1px solid var(--line); }
  #yc_upNames { display: flex; justify-content: space-between; width: min(900px, 100%); margin: 0 auto; font-weight: 700; font-size: clamp(14px, 2.4vw, 22px); }
  #yc_upStamp { position: absolute; left: 50%; top: 46%; transform: translate(-50%, -50%) rotate(-8deg) scale(2); font-family: var(--display); font-size: clamp(40px, 8vw, 90px); letter-spacing: .06em; color: #ff5a5f; border: 6px solid #ff5a5f; padding: 0 24px; border-radius: 12px; opacity: 0; transition: opacity .25s, transform .4s cubic-bezier(.2,1.5,.4,1); z-index: 3; text-shadow: 0 0 30px rgba(255,90,95,.6); pointer-events: none; }
  #yc_upStamp.in { opacity: 1; transform: translate(-50%, -50%) rotate(-8deg) scale(1); }
  #yc_upPct { font-family: var(--display); font-size: clamp(34px, 6vw, 60px); margin-top: 14px; }
  #yc_cine .vs { display: grid; grid-template-columns: 1fr auto 1fr; gap: clamp(10px, 3vw, 40px); align-items: center; margin-top: 22px; }
  #yc_cine .tm .em { font-size: clamp(40px, 8vw, 80px); }
  #yc_cine .tm .tn { font-weight: 700; font-size: clamp(14px, 2.2vw, 22px); margin: 4px 0; }
  #yc_cine .tm .sc { font-family: var(--display); font-size: clamp(44px, 10vw, 100px); line-height: 1; }
  #yc_cine .margin { font-family: var(--display); font-size: clamp(16px, 3vw, 28px); padding: 10px 18px; border-radius: 999px; border: 2px solid currentColor; }
  #yc_cine .gameBlock { position: absolute; inset: 0; display: grid; place-items: center; opacity: 0; transition: opacity .7s; padding: 24px; pointer-events: none; }
  #yc_cine .gameBlock.on { opacity: 1; }
  #yc_cine .awards { display: grid; grid-template-columns: repeat(2, 1fr); gap: 14px; margin-top: 26px; }
  #yc_cine .aw:last-child:nth-child(odd) { grid-column: 1 / -1; }
  #yc_cine .aw { background: rgba(255,255,255,.05); border: 1px solid var(--line); border-radius: 16px; padding: 18px; text-align: left; opacity: 0; transform: translateY(30px) rotateX(25deg); transition: opacity .6s, transform .7s cubic-bezier(.2,1.1,.3,1); }
  #yc_cine .aw.in { opacity: 1; transform: none; }
  #yc_cine .aw small { display: block; color: var(--muted); letter-spacing: .14em; text-transform: uppercase; font-size: 11px; }
  #yc_cine .aw .who { display: flex; align-items: center; gap: 10px; margin: 8px 0 2px; font-weight: 700; font-size: clamp(15px, 2.4vw, 22px); }
  #yc_cine .aw .who .em { font-size: 30px; }
  #yc_cine .aw .stat { font-family: var(--display); font-size: clamp(28px, 5vw, 48px); }
  #yc_cine .aw .note { color: var(--muted); font-size: 13px; }
  #yc_podium { display: flex; justify-content: center; align-items: flex-end; gap: clamp(8px, 2vw, 22px); height: min(46vh, 380px); margin-top: 24px; }
  #yc_cine .pcol { width: clamp(90px, 24vw, 220px); text-align: center; display: flex; flex-direction: column; justify-content: flex-end; transition: opacity 1s; }
  #yc_cine .pcol .who { opacity: 0; transform: translateY(20px); transition: all .7s; margin-bottom: 8px; }
  #yc_cine .pcol .who .em { font-size: clamp(34px, 7vw, 64px); }
  #yc_cine .pcol .who .nm { font-weight: 700; font-size: clamp(12px, 2vw, 20px); }
  #yc_cine .pcol .blk { border-radius: 12px 12px 0 0; height: 0; transition: height 1.1s cubic-bezier(.2,.9,.2,1); display: grid; place-items: start center; padding-top: 10px; font-family: var(--display); font-size: clamp(30px, 6vw, 60px); color: rgba(0,0,0,.55); }
  #yc_cine .pcol.show .who { opacity: 1; transform: none; }
  #yc_champName { font-family: var(--display); font-size: clamp(28px, 7vw, 74px); margin-top: 10px; opacity: 0; transform: scale(.8); transition: all .8s cubic-bezier(.2,1.3,.3,1); }
  #yc_champName.in { opacity: 1; transform: none; }
  #yc_spot { position: absolute; inset: 0; background: radial-gradient(ellipse at 50% 35%, var(--champ, #e0b23d) 0%, transparent 55%); opacity: 0; transition: opacity 1.4s; mix-blend-mode: screen; }
  #yc_spot.in { opacity: .42; }
  #yc_s7 .scrollcue { margin-top: 26px; animation: ycbob 1.6s ease-in-out infinite; color: var(--muted); letter-spacing: .3em; font-size: 12px; text-transform: uppercase; }
  @keyframes ycbob { 50% { transform: translateY(8px); } }
  #yc_cine .flash { position: absolute; inset: 0; background: #fff; opacity: 0; pointer-events: none; z-index: 5; }
  #yc_cine .flash.go { animation: ycflash .6s ease-out; }
  @keyframes ycflash { 0% { opacity: .8; } 100% { opacity: 0; } }
  @media (max-width: 560px) { #yc_cine .awards { gap: 8px; margin-top: 14px; } #yc_cine .aw { padding: 10px 12px; border-radius: 12px; } #yc_cine .aw .who { margin: 4px 0 0; font-size: 13px; gap: 6px; } #yc_cine .aw .who .em { font-size: 20px; } #yc_cine .aw .stat { font-size: 24px; } #yc_cine .aw .note { display: none; } #yc_cine .aw small { font-size: 9.5px; } #yc_hint { display: none; } }
  `;

  const HTML = `
  <div id="yc_barT"></div><div id="yc_barB"></div><div id="yc_vig"></div><div id="yc_wipe"></div>
  <div id="yc_hint">Click / Space = next · ← back · Esc = skip</div>
  <section class="scene" id="yc_s0"><div class="beams" style="--bc:#6ea0ff;opacity:.4"></div><div class="flare" id="yc_flare0"></div><div class="chips" id="yc_chips"></div>
    <div class="stack"><div class="kicker reveal" id="yc_s0k">The</div><div class="big year reveal" id="yc_s0y"></div><div class="kicker sub reveal" id="yc_s0s">Season in review</div></div></section>
  <section class="scene" id="yc_s1"><canvas class="bgfx" id="yc_bg1"></canvas>
    <div class="stack"><div class="kicker reveal" id="yc_s1k">By the numbers</div>
      <div class="numrow" style="margin-top:22px">
        <div class="num slam" id="yc_n1"><div class="n" id="yc_n1v">0</div><div class="l">Weeks</div></div>
        <div class="num slam" id="yc_n2"><div class="n" id="yc_n2v">0</div><div class="l">Teams</div></div>
        <div class="num slam" id="yc_n3"><div class="n" id="yc_n3v">0</div><div class="l">Points scored</div></div>
      </div>
      <div class="kicker reveal" id="yc_s1t" style="margin-top:34px"></div></div></section>
  <section class="scene" id="yc_s2"><div id="yc_raceWrap" class="stack" style="width:min(900px,100%)">
    <div id="yc_raceHead"><div class="kicker">The race</div><div id="yc_raceWeek">WEEK 1</div></div>
    <div id="yc_raceList"></div><div id="yc_raceCap"></div></div></section>
  <section class="scene" id="yc_s3"><div id="yc_chap"><div class="no" id="yc_chapNo">3</div><div class="tt" id="yc_chapTt"></div></div><div class="stack" id="yc_s3stack">
    <div class="kicker reveal" id="yc_s3k"></div>
    <div id="yc_upNames" class="reveal" style="margin-top:14px"><span id="yc_upFav"></span><span id="yc_upDog"></span></div>
    <canvas id="yc_upCanvas"></canvas><div id="yc_upPct" class="reveal"></div><div id="yc_upNote" class="kicker" style="margin-top:10px;min-height:20px;letter-spacing:.14em;transition:opacity .6s;opacity:0"></div></div><div id="yc_upStamp">UPSET</div><div class="flash" id="yc_upFlash"></div></section>
  <section class="scene" id="yc_s4">
    <div class="gameBlock" id="yc_gClose"><div class="stack"><div class="kicker">Closest game of the year</div><div class="vs" id="yc_vsClose"></div></div></div>
    <div class="gameBlock" id="yc_gBlow"><div class="stack"><div class="kicker">Biggest blowout</div><div class="vs" id="yc_vsBlow"></div></div></div></section>
  <section class="scene" id="yc_s5"><div class="stack"><div class="kicker reveal" id="yc_s5k">The awards</div><div class="awards" id="yc_awards"></div></div></section>
  <section class="scene" id="yc_s6"><div class="beams" id="yc_beam6"></div><canvas class="bgfx" id="yc_confetti"></canvas><div id="yc_spot"></div>
    <div class="stack"><div class="kicker reveal" id="yc_s6k">The final standings</div><div id="yc_podium"></div><div class="kicker" id="yc_champK" style="opacity:0;margin-top:14px;transition:opacity .6s">Your champion</div><div id="yc_champName"></div></div></section>
  <section class="scene" id="yc_s7"><div class="beams" id="yc_beam7" style="opacity:.5"></div><div class="stack"><div id="yc_s7e" class="reveal emb"></div><div class="kicker reveal" id="yc_s7k" style="margin-bottom:10px"></div><div class="big reveal" id="yc_s7b" style="font-size:clamp(34px,8vw,88px)">That's the season.</div><div class="scrollcue reveal" id="yc_s7c">The full breakdown ↓</div></div></section>
  <div class="flash" id="yc_flash"></div>
  <div id="yc_chrome"><div id="yc_dots"></div><button class="cbtn" id="yc_pauseBtn">❚❚ Pause</button><button class="cbtn" id="yc_speedBtn">1x</button><button class="cbtn" id="yc_skipBtn">Skip ▶▶</button></div>`;

  /* ------------------------------ helpers ------------------------------ */
  const $ = (id) => document.getElementById('yc_' + id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = (x) => Number(x).toLocaleString(undefined, { maximumFractionDigits: 1, minimumFractionDigits: 1 });
  const reduced = () => document.documentElement.hasAttribute('data-reduce-motion') || (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const initials = (n) => String(n || '?').split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();
  // brighten team colors that would vanish on the black stage
  function vis(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim()); if (!m) return '#9ab0ff';
    const n = parseInt(m[1], 16); let r = n >> 16, g = (n >> 8) & 255, b = n & 255;
    const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    if (lum < 0.38) { const k = (0.38 - lum) / (1 - lum) + 0.12; r = Math.round(r + (255 - r) * k); g = Math.round(g + (255 - g) * k); b = Math.round(b + (255 - b) * k); }
    return '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');
  }

  /* ------------------------------ state ------------------------------ */
  let P = null, T = {}, scenes = [], built = false, open = false, keyBound = false;
  let advT = 0, speed = 1, paused = false, idx = -1, timers = [], raf = 0, sceneT0 = 0, sceneDur = 0, progRaf = 0, conf = [], seq = 0;

  const team = (id) => T[id] || { id, name: '?', color: '#9ab0ff', emoji: '' };
  const ic = (t) => (t.logoUrl ? `<img class="ic" src="${esc(t.logoUrl)}" alt="">` : t.emoji ? esc(t.emoji) : `<span class="ini" style="background:${esc(t.color)}">${esc(initials(t.name))}</span>`);
  const nm = (id) => esc(team(id).name);

  const wait = (fn, ms) => { const t = { id: setTimeout(fn, ms / speed) }; timers.push(t); };
  const clearTimers = () => { timers.forEach((t) => clearTimeout(t.id)); timers = []; cancelAnimationFrame(raf); };
  const countUp = (el, to, ms, dec = 0) => { const t0 = performance.now(), my = seq; const f = (n) => { if (my !== seq) return; const u = Math.min(1, (n - t0) * speed / ms), e = 1 - Math.pow(1 - u, 3); el.textContent = (to * e).toLocaleString(undefined, { maximumFractionDigits: dec, minimumFractionDigits: dec }); if (u < 1) requestAnimationFrame(f); }; requestAnimationFrame(f); };
  const R = (id, ms) => wait(() => $(id).classList.add('in'), ms);
  const reset = (root) => root.querySelectorAll('.in').forEach((e) => e.classList.remove('in'));

  /* ------------------------------ scenes ------------------------------ */
  function buildScenes() {
    const N = P.order.length, WEEKS = P.cum.length, champ = P.champ;
    scenes = [];
    scenes.push({ id: 's0', dur: 6500, go() {
      const chips = $('chips'); chips.innerHTML = '';
      P.order.forEach((id, i) => { const t = team(id); const s = document.createElement('div'); s.className = 'streak'; s.innerHTML = ic(t); s.style.setProperty('--c', vis(t.color)); s.style.top = (8 + ((i * 37) % 84)) + '%'; s.style.animationDelay = (i * 0.28 / speed) + 's'; s.style.animationDuration = (3.4 / speed) + 's'; chips.appendChild(s); });
      $('s0y').textContent = P.year; R('s0k', 900); R('s0y', 1500); R('s0s', 3200);
      wait(() => { const f = $('flare0'); f.classList.remove('go'); void f.offsetWidth; f.classList.add('go'); }, 1700); } });
    scenes.push({ id: 's1', dur: 7500, go() {
      $('s1t').textContent = champ != null ? '…and one champion' : '…and a season to remember';
      R('s1k', 300); R('n1', 1000); wait(() => countUp($('n1v'), WEEKS, 700), 1000);
      R('n2', 2100); wait(() => countUp($('n2v'), N, 700), 2100);
      R('n3', 3200); wait(() => countUp($('n3v'), P.totalPts, 1500), 3200); R('s1t', 5600); } });
    if (WEEKS >= 2 && N >= 2) scenes.push({ id: 's2', dur: 1800 + WEEKS * 1050, go: runRace });
    if (P.moments && P.moments.length) scenes.push({ id: 's3', dur: 1500 + P.moments.length * 14000, go: runMoments });
    if (P.close && P.blow) scenes.push({ id: 's4', dur: 13500, go: runGames });
    if (P.awards && P.awards.length) scenes.push({ id: 's5', dur: 3000 + P.awards.length * 2500, go: runAwards });
    if (P.podium && P.podium[1] != null) scenes.push({ id: 's6', dur: 14500, go: runPodium });
    scenes.push({ id: 's7', dur: 7600, go() {
      const c = champ != null ? team(champ) : null;
      if (c) { $('s7e').innerHTML = ic(c); $('cine').style.setProperty('--champ', vis(c.color)); $('beam7').style.setProperty('--bc', vis(c.color)); $('s7k').textContent = `${c.name} · ${P.year} champions`; }
      else { $('s7e').style.display = 'none'; $('s7k').textContent = `${P.year} season`; }
      R('s7e', 300); R('s7k', 1300); R('s7b', 2300); R('s7c', 3600); wait(() => finish(), 6600); } });
  }

  function particles(cv, color) {
    const x = cv.getContext('2d'); cv.width = cv.clientWidth; cv.height = cv.clientHeight;
    const Pt = Array.from({ length: 70 }, () => ({ x: Math.random() * cv.width, y: Math.random() * cv.height, r: .6 + Math.random() * 2, v: .15 + Math.random() * .5 }));
    const f = () => { x.clearRect(0, 0, cv.width, cv.height); x.fillStyle = color; Pt.forEach((p) => { p.y -= p.v * speed; if (p.y < -4) { p.y = cv.height + 4; p.x = Math.random() * cv.width; } x.globalAlpha = .25 + p.r / 5; x.beginPath(); x.arc(p.x, p.y, p.r, 0, 6.3); x.fill(); }); raf = requestAnimationFrame(f); };
    f();
  }

  /* ---- bar-chart race ---- */
  function runRace() {
    const N = P.order.length, WEEKS = P.cum.length;
    const list = $('raceList'); list.style.setProperty('--rows', N); list.innerHTML = '';
    const rows = P.order.map((id) => { const t = team(id); const d = document.createElement('div'); d.className = 'rrow'; d.innerHTML = `<span class="rk"></span><span class="nm">${ic(t)} ${esc(t.name)}</span><div class="track"><div class="bar" style="background:${esc(vis(t.color))}"></div><span class="val"></span></div>`; list.appendChild(d); return d; });
    $('raceCap').innerHTML = ''; let lastLeader = -1;
    const cap = (txt) => { $('raceCap').innerHTML = `<span>${txt}</span>`; };
    const show = (w) => {
      const vals = P.cum[w], rank = [...Array(N).keys()].sort((a, b) => vals[b] - vals[a]);
      $('raceWeek').textContent = 'WEEK ' + P.weekNums[w];
      const mx = Math.max(...vals) || 1;
      rank.forEach((k, r) => { const row = rows[k]; row.style.transform = `translateY(${r * 44}px)`; row.querySelector('.rk').textContent = r + 1; const pct = Math.max(6, (vals[k] - 0.62 * mx) / (0.38 * mx) * 100); row.querySelector('.bar').style.width = `calc(${pct}% - 70px)`; const v = row.querySelector('.val'); v.style.left = `calc(${pct}% - 70px)`; v.textContent = Math.round(vals[k]).toLocaleString(); });
      const leader = rank[0], lid = P.order[leader];
      if (w === 0) cap(`Week ${P.weekNums[0]}: ${nm(lid)} come out of the gate`);
      else if (w === WEEKS - 1) cap(`🏁 ${nm(lid)} finish #1 in points`);
      else if (leader !== lastLeader) cap(`👑 ${nm(lid)} take over first place`);
      rows.forEach((r, i) => { r.classList.toggle('lead', i === leader); r.style.setProperty('--c', vis(team(P.order[i]).color)); });
      if (leader !== lastLeader && w > 0) { const rw = $('raceWrap'); rw.classList.remove('bump'); void rw.offsetWidth; rw.classList.add('bump'); }
      lastLeader = leader;
    };
    rows.forEach((r, i) => { r.style.transform = `translateY(${i * 44}px)`; });
    for (let w = 0; w < WEEKS; w++) wait(() => show(w), 700 + w * 1050);
  }

  /* ---- the moments (heartbreaker / comeback / biggest upset): A's win-prob series S ---- */
  function moment(m) {
    const A = team(m.A), B = team(m.B), S = m.s, Ac = vis(A.color), Bc = vis(B.color);
    const flip = (() => { const peakI = S.reduce((bi, v, i) => (Math.abs(v - 50) > Math.abs(S[bi] - 50) ? i : bi), 0); const side = S[peakI] >= 50; for (let i = peakI; i < S.length; i++) if (side ? S[i] < 50 : S[i] >= 50) return i; return S.length - 2; })();
    $('chapNo').textContent = m.no; $('chapTt').textContent = m.title; $('s3stack').style.opacity = 0;
    wait(() => $('chap').classList.add('on'), 450); wait(() => $('chap').classList.remove('on'), 1900); wait(() => { $('s3stack').style.opacity = 1; }, 2200);
    $('upFav').innerHTML = `<span style="color:${esc(Ac)}">${ic(A)} ${esc(A.name)}</span>`; $('upDog').innerHTML = `<span style="color:${esc(Bc)}">${esc(B.name)} ${ic(B)}</span>`;
    $('s3k').textContent = `No. ${m.no} · ${m.title}`; const st = $('upStamp'); st.textContent = m.stamp; st.style.color = st.style.borderColor = m.col;
    st.classList.remove('in'); $('upPct').textContent = ''; $('upNote').style.opacity = 0; $('upNote').textContent = m.note; $('upNames').classList.add('in'); $('upPct').classList.add('in'); $('s3k').classList.add('in');
    const cv = $('upCanvas'), dpr = 2; const W = cv.clientWidth, H = cv.clientHeight; cv.width = W * dpr; cv.height = H * dpr; const x = cv.getContext('2d'); x.setTransform(dpr, 0, 0, dpr, 0, 0);
    const pad = 20, X = (i) => pad + i / (S.length - 1) * (W - 2 * pad), Y = (v) => pad + (1 - v / 100) * (H - 2 * pad), y50 = Y(50);
    let head = 0, t0 = performance.now() + 2900, stamped = false, shake = 0;
    const colOf = (a, b) => ((a[1] + b[1]) / 2 <= y50 ? Ac : Bc);
    const f = (now) => {
      raf = requestAnimationFrame(f);
      if (now < t0) head = 0; else { const d = Math.abs(head - flip), slow = d < 16 ? .16 + .84 * (d / 16) : 1; head = Math.min(S.length - 1, head + 0.3 * speed * slow * 1.5); }
      x.save(); x.clearRect(0, 0, W, H);
      const hi = Math.floor(head), frac = head - hi, near = Math.max(0, 1 - Math.abs(head - flip) / 18);
      if (near > 0) { const z = 1 + .22 * near; const px = X(Math.min(S.length - 1, head)), py = Y(S[hi]); x.translate(px, py); x.scale(z, z); x.translate(-px, -py); }
      if (shake > .3) { x.translate((Math.random() - .5) * shake, (Math.random() - .5) * shake); shake *= .9; }
      x.strokeStyle = 'rgba(255,255,255,.16)'; x.lineWidth = 1; x.beginPath(); x.moveTo(pad, y50); x.lineTo(W - pad, y50); x.stroke();
      x.fillStyle = 'rgba(255,255,255,.4)'; x.font = '11px sans-serif'; x.fillText('50%', pad + 2, y50 - 4);
      const Pp = []; for (let i = 0; i <= hi; i++) Pp.push([X(i), Y(S[i])]); if (hi < S.length - 1) Pp.push([X(hi + frac), Y(S[hi] + (S[hi + 1] - S[hi]) * frac)]);
      const Q = [Pp[0]]; for (let i = 1; i < Pp.length; i++) { const a = Pp[i - 1], b = Pp[i]; if ((a[1] - y50) * (b[1] - y50) < 0) { const u = (y50 - a[1]) / (b[1] - a[1]); Q.push([a[0] + (b[0] - a[0]) * u, y50]); } Q.push(b); }
      for (let i = 1; i < Q.length; i++) { x.fillStyle = colOf(Q[i - 1], Q[i]); x.globalAlpha = .16; x.beginPath(); x.moveTo(Q[i - 1][0], y50); x.lineTo(Q[i - 1][0], Q[i - 1][1]); x.lineTo(Q[i][0], Q[i][1]); x.lineTo(Q[i][0], y50); x.closePath(); x.fill(); x.globalAlpha = 1; }
      x.lineCap = 'round'; x.lineJoin = 'round';
      for (const [lw, al] of [[16, .08], [9, .16], [3, 1]]) for (let i = 1; i < Q.length; i++) { x.strokeStyle = colOf(Q[i - 1], Q[i]); x.globalAlpha = al; x.lineWidth = lw; x.beginPath(); x.moveTo(Q[i - 1][0], Q[i - 1][1]); x.lineTo(Q[i][0], Q[i][1]); x.stroke(); }
      x.globalAlpha = 1; const last = Q[Q.length - 1]; const pulse = 4.5 + near * 5 * (.6 + .4 * Math.sin(now / 70)); x.fillStyle = '#fff'; x.shadowColor = '#fff'; x.shadowBlur = 12 + near * 24; x.beginPath(); x.arc(last[0], last[1], pulse, 0, 6.3); x.fill(); x.shadowBlur = 0;
      x.restore();
      const cur = S[Math.min(S.length - 1, hi)]; const lead = cur >= 50 ? A : B, lc = cur >= 50 ? Ac : Bc;
      $('upPct').innerHTML = `<span style="color:${esc(lc)}">${Math.round(cur >= 50 ? cur : 100 - cur)}%</span> <span style="font-size:.4em;color:var(--muted);letter-spacing:.2em">${esc(lead.name.toUpperCase())}</span>`;
      if (!stamped && head >= flip + 1) { stamped = true; shake = 16; const fl = $('upFlash'); fl.classList.remove('go'); void fl.offsetWidth; fl.classList.add('go'); st.classList.add('in'); const s3 = $('s3stack'); s3.classList.remove('shake'); void s3.offsetWidth; s3.classList.add('shake'); wait(() => { $('upNote').style.opacity = 1; }, 900); wait(() => { st.classList.remove('in'); }, 2500); }
    };
    raf = requestAnimationFrame(f);
  }
  function runMoments() {
    R('s3k', 100);
    P.moments.forEach((m, k) => wait(() => { cancelAnimationFrame(raf); moment(m); }, 200 + k * 14000));
  }

  /* ---- closest game + blowout ---- */
  function vsHtml(g) {
    const a = team(g.a), b = team(g.b);
    return `<div class="tm"><div class="em">${ic(a)}</div><div class="tn" style="color:${esc(vis(a.color))}">${esc(a.name)}</div><div class="sc" data-to="${g.sa}">0.0</div></div>
      <div class="margin" data-m="${(g.sa - g.sb).toFixed(1)}">—</div>
      <div class="tm"><div class="em">${ic(b)}</div><div class="tn" style="color:${esc(vis(b.color))}">${esc(b.name)}</div><div class="sc" data-to="${g.sb}">0.0</div></div>`;
  }
  function runGames() {
    $('vsClose').innerHTML = vsHtml(P.close); $('vsBlow').innerHTML = vsHtml(P.blow);
    $('vsClose').querySelector('.margin').style.color = '#7dd87d'; $('vsBlow').querySelector('.margin').style.color = '#ff7a7a';
    $('gClose').classList.remove('on'); $('gBlow').classList.remove('on');
    const play = (blockId, vsId, g) => {
      $(blockId).classList.add('on');
      $(vsId).querySelectorAll('.sc').forEach((el, k) => wait(() => countUp(el, Number(el.dataset.to), 1500, 1), 400 + k * 150));
      const m = $(vsId).querySelector('.margin'); m.textContent = '—';
      wait(() => { m.textContent = `${m.dataset.m} pts · Week ${g.w}`; m.style.transition = 'transform .4s cubic-bezier(.2,1.6,.4,1)'; m.style.transform = 'scale(1.25)'; wait(() => { m.style.transform = 'none'; }, 350); }, 2100);
    };
    play('gClose', 'vsClose', P.close);
    wait(() => { $('gClose').classList.remove('on'); }, 6200);
    wait(() => play('gBlow', 'vsBlow', P.blow), 6900);
  }

  /* ---- awards ---- */
  function runAwards() {
    $('awards').innerHTML = P.awards.map((a) => { const t = team(a.t); return `<div class="aw"><small>${esc(a.label)}</small><div class="who"><span class="em">${ic(t)}</span><span style="color:${esc(vis(t.color))}">${esc(t.name)}</span></div><div class="stat">${esc(a.stat)}</div><div class="note">${esc(a.note)}</div></div>`; }).join('');
    R('s5k', 200); [...$('awards').children].forEach((c, i) => wait(() => c.classList.add('in'), 900 + i * 1700));
  }

  /* ---- podium + confetti ---- */
  function runPodium() {
    const champ = P.champ, cc = vis(team(champ).color);
    const defs = { 2: ['#b8bec7', 56], 1: ['#e0b23d', 88], 3: ['#c17a4a', 36] };
    const places = [2, 1, 3].filter((p) => P.podium[p] != null);
    $('podium').innerHTML = places.map((r) => { const t = team(P.podium[r]); return `<div class="pcol" id="yc_pc${r}"><div class="who"><div class="em">${ic(t)}</div><div class="nm" style="color:${esc(vis(t.color))}">${esc(t.name)}</div></div><div class="blk" style="background:${defs[r][0]}" data-h="${defs[r][1]}">${r}</div></div>`; }).join('');
    const cn = $('champName'); cn.textContent = team(champ).name.toUpperCase(); cn.style.color = cc; cn.classList.remove('in'); $('spot').style.setProperty('--champ', cc); $('champK').style.opacity = 0;
    $('spot').classList.remove('in'); conf = []; $('beam6').classList.remove('in'); $('beam6').style.setProperty('--bc', cc);
    R('s6k', 200);
    const up = (r, ms) => { if (P.podium[r] == null) return; wait(() => { const c = $('pc' + r); c.classList.add('show'); const b = c.querySelector('.blk'); b.style.height = b.dataset.h + '%'; }, ms); };
    up(3, 1200); up(2, 3200);
    wait(() => { [2, 3].forEach((r) => { const c = $('pc' + r); if (c) c.classList.add('dim'); }); const c = $('pc1'); c.classList.add('show'); c.querySelector('.blk').style.height = '88%'; }, 6000);
    wait(() => { const st = $('s6').querySelector('.stack'); st.classList.remove('shake'); void st.offsetWidth; st.classList.add('shake'); $('beam6').classList.add('in'); $('spot').classList.add('in'); $('champK').style.opacity = 1; cn.classList.add('in'); burst(); }, 7600);
    wait(burst, 9300);
    const cv = $('confetti'); const x = cv.getContext('2d'); cv.width = cv.clientWidth; cv.height = cv.clientHeight;
    const cols = [cc, '#e0b23d', '#fff', '#ff5a5f', '#4a8fe0'];
    function burst() { for (let i = 0; i < 140; i++) conf.push({ x: cv.width / 2, y: cv.height * .55, vx: (Math.random() - .5) * 14, vy: -Math.random() * 15 - 4, r: 3 + Math.random() * 5, c: cols[i % cols.length], rot: Math.random() * 6, vr: (Math.random() - .5) * .4, life: 1 }); }
    const f = () => { raf = requestAnimationFrame(f); x.clearRect(0, 0, cv.width, cv.height); for (let i = conf.length - 1; i >= 0; i--) { const p = conf[i]; p.vy += .35 * speed; p.x += p.vx * speed; p.y += p.vy * speed; p.vx *= .995; p.rot += p.vr; p.life -= .004 * speed; if (p.life <= 0 || p.y > cv.height + 20) { conf.splice(i, 1); continue; } x.save(); x.translate(p.x, p.y); x.rotate(p.rot); x.globalAlpha = Math.min(1, p.life * 2); x.fillStyle = p.c; x.fillRect(-p.r, -p.r / 2, p.r * 2, p.r); x.restore(); } };
    f();
  }

  /* ------------------------------ engine ------------------------------ */
  function progress() {
    progRaf = requestAnimationFrame(progress);
    const dots = $('dots'); const b = dots.children[idx] && dots.children[idx].firstChild; if (!b || paused) return;
    b.style.width = (Math.min(1, (performance.now() - sceneT0) * speed / sceneDur) * 100) + '%';
  }
  function show(i) {
    clearTimers(); clearTimeout(advT); seq++; idx = Math.max(0, Math.min(scenes.length - 1, i));
    scenes.forEach((s, k) => $(s.id).classList.toggle('on', k === idx));
    [...$('dots').children].forEach((d, k) => { d.classList.toggle('done', k < idx); d.firstChild.style.width = k < idx ? '100%' : '0'; });
    const w = $('wipe'); w.classList.remove('go'); void w.offsetWidth; w.classList.add('go');
    const sc = $(scenes[idx].id), st = sc.querySelector('.stack'); if (st) { st.classList.remove('push'); void st.offsetWidth; st.classList.add('push'); }
    const s = scenes[idx]; reset(sc); sceneDur = s.dur; sceneT0 = performance.now();
    if (s.id === 's1') particles($('bg1'), '#8aa4ff');
    s.go();
    advT = setTimeout(() => { if (!paused && idx < scenes.length - 1) show(idx + 1); }, s.dur / speed);
  }
  function next() { if (idx < scenes.length - 1) show(idx + 1); else finish(); }

  function revealPage() {
    // soft staggered fade-in of the real page underneath (Web Animations, leaves no inline styles behind)
    if (reduced() || !Element.prototype.animate) return;
    const els = [...document.querySelectorAll('#heroContent > *, .page > *')].filter((e) => e.offsetParent !== null && e.id !== 'yc_heroEmblem').slice(0, 9);
    els.forEach((e, i) => e.animate([{ opacity: 0, transform: 'translateY(22px)' }, { opacity: 1, transform: 'none' }], { duration: 750, delay: 250 + i * 70, easing: 'cubic-bezier(.2,.8,.2,1)', fill: 'backwards' }));
  }
  function finish() {
    if (!open) return; open = false;
    clearTimers(); clearTimeout(advT); cancelAnimationFrame(progRaf); seq++;
    document.body.classList.remove('yc-lock'); window.scrollTo(0, 0);
    const cine = $('cine'), src = $('s7e'), tgt = $('heroEmblem'), champ = P.champ;
    const flew = champ != null && tgt && idx === scenes.length - 1 && src.classList.contains('in') && !reduced();
    const hero = document.getElementById('hero');
    if (champ != null) document.documentElement.style.setProperty('--yc-champ', vis(team(champ).color));
    revealPage();
    const landed = () => { if (tgt) { tgt.classList.remove('pending'); tgt.classList.add('in'); } if (hero) { hero.classList.remove('yc-champglow'); void hero.offsetWidth; hero.classList.add('yc-champglow'); } };
    if (flew) {
      const a = src.getBoundingClientRect(); const fl = document.createElement('div'); fl.id = 'yc_flyer'; fl.innerHTML = src.innerHTML; fl.style.setProperty('--champ', vis(team(champ).color));
      Object.assign(fl.style, { left: a.left + 'px', top: a.top + 'px', width: a.width + 'px', height: a.height + 'px', fontSize: getComputedStyle(src).fontSize });
      document.body.appendChild(fl); src.style.visibility = 'hidden';
      requestAnimationFrame(() => requestAnimationFrame(() => {
        const t = tgt.getBoundingClientRect(); const k = t.width / a.width;
        fl.style.transform = `translate(${t.left - a.left}px, ${t.top - a.top}px) scale(${k})`; cine.classList.add('gone');
        setTimeout(() => { landed(); fl.style.opacity = 0; setTimeout(() => { fl.remove(); src.style.visibility = ''; }, 500); }, 1250);
      }));
    } else { cine.classList.add('gone'); setTimeout(landed, 900); }
  }

  function build() {
    if (built) return; built = true;
    if (!document.getElementById('yc_styleBase')) { const st = document.createElement('style'); st.id = 'yc_styleBase'; st.textContent = CSS; document.head.appendChild(st); }
    const root = document.createElement('div'); root.id = 'yc_cine'; root.className = 'gone'; root.innerHTML = HTML; document.body.appendChild(root);
    root.addEventListener('click', (e) => { if (e.target.closest('#yc_chrome')) return; next(); });
    $('skipBtn').onclick = (e) => { e.stopPropagation(); finish(); };
    $('speedBtn').onclick = (e) => { e.stopPropagation(); speed = speed === 1 ? 2 : 1; $('speedBtn').textContent = speed + 'x'; };
    $('pauseBtn').onclick = (e) => {
      e.stopPropagation(); paused = !paused; $('pauseBtn').textContent = paused ? '▶ Play' : '❚❚ Pause';
      if (paused) clearTimeout(advT); else { const left = Math.max(400, (sceneDur - (performance.now() - sceneT0) * speed) / speed); advT = setTimeout(() => { if (idx < scenes.length - 1) show(idx + 1); else finish(); }, left); }
    };
    if (!keyBound) { keyBound = true; addEventListener('keydown', (e) => { if (!open) return; if (e.key === 'Escape') finish(); else if (e.key === ' ' || e.key === 'ArrowRight') { e.preventDefault(); next(); } else if (e.key === 'ArrowLeft') show(idx - 1); }); }
  }

  function play(payload) {
    if (!payload || !payload.order || !payload.order.length) return;
    P = payload; T = payload.teams || {}; build(); buildScenes();
    const dots = $('dots'); dots.innerHTML = ''; scenes.forEach(() => { const i = document.createElement('i'); i.innerHTML = '<b></b>'; dots.appendChild(i); });
    paused = false; speed = 1; $('pauseBtn').textContent = '❚❚ Pause'; $('speedBtn').textContent = '1x';
    const tgt = $('heroEmblem'); if (tgt && P.champ != null) { tgt.classList.remove('in'); tgt.classList.add('pending'); }
    const hero = document.getElementById('hero'); if (hero) hero.classList.remove('yc-champglow');
    const root = $('cine'); root.classList.remove('gone'); root.classList.add('lb'); root.style.setProperty('--champ', vis(P.champ != null ? team(P.champ).color : '#e0b23d'));
    document.body.classList.add('yc-lock'); open = true; cancelAnimationFrame(progRaf); progress(); show(0);
  }

  /* hero emblem + replay button, and one-time autoplay */
  function attach(payload, opts) {
    opts = opts || {};
    if (!payload || !payload.order || !payload.order.length) return;
    P = payload; T = payload.teams || {};
    const hc = document.getElementById('heroContent'); if (!hc) return;
    if (!document.getElementById('yc_styleBase')) { const s = document.createElement('style'); s.id = 'yc_styleBase'; s.textContent = CSS; document.head.appendChild(s); }
    ['yc_heroEmblem', 'yc_replay'].forEach((id) => { const e = document.getElementById(id); if (e) e.remove(); });
    if (payload.champ != null) {
      const c = team(payload.champ); const em = document.createElement('div'); em.id = 'yc_heroEmblem'; em.className = 'yc-emb'; em.innerHTML = ic(c); em.style.setProperty('--champ', vis(c.color)); em.title = `${c.name} — ${payload.year} champions`; hc.insertBefore(em, hc.firstChild);
    }
    const btn = document.createElement('button'); btn.id = 'yc_replay'; btn.type = 'button'; btn.textContent = '▶ Replay the season'; btn.onclick = () => { window.scrollTo(0, 0); play(payload); }; hc.appendChild(btn);
    let on = true; try { on = localStorage.getItem(PREF_KEY) !== 'false'; } catch (e) { /* storage blocked */ }
    let seen = false; try { seen = !!(opts.seenKey && localStorage.getItem(opts.seenKey)); } catch (e) { /* storage blocked */ }
    if (on && !seen && !reduced() && !(window.location.hash && /nocinema/.test(window.location.hash))) {
      try { if (opts.seenKey) localStorage.setItem(opts.seenKey, '1'); } catch (e) { /* storage blocked */ }
      play(payload);
    }
  }

  window.YearCinema = { attach, play, _prefKey: PREF_KEY };
})();
