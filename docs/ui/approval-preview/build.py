#!/usr/bin/env python3
"""Build the isolated D-3/D-4 approval page.

Usage: python3 -I build.py <supplement-dir> <output-dir>

The output directory must be OUTSIDE the repository: it holds candidate fonts and
mascot frames that are not yet approved production assets. Nothing here is imported
by application code. The CSS palette in the page is documentation-only, not tokens.
"""
import html, shutil, sys
from pathlib import Path

sup, out = Path(sys.argv[1]), Path(sys.argv[2])
if (out / '.git').exists() or any(p.name == '.git' for p in out.parents):
    sys.exit('refusing: output must be outside any git worktree')
(out / 'fonts').mkdir(parents=True, exist_ok=True)
# Unchanged upstream TTFs and licence files (no conversion, no subsetting).
for src, name in [
    ('fonts/unifrakturcook/UnifrakturCook-Bold.ttf', 'UnifrakturCook-Bold.ttf'),
    ('fonts/unifrakturcook/OFL.txt', 'UnifrakturCook-OFL.txt'),
    ('fonts/linux-libertine/LinLibertine_Rah.ttf', 'LinLibertine_Rah.ttf'),
    ('fonts/linux-libertine/LinLibertine_RBah.ttf', 'LinLibertine_RBah.ttf'),
    ('fonts/linux-libertine/OFL-1.1.txt', 'LinLibertine-OFL-1.1.txt'),
    ('fonts/linux-libertine/GPL.txt', 'LinLibertine-GPL.txt'),
    ('fonts/linux-libertine/LICENCE.txt', 'LinLibertine-LICENCE.txt'),
]:
    shutil.copyfile(sup / src, out / 'fonts' / name)

def svg(path, size=None, label=None):
    s = (sup / 'mascot' / path).read_text()
    s = s.replace('width="96" height="96"', 'class="sk"', 1)
    return s

wipe = [svg(f'frames/wipe-bottom-to-top/0{i}.svg') for i in range(1, 7)]
thinking = svg('frames/thinking/02.svg')
loading = svg('frames/loading/03.svg')
idle = svg('frames/idle/01.svg')
transition = svg('frames/phase-transition/04.svg')

def frames_row():
    return ''.join(
        f'<figure><div class="cell s2">{w}</div><figcaption>{i+1}/6</figcaption></figure>'
        for i, w in enumerate(wipe))

def surface_block(cls, title):
    return f'''
<section class="surface {cls}"><h3>{title}</h3>
  <div class="row">
    <figure><div class="cell s1">{idle}</div><figcaption>24 px (1×)</figcaption></figure>
    <figure><div class="cell s2">{idle}</div><figcaption>48 px (2×, proposed desktop)</figcaption></figure>
    <figure><div class="cell s4">{idle}</div><figcaption>96 px (4×)</figcaption></figure>
    <figure><div class="cell m">{idle}</div><figcaption>32 px (mobile, non-integer — see note)</figcaption></figure>
  </div>
  <div class="row">
    <div class="status"><span class="cell s2">{thinking}</span><span>Thinking · Planner running</span></div>
    <div class="status"><span class="cell s2">{loading}</span><span>Loading providers…</span></div>
    <div class="status"><span class="cell s2">{transition}</span><span>Phase changed: Implementer started</span></div>
  </div>
  <div class="row">
    <div class="player" data-speed="70"><div class="cell s4 stage">{wipe[0]}</div><div><b>Wipe, normal (70 ms/frame)</b><br><button type="button" class="play">Play</button></div></div>
    <div class="player" data-speed="350"><div class="cell s4 stage">{wipe[0]}</div><div><b>Wipe, slow (350 ms/frame)</b><br><button type="button" class="play">Play</button></div></div>
  </div>
</section>'''

page = f'''<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Turing Terminal — D-3/D-4 approval preview</title>
<style>
@font-face{{font-family:Display;src:url(fonts/UnifrakturCook-Bold.ttf) format("truetype");font-weight:700}}
@font-face{{font-family:Reading;src:url(fonts/LinLibertine_Rah.ttf) format("truetype");font-weight:400}}
@font-face{{font-family:Reading;src:url(fonts/LinLibertine_RBah.ttf) format("truetype");font-weight:700}}
/* DOCUMENTATION PALETTE ONLY. Not production tokens. Surfaces approximated from mockup P1 samples. */
:root{{--doc-canvas:#07090a;--doc-panel:#0e1112;--doc-ink:#e8e6e3;--doc-ink2:#b4b0ab;--doc-line:#2a2f33;--doc-crimson:#d8424f;
--tt-mascot-outline:#141418;--tt-mascot-body:#bcbcc0;--tt-mascot-shade:#a4a4aa;--tt-mascot-accent:#bc303c}}
*{{box-sizing:border-box}}body{{margin:0;background:var(--doc-canvas);color:var(--doc-ink);font:16px/1.45 Reading,serif}}
main{{max-width:1100px;margin:0 auto;padding:24px 16px 48px}}
h1,h2,h3{{font-family:Reading,serif;font-weight:700;margin:.2em 0}}h2{{border-top:1px solid var(--doc-line);padding-top:16px;margin-top:32px}}
.display{{font-family:Display,serif;font-weight:700}}
.wordmark{{font-size:44px;line-height:1.1;margin:0}}.title{{font-size:34px;line-height:1.15;margin:.2em 0}}
.surface{{padding:16px;border:1px solid var(--doc-line);border-radius:8px;margin:12px 0}}
.canvas{{background:var(--doc-canvas)}}.panel{{background:var(--doc-panel)}}
.row{{display:flex;flex-wrap:wrap;gap:20px;align-items:flex-end;margin:12px 0}}
figure{{margin:0;text-align:center}}figcaption{{font-size:13px;color:var(--doc-ink2)}}
.cell{{display:inline-block;line-height:0}}.cell .sk{{display:block;width:100%;height:100%;image-rendering:pixelated}}
.s1{{width:24px;height:24px}}.s2{{width:48px;height:48px}}.s4{{width:96px;height:96px}}.m{{width:32px;height:32px}}
.status{{display:flex;align-items:center;gap:10px;padding:8px 12px;border:1px solid var(--doc-line);border-radius:8px}}
.player{{display:flex;gap:12px;align-items:center}}.stage{{background:rgba(255,255,255,.03);outline:1px dashed var(--doc-line)}}
button{{font:inherit;color:var(--doc-ink);background:#1a1d20;border:1px solid #555;border-radius:6px;padding:8px 14px;min-height:44px;cursor:pointer}}
button:focus-visible{{outline:2px solid var(--doc-crimson);outline-offset:2px}}
.note{{color:var(--doc-ink2);font-size:14px;max-width:80ch}}.mono{{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:13px}}
.bar{{display:inline-block;padding:2px 8px;border:1px solid var(--doc-line);border-radius:999px;font-size:13px}}
.mob{{max-width:390px}}.mob .title{{font-size:26px}}
</style></head><body><main>
<h1 class="display wordmark">Turing Terminal</h1>
<p class="note">D-3 / D-4 visual approval preview. <b>Candidates only.</b> Isolated from application code; the palette on this page is documentation styling, not production tokens. Fonts are the unchanged upstream TTFs (no conversion, no subsetting). Sizes below are proposals, not specified sizes.</p>

<h2>1 · UnifrakturCook on static branding and fixed titles</h2>
<div class="surface canvas">
  <p class="display wordmark">Turing Terminal</p>
  <p class="display title">Overview</p><p class="display title">New Task</p><p class="display title">Workflow routing</p>
  <p class="display title">Goal Engine run</p><p class="display title">Grand Projects</p>
  <p class="note">Reading face (Linux Libertine) for everything else: <span style="font-size:16px">Describe the outcome. Your workflow follows the roles and safeguards on the right.</span></p>
  <h3>Rule R-4 contrast (not a title)</h3>
  <p class="note">A Goal named by a user stays in the reading face: <b>“Migrate billing service — phase 2”</b> (not blackletter).</p>
</div>
<div class="surface panel mob"><p class="display wordmark" style="font-size:30px">Turing Terminal</p><p class="display title">New Task</p><p class="note">Mobile width (390 px) title sizing.</p></div>

<h2>2 · Clean skull at display sizes, with real text status</h2>
<p class="note">The mascot is decorative and <code>aria-hidden</code>; every state has adjacent text. The 32 px “mobile” cell is non-integer scaling of a 24 px grid and will blur or uneven pixels; the recommended mobile sizes are 24 px or 48 px.</p>
{surface_block('canvas', 'On canvas (≈ #07090a, sampled from mockup P1)')}
{surface_block('panel', 'On raised panel/rail (≈ #0e1112, sampled from mockup P1)')}

<h2>3 · Bottom-to-top wipe: every frame</h2>
<p class="note">Frame 6 is a single 4×4 px block; hold for one interval, then hide. Frames 3–4 have an unusual intermediate shape: please judge them.</p>
<div class="surface canvas"><div class="row">{frames_row()}</div></div>
<div class="surface panel"><div class="row">{frames_row()}</div></div>

<h2>Licences</h2>
<p class="note">UnifrakturCook Bold: OFL 1.1 with Reserved Font Name (fonts/UnifrakturCook-OFL.txt). Linux Libertine 5.3.0: OFL 1.1 and GPL with font exception (fonts/LinLibertine-*.txt).</p>
</main>
<script>
(function(){{
  var wipes={repr(wipe)};
  document.querySelectorAll('.player').forEach(function(p){{
    var stage=p.querySelector('.stage'),btn=p.querySelector('.play'),ms=+p.dataset.speed,timer=null;
    btn.addEventListener('click',function(){{
      if(timer){{clearInterval(timer);timer=null}}
      var i=0;stage.innerHTML=wipes[0];btn.textContent='Replay';
      timer=setInterval(function(){{
        i++;
        if(i<6){{stage.innerHTML=wipes[i]}}
        else{{clearInterval(timer);timer=null;stage.innerHTML=''}}
      }},ms);
      stage.innerHTML=wipes[0];
    }});
  }});
}})();
</script></body></html>'''
(out / 'index.html').write_text(page)
print('wrote', out / 'index.html')
