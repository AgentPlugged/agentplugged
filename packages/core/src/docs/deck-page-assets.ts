/**
 * The fixed parts of the page of a deck: its style and its script. They hold no text
 * of the deck: the deck only ever reaches the page as escaped text in the markup, never here, so a
 * deck cannot change what the page does.
 */

const LIGHT =
  "--bg:#fbfbfa;--fg:#1b1d21;--mut:#555b64;--acc:#1f5fd1;--card:#eceff3;--line:#cfd5dc;--code:#e4e8ee";
const DARK =
  "--bg:#15171b;--fg:#eceef1;--mut:#a3aab5;--acc:#7fb0ff;--card:#21252b;--line:#363c45;--code:#262b32";

export const DECK_PAGE_STYLE = `
:root{${LIGHT};color-scheme:light dark}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){${DARK}}}
:root[data-theme="dark"]{${DARK}}
:root[data-theme="light"]{${LIGHT}}
*{box-sizing:border-box}
html,body{margin:0;background:var(--bg);color:var(--fg);font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;line-height:1.4}
.slide{padding:6vmin 8vmin 10vmin;min-height:100vh;display:flex;flex-direction:column;justify-content:center;border-bottom:1px solid var(--line)}
.slide>.in{max-width:70rem;width:100%;margin:0 auto}
h2{font-size:2.2em;line-height:1.15;margin:0 0 .6em}
h3,h4,h5,h6{margin:.8em 0 .3em;color:var(--acc)}
p,ul,ol,blockquote,table,pre,figure{margin:.5em 0}
ul,ol{padding-left:1.3em}
li{margin:.25em 0}
a{color:var(--acc)}
code{background:var(--code);padding:.05em .3em;border-radius:.25em;font-family:ui-monospace,Consolas,monospace;font-size:.9em}
pre{background:var(--code);padding:.7em 1em;border-radius:.4em;overflow:auto}
pre code{padding:0;background:none}
blockquote{border-left:.25em solid var(--acc);margin-left:0;padding:.1em 1em;color:var(--mut)}
table{border-collapse:collapse}
th,td{border:1px solid var(--line);padding:.35em .7em;text-align:left}
th{background:var(--card)}
.vis{color:var(--mut);font-size:.8em;margin-top:1em}
.stats{display:flex;flex-wrap:wrap;gap:1em;margin:.8em 0}
.stat{flex:1 1 9em;background:var(--card);border-radius:.6em;padding:.6em .8em;margin:0;text-align:center}
.stat svg{width:100%;height:auto;max-height:4.5em;fill:var(--acc);font-weight:700;font-family:inherit}
.stat strong{display:block;font-size:1.5em;line-height:1.2;color:var(--acc);margin:.2em 0}
.stat span{display:block;color:var(--mut);font-size:.85em}
.flow{display:flex;flex-wrap:wrap;gap:.5em;align-items:stretch;margin:.8em 0}
.flow>div{display:flex;align-items:center;gap:.5em}
.flow .box{background:var(--card);border:2px solid var(--acc);border-radius:.5em;padding:.5em .9em}
.flow svg{width:1.8em;height:1em;stroke:var(--acc);fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
.quote{margin:.8em 0}
.quote svg{width:3em;height:auto;fill:var(--acc)}
.quote blockquote{font-size:1.4em;color:var(--fg);border:0;padding:0;font-style:italic}
.quote figcaption{color:var(--mut)}
.notes{margin-top:1.2em;padding:.6em 1em;border:1px dashed var(--line);border-radius:.4em;color:var(--mut);font-size:.8em}
.notes h3{margin:.1em 0 .3em;font-size:1em}
.ctl,.bar{display:none}
html.js .slide{display:none;min-height:100vh}
html.js .slide.current{display:flex}
html.js .notes{display:none}
html.js body.notes-on .slide.current .notes{display:block}
html.js .ctl{position:fixed;left:0;right:0;bottom:.4em;display:flex;flex-wrap:wrap;gap:.4em;justify-content:center;align-items:center;font-size:.85rem;color:var(--mut)}
html.js .ctl button{font:inherit;color:var(--fg);background:var(--card);border:1px solid var(--line);border-radius:.4em;padding:.25em .7em;cursor:pointer}
html.js .ctl button:focus-visible{outline:2px solid var(--acc)}
html.js .bar{display:block;position:fixed;left:0;right:0;bottom:0;height:.25em;background:var(--line)}
html.js .bar i{display:block;height:100%;width:0;background:var(--acc)}
html.js .slide{font-size:min(2.6vw,4.6vh)}
@media (max-width:40rem){html.js .slide{font-size:1rem}}
@media print{
:root{--bg:#fff!important;--fg:#111!important;--mut:#444!important;--acc:#1f5fd1!important;--card:#f0f2f5!important;--line:#bbb!important;--code:#eee!important}
@page{size:landscape;margin:12mm}
html.js .slide,html.js .slide.current{display:flex;min-height:100vh;border:0;break-after:page;page-break-after:always}
.ctl,.bar{display:none!important}
html.js body.notes-on .notes{display:block}
}
`
  .replace(/\n/g, "")
  .trim();

/** The script: moves from slide to slide. It reads the page, never the network. */
export const DECK_PAGE_SCRIPT = `(function(){
var d=document,h=d.documentElement,s=[].slice.call(d.querySelectorAll(".slide")),n=s.length,i=0;
if(!n)return;
h.classList.add("js");
var c=d.getElementById("count"),b=d.getElementById("bar");
function go(k,quiet){
i=Math.max(0,Math.min(n-1,k));
s.forEach(function(e,j){e.classList.toggle("current",j===i);});
c.textContent=(i+1)+" / "+n;b.style.width=((i+1)/n*100)+"%";
if(!quiet){try{history.replaceState(null,"","#"+(i+1));}catch(e){}}
}
function fromHash(){var m=/^#(\\d+)$/.exec(location.hash);go(m?+m[1]-1:0,true);}
function theme(){
var t=h.getAttribute("data-theme"),dark=t?t==="dark":matchMedia("(prefers-color-scheme: dark)").matches;
h.setAttribute("data-theme",dark?"light":"dark");
}
function notes(){d.body.classList.toggle("notes-on");}
function full(){try{if(d.fullscreenElement){d.exitFullscreen();}else{var r=h.requestFullscreen();if(r&&r.catch){r.catch(function(){});}}}catch(e){}}
d.getElementById("prev").onclick=function(){go(i-1);};
d.getElementById("next").onclick=function(){go(i+1);};
d.getElementById("notes").onclick=notes;
d.getElementById("theme").onclick=theme;
d.getElementById("full").onclick=full;
d.addEventListener("keydown",function(e){
if(e.altKey||e.ctrlKey||e.metaKey)return;
var k=e.key;
if((k===" "||k==="Enter")&&e.target&&(e.target.tagName==="BUTTON"||e.target.tagName==="A"))return;
if(k==="ArrowRight"||k==="ArrowDown"||k==="PageDown"||(k===" "&&!e.shiftKey)||k==="Enter")go(i+1);
else if(k==="ArrowLeft"||k==="ArrowUp"||k==="PageUp"||k==="Backspace"||(k===" "&&e.shiftKey))go(i-1);
else if(k==="Home")go(0);
else if(k==="End")go(n-1);
else if(k==="n"||k==="N")notes();
else if(k==="t"||k==="T")theme();
else if(k==="f"||k==="F")full();
else return;
e.preventDefault();
});
addEventListener("hashchange",fromHash);
fromHash();
})();`;

/** The words of the controls, by language. */
export const DECK_PAGE_LABELS = {
  en: {
    prev: "Previous",
    next: "Next",
    notes: "Notes",
    theme: "Theme",
    full: "Full screen",
    speaker: "Speaker notes",
    slide: "Slide",
    hint: "Keys: arrows, space, N notes, T theme, F full screen",
  },
  fr: {
    prev: "Précédent",
    next: "Suivant",
    notes: "Notes",
    theme: "Thème",
    full: "Plein écran",
    speaker: "Notes de l'orateur",
    slide: "Diapositive",
    hint: "Touches : flèches, espace, N notes, T thème, F plein écran",
  },
} as const;
