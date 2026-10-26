/**
 * Sample pages for browser_upload, one per way a site takes a file. Every page shows the file it got and POSTs its
 * bytes to /upload?page=<name>, so a test reads what really arrived from the server, not what the tool claimed.
 * Used by test/browser-upload.test.ts and, run as a script (node upload-site.mjs <port> [log file]), by the built-app
 * proof.
 */
import { createServer } from 'node:http'
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

const REPORT = `<p id="out">No file yet</p>
<script>
window.__report = async (file, how) => {
  document.getElementById('out').textContent = 'Got ' + file.name + ' (' + file.size + ' bytes) by ' + how;
  const page = location.pathname.slice(1);
  await fetch('/upload?page=' + encodeURIComponent(page) + '&name=' + encodeURIComponent(file.name) + '&how=' + how, { method: 'POST', body: file });
};
</script>`

const head = (title) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<style>body{font:16px sans-serif;margin:24px} .btn{display:inline-block;padding:10px 16px;background:#4a3fd1;color:#fff;border-radius:8px;cursor:pointer;border:0}
.zone{width:320px;height:140px;border:2px dashed #888;display:flex;align-items:center;justify-content:center}</style></head><body><h1>${title}</h1>`

export const PAGES = {
  // (a) a plain visible field
  plain: `${head('Plain field')}<label>Your file <input type="file" id="f"></label>${REPORT}
<script>document.getElementById('f').addEventListener('change', (e) => { const f = e.target.files[0]; if (f) __report(f, 'change'); });</script></body></html>`,

  // (b) a hidden field behind a styled label
  label: `${head('Hidden behind a label')}<label for="resume" class="btn">Upload resume</label>
<input type="file" id="resume" style="display:none" accept=".pdf,.txt">${REPORT}
<script>document.getElementById('resume').addEventListener('change', (e) => { const f = e.target.files[0]; if (f) __report(f, 'change'); });</script></body></html>`,

  // (b2) a hidden field next to a styled button that clicks it
  button: `${head('Hidden behind a button')}<div class="row"><button class="btn" id="pick">Choose photo</button>
<input type="file" id="photo" hidden multiple></div>${REPORT}
<script>
document.getElementById('pick').addEventListener('click', () => document.getElementById('photo').click());
document.getElementById('photo').addEventListener('change', (e) => { const list = Array.from(e.target.files); list.forEach((f) => __report(f, 'change')); document.getElementById('out').dataset.count = String(list.length); });
</script></body></html>`,

  // (c) the field is made only when the button is clicked, never put in the page, and clicked by script
  oncreate: `${head('Made on click')}<button class="btn" id="add">Add attachment</button>${REPORT}
<script>
document.getElementById('add').addEventListener('click', () => {
  const input = document.createElement('input');
  input.type = 'file';
  input.addEventListener('change', () => { const f = input.files[0]; if (f) __report(f, 'change'); });
  input.click();
});
</script></body></html>`,

  // (d) showPicker() from a button, on a field added at that moment
  picker: `${head('showPicker')}<button class="btn" id="browse">Browse files</button>${REPORT}
<script>
document.getElementById('browse').addEventListener('click', () => {
  const input = document.createElement('input');
  input.type = 'file';
  input.style.cssText = 'position:absolute;left:-9999px;width:1px;height:1px;opacity:0';
  document.body.appendChild(input);
  input.addEventListener('change', () => { const f = input.files[0]; if (f) __report(f, 'change'); });
  input.showPicker();
});
</script></body></html>`,

  // (e) React 18: a controlled component that only learns of the file through its onChange (as LinkedIn and X do)
  react: `${head('React component')}<div id="root"></div>
<script src="/react.js"></script><script src="/react-dom.js"></script>
<script>
const h = React.createElement;
function Uploader() {
  const ref = React.useRef(null);
  const [file, setFile] = React.useState(null);
  React.useEffect(() => {
    if (!file) return;
    fetch('/upload?page=react&name=' + encodeURIComponent(file.name) + '&how=react', { method: 'POST', body: file });
  }, [file]);
  return h('div', null,
    h('button', { className: 'btn', type: 'button', onClick: () => ref.current.click() }, 'Upload profile photo'),
    h('input', { ref, type: 'file', accept: 'image/*,.txt', style: { display: 'none' }, onChange: (e) => setFile(e.target.files[0] || null) }),
    h('p', { id: 'out' }, file ? 'Got ' + file.name + ' (' + file.size + ' bytes) by react' : 'No file yet'));
}
ReactDOM.createRoot(document.getElementById('root')).render(h(Uploader));
</script></body></html>`,

  // (f) a drop zone and nothing else
  drop: `${head('Drop zone only')}<div class="zone" id="zone" role="button" aria-label="Drop your file here">Drop your file here</div>${REPORT}
<script>
const zone = document.getElementById('zone');
zone.addEventListener('dragover', (e) => e.preventDefault());
zone.addEventListener('drop', (e) => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) __report(f, 'drop'); });
</script></body></html>`,

  // (g) the field lives in an open shadow root, behind a button in the same shadow root
  shadow: `${head('Shadow DOM')}<file-picker></file-picker>${REPORT}
<script>
customElements.define('file-picker', class extends HTMLElement {
  connectedCallback() {
    const root = this.attachShadow({ mode: 'open' });
    root.innerHTML = '<button class="b" part="b">Attach file</button><input type="file" style="display:none">';
    const input = root.querySelector('input');
    root.querySelector('button').addEventListener('click', () => input.click());
    input.addEventListener('change', () => { const f = input.files[0]; if (f) __report(f, 'change'); });
  }
});
</script></body></html>`,

  // (h) a button that does nothing: no field, no chooser, no drop
  nothing: `${head('Nothing happens')}<button class="btn" id="up">Upload document</button>${REPORT}</body></html>`,
}

function reactFile(name) {
  const candidates = [
    join(here, '..', '..', 'node_modules', name),
    join(here, '..', '..', '..', '..', 'node_modules', name),
  ]
  for (const path of candidates) if (existsSync(path)) return readFileSync(path)
  return null
}

/** Starts the site. Returns { server, port, received } where received lists every file that arrived. */
export function startUploadSite(port = 0, logFile = '') {
  const received = []
  const react = reactFile('react/umd/react.production.min.js')
  const reactDom = reactFile('react-dom/umd/react-dom.production.min.js')
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (req.method === 'POST' && url.pathname === '/upload') {
      let size = 0
      req.on('data', (chunk) => {
        size += chunk.length
      })
      req.on('end', () => {
        const entry = { page: url.searchParams.get('page') ?? '', name: url.searchParams.get('name') ?? '', how: url.searchParams.get('how') ?? '', size, at: new Date().toISOString() }
        received.push(entry)
        if (logFile !== '') appendFileSync(logFile, `${JSON.stringify(entry)}\n`)
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end('{"ok":true}')
      })
      return
    }
    if (url.pathname === '/received') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(received))
      return
    }
    if (url.pathname === '/react.js' || url.pathname === '/react-dom.js') {
      const body = url.pathname === '/react.js' ? react : reactDom
      res.writeHead(body === null ? 404 : 200, { 'content-type': 'text/javascript' })
      res.end(body ?? '')
      return
    }
    const page = PAGES[url.pathname.slice(1)]
    if (page === undefined) {
      res.writeHead(404)
      res.end('not found')
      return
    }
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end(page)
  })
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      const address = server.address()
      resolve({ server, port: typeof address === 'object' && address !== null ? address.port : port, received })
    })
  })
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  const port = Number(process.argv[2] ?? '8671')
  const log = process.argv[3] ?? ''
  startUploadSite(port, log).then(({ port: p }) => console.log(`upload site on http://127.0.0.1:${p}`))
}
