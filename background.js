/* Revisor Visual: service worker / event page.
   Responsabilidades: ligar e desligar o modo a partir do botao da barra e do
   atalho de teclado, manter o contador de comentarios no badge do icone, levar
   recado entre o frame do topo e os iframes da mesma aba, que nao se enxergam
   quando sao de origens diferentes (o Artefato do Claude e o caso tipico), e
   cuidar do historico: guardar as sessoes, tirar a foto de cada item e levar a
   aba de volta ao item quando voce vai conferir. */

/* no Chrome o fundo e um service worker e carrega os outros arquivos aqui; no
   Firefox eles vem antes deste, pela lista do manifesto */
if (typeof importScripts === 'function') {
  try { importScripts('shared.js', 'db.js'); } catch (e) { console.warn('Revisor Visual:', e && e.message); }
}

const api = globalThis.chrome ?? globalThis.browser;
const { sameUrl } = globalThis.RVShared;
const RVDB = globalThis.RVDB;

/* tabs.sendMessage nos dois estilos: callback no Chrome, promise no Firefox */
function sendTo(tabId, msg, opts) {
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
      const r = api.tabs.sendMessage(tabId, msg, opts || {}, cb);
      if (r && typeof r.then === 'function') r.then(cb, reject);
    } catch (e) {
      reject(e);
    }
  });
}

/* o liga e desliga vai só para o frame do topo: o estado mora no storage, e os
   iframes ficam sabendo pela mudança dele */
const TOPO = { frameId: 0 };

async function toggle(tab) {
  if (!tab || tab.id == null) return;
  try {
    await sendTo(tab.id, { type: 'rv-toggle' }, TOPO);
    return;
  } catch (_) {
    /* content script ainda nao esta na pagina: injeta e tenta de novo */
  }
  try {
    await api.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, files: ['shared.js', 'content.js'] });
    await sendTo(tab.id, { type: 'rv-toggle' }, TOPO);
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

/* ------------------------------------------------------------------ */
/* histórico                                                           */
/* ------------------------------------------------------------------ */

/* avisa a página do histórico, se estiver aberta, que algo mudou */
function avisaHistorico() {
  try {
    const p = api.runtime.sendMessage({ type: 'rv-history-changed' });
    if (p && typeof p.catch === 'function') p.catch(() => {});
  } catch (_) {}
}

/* a sessão chega inteira da página. Item apagado da sessão some do histórico,
   a não ser que já tenha sido enviado: o que foi para o Claude fica */
async function guardaSessao(sess) {
  const velha = await RVDB.get('sessoes', sess.id);
  const agora = new Set(sess.items.map((i) => i.id));
  const enviados = new Set((sess.sends || []).flatMap((s) => s.ids));
  const ficam = velha ? velha.items.filter((i) => !agora.has(i.id) && enviados.has(i.id)) : [];
  const items = ficam.concat(sess.items)
    .sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
  await RVDB.put('sessoes', Object.assign({}, velha || {}, sess, {
    items,
    start: (velha && velha.start) || sess.start
  }));
  avisaHistorico();
}

function blobParaDataUrl(b) {
  return b.arrayBuffer().then((buf) => {
    const u = new Uint8Array(buf);
    let s = '';
    for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
    return 'data:' + (b.type || 'image/jpeg') + ';base64,' + btoa(s);
  });
}

/* foto do item no momento em que foi marcado, recortada da aba visível. Quando
   o item é de um iframe, o topo diz onde o iframe está na janela */
async function fotografa(msg, sender) {
  const tab = sender.tab;
  let dx = 0, dy = 0, vw = msg.vw;
  if (sender.frameId) {
    const fr = await sendTo(tab.id, { type: 'rv-frame-rect', w: msg.vw, h: msg.vh }, TOPO).catch(() => null);
    if (!fr) return false;
    dx = fr.x; dy = fr.y; vw = fr.vw;
  }
  const dataUrl = await api.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 90 });
  const bmp = await createImageBitmap(await (await fetch(dataUrl)).blob());
  const k = bmp.width / vw;
  /* recorta com a vizinhança: um título largo e baixo, sozinho, vira uma tira
     que não mostra onde ele está. A janela tem no mínimo 380 x 240, centrada no
     elemento e empurrada para dentro da tela quando encosta na borda */
  const telaW = bmp.width / k, telaH = bmp.height / k;
  const pad = 24;
  const janela = (ini, tam, min, tela) => {
    const t = Math.min(tela, Math.max(tam + 2 * pad, min));
    let o = ini + tam / 2 - t / 2;
    o = Math.max(0, Math.min(o, tela - t));
    return [o, t];
  };
  const [cx, cw] = janela(dx + msg.rect.x, msg.rect.w, 380, telaW);
  const [cy, chh] = janela(dy + msg.rect.y, msg.rect.h, 240, telaH);
  const x0 = cx * k, y0 = cy * k, w = cw * k, h = chh * k;
  if (w < 8 || h < 8) return false;
  const s = Math.min(1, 900 / w, 700 / h);
  const c = new OffscreenCanvas(Math.round(w * s), Math.round(h * s));
  c.getContext('2d').drawImage(bmp, x0, y0, w, h, 0, 0, c.width, c.height);
  const foto = await c.convertToBlob({ type: 'image/jpeg', quality: 0.82 });
  await RVDB.put('fotos', foto, msg.id);
  avisaHistorico();
  return true;
}

function focaJanela(tab) {
  try { api.windows.update(tab.windowId, { focused: true }); } catch (_) {}
}

/* leva uma aba até a página do item e deixa o pedido de foco no storage. O
   frame que mostra o painel naquela aba pega o pedido quando carrega, ou na
   hora, se a página já estiver aberta */
async function levaAoItem(sessionId, itemId, abaDeOrigem) {
  const sess = await RVDB.get('sessoes', sessionId);
  const it = sess && sess.items.find((i) => i.id === itemId);
  if (!it) return { ok: false };
  const conf = await RVDB.get('conferencia', itemId);

  let tab = null;
  if (abaDeOrigem) {
    tab = abaDeOrigem;
    if (!sameUrl(tab.url, it.url)) tab = await api.tabs.update(tab.id, { url: it.url });
  } else {
    const abas = await api.tabs.query({});
    const iguais = abas.filter((t) => t.url && sameUrl(t.url, it.url));
    tab = iguais.find((t) => t.active) || iguais[0] || null;
    if (tab) await api.tabs.update(tab.id, { active: true });
    else tab = await api.tabs.create({ url: it.url });
    focaJanela(tab);
  }

  const temFoto = !!(await RVDB.get('fotos', itemId));
  await api.storage.local.set({ rv_focus: {
    tabId: tab.id,
    at: Date.now(),
    sessionId,
    sessionEnd: sess.end,
    pos: sess.items.indexOf(it) + 1,
    total: sess.items.length,
    st: conf ? conf.st : null,
    temFoto,
    item: it
  } });
  return { ok: true };
}

/* o próximo item ainda sem conferência, depois do atual, dando a volta */
async function proximo(sessionId, depoisDe, aba) {
  const sess = await RVDB.get('sessoes', sessionId);
  if (!sess) return { done: true };
  const confs = new Map((await RVDB.all('conferencia')).map((c) => [c.id, c.st]));
  const i0 = sess.items.findIndex((i) => i.id === depoisDe);
  const ordem = sess.items.slice(i0 + 1).concat(sess.items.slice(0, Math.max(0, i0)));
  const prox = ordem.find((i) => !confs.get(i.id));
  if (!prox) return { done: true };
  return levaAoItem(sessionId, prox.id, aba);
}

async function marca(id, st) {
  if (st) await RVDB.put('conferencia', { id, st, at: new Date().toISOString() });
  else await RVDB.del('conferencia', id);
  avisaHistorico();
}

/* rodadas antigas: quem carrega a extensão desta pasta pode deixar ao lado do
   manifesto um historico-importar.md com exports colados em sequência. Cada
   rodada entra uma vez só, e apagar a sessão depois não a faz voltar */
let sementeFeita = null;
function importaSemente() {
  if (sementeFeita) return sementeFeita;
  sementeFeita = (async () => {
    let txt = null;
    try {
      const r = await fetch(api.runtime.getURL('historico-importar.md'));
      if (r.ok) txt = await r.text();
    } catch (_) { /* o arquivo não existe, que é o normal */ }
    if (!txt) return;
    const o = await api.storage.local.get('rv_seed_done');
    const feitas = new Set((o && o.rv_seed_done) || []);
    let novas = 0;
    for (const sess of globalThis.RVShared.parseExport(txt)) {
      if (feitas.has(sess.id)) continue;
      if (!(await RVDB.get('sessoes', sess.id))) await RVDB.put('sessoes', sess);
      feitas.add(sess.id);
      novas++;
    }
    if (novas) {
      await api.storage.local.set({ rv_seed_done: Array.from(feitas) });
      avisaHistorico();
    }
  })().catch((e) => console.warn('Revisor Visual:', e && e.message));
  return sementeFeita;
}
importaSemente();

/* o histórico inteiro para o painel da página: sessões, conferência e quais
   itens têm foto. As fotos vão uma a uma, por rv-shot-get */
async function listaHistorico() {
  await importaSemente();
  const [sessoes, confs, fotos] = await Promise.all([RVDB.all('sessoes'), RVDB.all('conferencia'), RVDB.keys('fotos')]);
  const st = {};
  for (const c of confs) st[c.id] = c.st;
  return { sessoes, confs: st, fotos };
}

async function abreHistorico() {
  const url = api.runtime.getURL('history.html');
  const abas = await api.tabs.query({});
  const ja = abas.find((t) => t.url && t.url.startsWith(url));
  if (ja) { await api.tabs.update(ja.id, { active: true }); focaJanela(ja); }
  else await api.tabs.create({ url });
}

/* pedido de foco: só vale para a aba que foi levada ao item, nos primeiros
   90 segundos, e para o frame que está na página do item */
async function entregaFoco(url, sender) {
  const o = await api.storage.local.get('rv_focus');
  const f = o && o.rv_focus;
  if (!f || !sender.tab || f.tabId !== sender.tab.id) return null;
  if (Date.now() - f.at > 90000) { await api.storage.local.remove('rv_focus'); return null; }
  if (!sameUrl(url, f.item.url)) return null;
  await api.storage.local.remove('rv_focus');
  return f;
}

/* responde a promise pelo callback, e um erro vira null */
function responde(p, send) {
  p.then((r) => send(r == null ? null : r), (e) => {
    console.warn('Revisor Visual:', e && e.message);
    send(null);
  });
  return true;
}

api.runtime.onMessage.addListener((msg, sender, send) => {
  if (!msg) return false;
  if (msg.type === 'rv-count') { paintBadge(msg.n | 0); return false; }

  /* mensagens que chegam também da página do histórico, que não é aba revisada */
  /* da página do histórico, procura ou abre a aba do item; do painel na
     página, com aqui, usa a própria aba */
  if (msg.type === 'rv-goto') {
    return responde(levaAoItem(msg.sessionId, msg.itemId, msg.aqui && sender.tab ? sender.tab : null), send);
  }
  if (msg.type === 'rv-hist-list') return responde(listaHistorico(), send);
  if (msg.type === 'rv-seed') return responde(importaSemente().then(() => true), send);
  if (msg.type === 'rv-review') return responde(marca(msg.id, msg.st).then(() => true), send);
  if (msg.type === 'rv-open-history') return responde(abreHistorico().then(() => true), send);
  if (msg.type === 'rv-shot-get') {
    return responde(RVDB.get('fotos', msg.id).then((b) => (b ? blobParaDataUrl(b) : null)), send);
  }

  const tabId = sender && sender.tab && sender.tab.id;
  if (tabId == null) return false;

  if (msg.type === 'rv-archive') return responde(guardaSessao(msg.sess).then(() => true), send);
  if (msg.type === 'rv-shot') return responde(fotografa(msg, sender), send);
  if (msg.type === 'rv-focus-take') return responde(entregaFoco(msg.url, sender), send);
  if (msg.type === 'rv-next') return responde(proximo(msg.sessionId, msg.afterId, sender.tab), send);

  /* um iframe grande pede o painel: quem decide é o topo, que sabe o tamanho
     da própria janela e o endereço que aparece na barra */
  if (msg.type === 'rv-claim') {
    sendTo(tabId, { type: 'rv-claim', frameId: sender.frameId, w: msg.w, h: msg.h }, TOPO)
      .then((resp) => send(resp || { retry: true }), () => send({ retry: true }));
    return true;
  }
  /* o topo passou o painel para outro iframe: o dono anterior solta */
  if (msg.type === 'rv-revoke' && sender.frameId === 0) {
    sendTo(tabId, { type: 'rv-revoke' }, { frameId: msg.frameId }).catch(() => {});
    return false;
  }
  return false;
});
