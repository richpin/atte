// Native browser smoke fixture: node src-tauri/tests/fixtures/web-browser.ts
import { createServer } from "node:http";

const server = createServer((request, response) => {
  if (request.url === "/redirect") {
    response.writeHead(302, { location: "/two" });
    response.end();
    return;
  }
  const two = request.url === "/two";
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(`<!doctype html><html><head><title>Webview ${two ? "Two" : "One"}</title>
<style>body{font:16px system-ui;padding:24px;color-scheme:light dark}a,button{display:block;margin:16px 0}input{font:inherit}</style></head>
<body><h1>Webview ${two ? "Two" : "One"}</h1>
<a href="/${two ? "one" : "two"}">Navigate to ${two ? "One" : "Two"}</a>
<a href="/two" target="_blank">Open new tab</a>
<a href="/redirect">Redirect to Two</a>
<button onclick="history.pushState({},'', '/spa');document.title='Webview SPA'">SPA navigation</button>
<input aria-label="Preserved input" placeholder="Preserved input">
<p id="ipc">Checking application command isolation…</p>
<script>
(()=>{const fixtureStatus=document.getElementById('ipc');
if(typeof window.__TAURI_INTERNALS__?.invoke==='function'){const timeout=setTimeout(()=>fixtureStatus.textContent='PASS: application commands unavailable',1000);window.__TAURI_INTERNALS__.invoke('list_threads').then(()=>{clearTimeout(timeout);fixtureStatus.textContent='FAIL: application commands exposed'}).catch(()=>{clearTimeout(timeout);fixtureStatus.textContent='PASS: application commands blocked'})}else{fixtureStatus.textContent='PASS: no application bridge'}})();
</script></body></html>`);
});
server.listen(1431, "127.0.0.1", () => {
  process.stdout.write("Webview fixture: http://127.0.0.1:1431/one\n");
});
