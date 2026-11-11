import { createServer } from 'node:http'

const html = `<!doctype html><meta charset="utf-8"><title>Focus proof form</title>
<body style="font:16px sans-serif;padding:24px;height:2200px">
<h1>Booking form</h1>
<form id="f" onsubmit="event.preventDefault(); document.getElementById('out').textContent='submitted '+(++window.n||(window.n=1)); return false">
<p><label>Your name <input id="name" type="text" name="name"></label></p>
<p><label>Secret <input id="secret" type="password" name="secret"></label></p>
<p><label>Colour <select id="colour" name="colour"><option>Red</option><option>Green</option><option>Blue</option></select></label></p>
<p><label><input id="agree" type="checkbox"> I agree</label></p>
<p><label>Attach <input id="file" type="file"></label></p>
<p><button id="send" type="submit">Send</button></p>
</form>
<p id="out">not submitted</p>
<script>
// A greedy page: every mousedown and click also calls .focus() on the field, like many sign-in pages do.
for (const id of ['name','secret','colour','agree','send']) {
  const el = document.getElementById(id);
  el.addEventListener('mousedown', () => setTimeout(() => el.focus(), 0));
}
window.addEventListener('load', () => document.getElementById('name').focus());
</script>`

createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  res.end(html)
}).listen(8765, '127.0.0.1', () => console.log('site up'))
