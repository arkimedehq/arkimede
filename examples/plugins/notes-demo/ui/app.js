// The page talks to Arkimede only through the bridge (postMessage): it has no network access of its own.
let next = 1;
const waiting = new Map();
window.addEventListener('message', (e) => {
  const m = e.data;
  if (e.source !== window.parent || !m || m.arkimede !== 1 || !waiting.has(m.id)) return;
  waiting.get(m.id)(m);
  waiting.delete(m.id);
});
function ask(message) {
  const id = next++;
  return new Promise((resolve) => {
    waiting.set(id, resolve);
    window.parent.postMessage({ arkimede: 1, id, ...message }, '*');
  });
}

const list = document.getElementById('notes');
const status = document.getElementById('status');

async function load() {
  const r = await ask({ type: 'request', method: 'GET', path: 'notes' });
  if (!r.ok) { status.textContent = 'Notes not available.'; return; }
  const notes = r.body.notes || [];
  status.textContent = notes.length ? '' : 'No notes yet.';
  list.replaceChildren(...notes.map((n) => {
    const li = document.createElement('li');
    li.textContent = n.text;
    const meta = document.createElement('small');
    meta.textContent = ` — ${n.by || ''} ${new Date(n.at).toLocaleString()}`;
    li.append(meta);
    return li;
  }));
}

document.getElementById('add').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = document.getElementById('text');
  const r = await ask({ type: 'request', method: 'POST', path: 'notes', body: { text: input.value } });
  if (r.ok) { input.value = ''; load(); } else status.textContent = (r.body && r.body.error) || 'Not saved.';
});

ask({ type: 'context' }).then((r) => { if (r.ok) document.documentElement.dataset.theme = r.body.theme; });
load();
