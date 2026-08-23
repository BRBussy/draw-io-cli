import { readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

/**
 * Directories searched for installed hediet.vscode-drawio extensions.
 */
function extensionRoots() {
  const home = homedir();
  return [join(home, ".vscode", "extensions"), join(home, ".cursor", "extensions")];
}

/**
 * Locates the draw.io webapp bundled inside the hediet.vscode-drawio
 * extension. Returns the absolute webapp path, or null when no install
 * is found. When several versions are installed the highest directory
 * name wins.
 */
export function locateWebapp() {
  const candidates = [];
  for (const root of extensionRoots()) {
    let entries;
    try {
      entries = readdirSync(root);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.startsWith("hediet.vscode-drawio-")) continue;
      const webapp = join(root, entry, "drawio", "src", "main", "webapp");
      if (existsSync(join(webapp, "js", "app.min.js"))) candidates.push(webapp);
    }
  }
  candidates.sort();
  return candidates.at(-1) ?? null;
}

/**
 * The bootstrap page for the bundled webapp. The extension ships the app
 * without an index.html, so this page supplies what the app scripts expect
 * before they run: mxIsElectron, urlParams (embed JSON protocol, offline),
 * isLocalStorage, and the mxscript/mxinclude loader shims. It also filters
 * the "help" entry out of the default menus before App.main(), which
 * otherwise crashes the embedded app.
 */
export const BOOTSTRAP_HTML = `<!DOCTYPE html><html><head><base href="webapp/"><meta charset="UTF-8">
<link rel="stylesheet" type="text/css" href="styles/grapheditor.css">
<script>
Object.defineProperty(window,"mxIsElectron",{value:false});
var urlParams={embed:"1",proto:"json",ui:"min",dark:"0",noSaveBtn:"1",noExitBtn:"1",spin:"1",libraries:"0",offline:"1"};
var isLocalStorage=true;
function mxscript(src,onLoad,id,dataAppKey,noWrite){if(onLoad!=null||noWrite){var s=document.createElement("script");s.type="text/javascript";s.src=src;var r=false;if(id!=null)s.id=id;if(dataAppKey!=null)s.setAttribute("data-app-key",dataAppKey);if(onLoad!=null){s.onload=s.onreadystatechange=function(){if(!r&&(!this.readyState||this.readyState=="complete")){r=true;onLoad();}};}var t=document.getElementsByTagName("script")[0];if(t!=null)t.parentNode.insertBefore(s,t);}else{document.write('<script src="'+src+'"'+(id!=null?' id="'+id+'" ':"")+"></scr"+"ipt>");}}
function mxinclude(src){var g=document.createElement("script");g.type="text/javascript";g.async=true;g.src=src;var s=document.getElementsByTagName("script")[0];s.parentNode.insertBefore(g,s);}
</script>
<script src="js/PreConfig.js"></script>
<script src="js/app.min.js"></script>
<script src="js/extensions.min.js"></script>
<script src="js/stencils.min.js"></script>
<script src="js/shapes-14-6-5.min.js"></script>
<script src="js/PostConfig.js"></script>
</head><body class="geEditor"><div id="geInfo"><h2 id="geStatus">Loading...</h2></div>
<script>Menus.prototype.defaultMenuItems=Menus.prototype.defaultMenuItems.filter(function(i){return i!=="help"});App.main();</script>
</body></html>`;

/**
 * The host page that iframes the bootstrap page and speaks the draw.io
 * embed JSON protocol over postMessage. The driving Node process reads
 * window.__state and window.__export and calls window.loadXml and
 * window.exportAs through playwright.
 */
export const HOST_HTML = `<!doctype html><html><body style="margin:0">
<iframe id="f" style="width:100vw;height:100vh;border:0"></iframe>
<script>
window.__state="booting";window.__export=null;
var f=document.getElementById("f");
window.addEventListener("message",function(ev){
  var m;try{m=JSON.parse(ev.data)}catch(e){return}
  if(m.event==="init"){window.__state="init"}
  if(m.event==="load"){window.__state="loaded"}
  if(m.event==="export"){window.__export=m.data;window.__state="exported"}
});
window.loadXml=function(xml){f.contentWindow.postMessage(JSON.stringify({action:"load",xml:xml,autosave:0}),"*")};
window.exportAs=function(format,scale,border){window.__export=null;window.__state="exporting";f.contentWindow.postMessage(JSON.stringify({action:"export",format:format,scale:scale,border:border}),"*")};
f.src="app.html";
</script></body></html>`;
