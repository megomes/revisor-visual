/* Revisor Visual: service worker / event page.
   Responsabilidades: ligar e desligar o modo a partir do botao da barra e do
   atalho de teclado, e manter o contador de comentarios no badge do icone. */

const api = globalThis.chrome ?? globalThis.browser;

async function sendToggle(tabId) {
  return new Promise((resolve, reject) => {
    let done = false;
    const cb = (resp) => {
      if (done) return;
      done = true;
      const err = api.runtime.lastError;
      if (err) reject(new Error(err.message));
      else resolve(resp);
    };
    try {
      const r = api.tabs.sendMessage(tabId, { type: 'rv-toggle' }, cb);
      if (r && typeof r.then === 'function') r.then(cb, reject);
    } catch (e) {
      reject(e);
    }
  });
}

async function toggle(tab) {
  if (!tab || tab.id == null) return;
  try {
    await sendToggle(tab.id);
    return;
  } catch (_) {
    /* content script ainda nao esta na pagina: injeta e tenta de novo */
  }
  try {
    await api.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
    await sendToggle(tab.id);
  } catch (e) {
    console.warn('Revisor Visual nao consegue rodar nesta aba:', e && e.message);
  }
}

api.action.onClicked.addListener((tab) => { toggle(tab); });

api.commands.onCommand.addListener((command) => {
  if (command !== 'toggle-review') return;
  const q = api.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs && tabs[0]) toggle(tabs[0]);
  });
  if (q && typeof q.then === 'function') q.then((tabs) => { if (tabs && tabs[0]) toggle(tabs[0]); });
});

function paintBadge(n) {
  const text = n > 0 ? String(n) : '';
  try {
    api.action.setBadgeText({ text });
    api.action.setBadgeBackgroundColor({ color: '#ff7a45' });
  } catch (_) {}
}

api.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === 'rv-count') paintBadge(msg.n | 0);
});
