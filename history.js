/* Revisor Visual: página do histórico. Lista as sessões guardadas, cada item
   com a foto de quando foi marcado, e deixa conferir item a item se o pedido
   ficou. "Ir até lá" abre a página do item e destaca o ponto. */
(() => {
  'use strict';
  const api = globalThis.chrome ?? globalThis.browser;
  const { buildExport, parseExport } = globalThis.RVShared;
  const DB = globalThis.RVDB;

  const $ = (s) => document.querySelector(s);
  let filtro = 'pendente';
  const abertas = new Set();
  let primeiraVez = true;
  const urls = [];   /* object URLs das fotos, soltos a cada redesenho */

  function el(tag, cls, txt) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (txt != null) e.textContent = txt;
    return e;
  }

  function quando(iso) {
    const d = new Date(iso);
    if (isNaN(d)) return '';
    const p = (x) => String(x).padStart(2, '0');
    const hoje = new Date();
    const dia = d.toDateString() === hoje.toDateString() ? 'Hoje' :
      p(d.getDate()) + '/' + p(d.getMonth() + 1) + (d.getFullYear() !== hoje.getFullYear() ? '/' + d.getFullYear() : '');
    return dia + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }
  function hora(iso) {
    const d = new Date(iso);
    return isNaN(d) ? '' : String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  }

  function aviso(msg) {
    const a = el('div', 'aviso', msg);
    document.body.appendChild(a);
    setTimeout(() => a.remove(), 2400);
  }

  function ask(msg) {
    return new Promise((resolve) => {
      let done = false;
      const cb = (r) => { if (done) return; done = true; void api.runtime.lastError; resolve(r || null); };
      try {
        const p = api.runtime.sendMessage(msg, cb);
        if (p && typeof p.then === 'function') p.then(cb, () => cb(null));
      } catch (_) { cb(null); }
    });
  }

  function lerEstado() {
    return new Promise((resolve) => {
      let done = false;
      const cb = (o) => { if (done) return; done = true; resolve((o && o.rv_state) || null); };
      try {
        const r = api.storage.local.get('rv_state', cb);
        if (r && typeof r.then === 'function') r.then(cb, () => cb(null));
      } catch (_) { cb(null); }
    });
  }

  /* as sessões guardadas, mais a que ainda está aberta no painel. A aberta é
     a mais nova: o que está no storage agora vale mais que o último arquivo */
  async function carrega() {
    const [sessoes, confs, fotos, estado] = await Promise.all([
      DB.all('sessoes'), DB.all('conferencia'), DB.keys('fotos'), lerEstado()
    ]);
    const porId = new Map(sessoes.map((s) => [s.id, s]));
    if (estado && estado.items && estado.items.length) {
      const id = estado.sessionId || 'aberta';
      const velha = porId.get(id);
      const agora = new Set(estado.items.map((i) => i.id));
      const enviados = new Set((estado.sends || []).flatMap((s) => s.ids));
      const ficam = velha ? velha.items.filter((i) => !agora.has(i.id) && enviados.has(i.id)) : [];
      porId.set(id, Object.assign({}, velha || {}, {
        id,
        start: (velha && velha.start) || estado.sessionStart || estado.items[0].createdAt,
        end: new Date().toISOString(),
        motivo: 'aberta',
        aberta: true,
        items: ficam.concat(estado.items),
        sends: estado.sends || []
      }));
    }
    const lista = Array.from(porId.values())
      .sort((a, b) => (b.aberta ? 1 : 0) - (a.aberta ? 1 : 0) || String(b.end).localeCompare(String(a.end)));
    return {
      sessoes: lista,
      confs: new Map(confs.map((c) => [c.id, c.st])),
      fotos: new Set(fotos),
      estado
    };
  }

  /* foto de item que não está em sessão nenhuma, nem na aberta, é de item
     apagado antes de ir para o histórico */
  async function limpaFotosSoltas(dados) {
    const vivos = new Set(dados.sessoes.flatMap((s) => s.items.map((i) => i.id)));
    for (const k of dados.fotos) if (!vivos.has(k)) await DB.del('fotos', k);
  }

  function contagem(items, confs) {
    let ok = 0, nao = 0;
    for (const i of items) { const st = confs.get(i.id); if (st === 'ok') ok++; else if (st === 'nao') nao++; }
    return { ok, nao, pend: items.length - ok - nao, total: items.length };
  }

  const MOTIVO = {
    aberta: 'aberta no painel', copiado: 'guardada ao copiar', limpo: 'guardada ao limpar',
    desligado: 'guardada ao desligar', importado: 'importada', conferida: 'conferida na página'
  };

  function passa(st) {
    if (filtro === 'todos') return true;
    if (filtro === 'pendente') return !st;
    return st === filtro;
  }

  async function marca(id, st, atual) {
    const novo = atual === st ? null : st;
    await ask({ type: 'rv-review', id, st: novo });
    desenha();
  }

  function cartao(s, it, dados, variasPaginas, enviadoEm) {
    const st = dados.confs.get(it.id) || null;
    const c = el('div', 'item' + (st ? ' ' + st : ''));

    const foto = el('div', 'foto');
    if (dados.fotos.has(it.id)) {
      DB.get('fotos', it.id).then((b) => {
        if (!b) return;
        const u = URL.createObjectURL(b);
        urls.push(u);
        const img = el('img');
        img.src = u;
        img.alt = 'Como estava o item ' + it.n;
        img.addEventListener('click', () => { $('#zoom img').src = u; $('#zoom').classList.add('on'); });
        foto.insertBefore(img, foto.firstChild);
      });
    } else {
      const sf = el('div', 'semfoto');
      sf.append(el('div', 'big', String(it.n)), el('div', null, s.motivo === 'importado' ? 'importado, sem foto' : 'sem foto'));
      foto.appendChild(sf);
    }
    foto.appendChild(el('div', 'num', String(it.n)));
    if (st) foto.appendChild(el('div', 'selo', st === 'ok' ? 'Ficou' : 'Não ficou'));

    const txt = el('div', 'txt');
    txt.appendChild(el('div', 'alvo', it.kind + ' ' + it.tagSig + (it.inside ? ' em ' + it.inside : '')));
    if (it.anchor) txt.appendChild(el('div', 'ancora', '"' + it.anchor + '"'));
    else if (it.nearby) txt.appendChild(el('div', 'ancora', 'perto de "' + it.nearby.text + '"'));
    txt.appendChild(el('div', 'pedido', it.comment));
    const meta = [];
    if (variasPaginas) meta.push(it.pageTitle);
    meta.push(enviadoEm ? 'enviado às ' + hora(enviadoEm) : 'ainda não enviado');
    txt.appendChild(el('div', 'meta', meta.join(' · ')));

    const pe = el('div', 'pe');
    const bSim = el('button', 'b sim' + (st === 'ok' ? ' on' : ''), 'Ficou');
    const bNao = el('button', 'b nao' + (st === 'nao' ? ' on' : ''), 'Não ficou');
    const bIr = el('button', 'b', 'Ir até lá');
    bSim.title = st === 'ok' ? 'Clique de novo para voltar a sem conferir' : 'O pedido foi aplicado';
    bNao.title = st === 'nao' ? 'Clique de novo para voltar a sem conferir' : 'O pedido não foi aplicado, ou ficou errado';
    bIr.title = 'Abre a página e destaca o ponto, com o pedido ao lado';
    bSim.addEventListener('click', () => marca(it.id, 'ok', st));
    bNao.addEventListener('click', () => marca(it.id, 'nao', st));
    bIr.addEventListener('click', () => vaiAte(s, it));
    pe.append(bSim, bNao, bIr);

    c.append(foto, txt, pe);
    return c;
  }

  /* a sessão aberta ainda não está no IndexedDB: guarda antes de ir, porque o
     fundo procura a sessão lá */
  async function vaiAte(s, it) {
    if (s.aberta) await DB.put('sessoes', Object.assign({}, s, { aberta: undefined, motivo: 'conferida' }));
    const r = await ask({ type: 'rv-goto', sessionId: s.id, itemId: it.id });
    if (!r || !r.ok) aviso('Não consegui abrir a página desse item.');
  }

  async function copiaNaoFicou(s, dados) {
    const itens = s.items.filter((i) => dados.confs.get(i.id) === 'nao');
    const txt = buildExport(itens);
    if (!txt) return;
    try { await navigator.clipboard.writeText(txt); aviso(itens.length + (itens.length === 1 ? ' item' : ' itens') + ' na área de transferência. Cole no Claude Code.'); }
    catch (_) { aviso('Não consegui copiar.'); }
  }

  async function apaga(s) {
    if (!confirm('Apagar a sessão de ' + quando(s.end) + ' com ' + s.items.length + ' itens? As fotos e a conferência vão junto.')) return;
    await DB.del('sessoes', s.id);
    for (const it of s.items) { await DB.del('conferencia', it.id); await DB.del('fotos', it.id); }
    desenha();
  }

  let desenhando = false, deNovo = false;
  async function desenha() {
    if (desenhando) { deNovo = true; return; }
    desenhando = true;
    try {
      const dados = await carrega();
      while (urls.length) URL.revokeObjectURL(urls.pop());
      const main = $('#lista');
      main.innerHTML = '';

      const todos = dados.sessoes.flatMap((s) => s.items);
      const t = contagem(todos, dados.confs);
      $('#resumo').textContent = dados.sessoes.length + (dados.sessoes.length === 1 ? ' sessão' : ' sessões') +
        ' · ' + t.total + ' itens · ' + t.ok + ' ficaram · ' + t.nao + ' não ficaram · ' + t.pend + ' sem conferir';
      const cont = { pendente: t.pend, nao: t.nao, ok: t.ok, todos: t.total };
      for (const b of document.querySelectorAll('#filtros button')) {
        b.classList.toggle('on', b.dataset.f === filtro);
        b.querySelector('.c').textContent = cont[b.dataset.f];
      }

      if (!dados.sessoes.length) {
        const v = el('div', 'vazio');
        v.innerHTML = 'Nenhuma sessão ainda.<br>A sessão entra aqui quando você usa <b>Copiar tudo</b>, <b>Limpar</b> ou desliga o modo.<br>' +
          'Para trazer rodadas antigas, use <b>Importar export</b> e cole o texto que foi para o Claude.';
        main.appendChild(v);
        return;
      }

      if (primeiraVez) {
        /* abre de saída as sessões que ainda têm o que conferir, até três */
        dados.sessoes.filter((s) => contagem(s.items, dados.confs).pend).slice(0, 3).forEach((s) => abertas.add(s.id));
        primeiraVez = false;
      }

      let algum = false;
      for (const s of dados.sessoes) {
        const itens = s.items.filter((i) => passa(dados.confs.get(i.id)));
        if (!itens.length && filtro !== 'todos') continue;
        algum = true;
        const n = contagem(s.items, dados.confs);
        const envio = new Map();
        for (const e of s.sends || []) for (const id of e.ids) if (!envio.has(id)) envio.set(id, e.at);
        const paginas = Array.from(new Set(s.items.map((i) => i.pageTitle)));

        const sec = el('section', 'sessao' + (abertas.has(s.id) ? ' aberta' : ''));
        const hd = el('header');
        const tit = el('div', 'titulo-s');
        const l1 = el('div', 'l1');
        l1.append(el('span', 'seta', '▶'), el('span', 'quando', quando(s.end)),
          el('span', 'tag' + (s.aberta ? ' vivo' : ''), MOTIVO[s.motivo] || s.motivo));
        tit.append(l1, el('div', 'pag', paginas.join(' · ')));

        const prog = el('div', 'progresso');
        const barra = el('div', 'barra');
        const o = el('div', 'o'); o.style.width = (100 * n.ok / n.total) + '%';
        const x = el('div', 'x'); x.style.width = (100 * n.nao / n.total) + '%';
        barra.append(o, x);
        const nums = el('div', 'nums');
        nums.innerHTML = '<b>' + n.ok + '</b> ficaram · <b>' + n.nao + '</b> não ficaram · <b>' + n.pend +
          '</b> sem conferir, de ' + n.total;
        prog.append(barra, nums);

        const acoes = el('div', 'acoes');
        const bConf = el('button', 'b pri', 'Conferir na página');
        bConf.title = 'Abre o primeiro item sem conferir. Na página, Ficou e Não ficou já levam ao próximo';
        bConf.disabled = !n.pend;
        bConf.addEventListener('click', (e) => {
          e.stopPropagation();
          const prim = s.items.find((i) => !dados.confs.get(i.id));
          if (prim) vaiAte(s, prim);
        });
        const bCop = el('button', 'b', 'Copiar os que não ficaram');
        bCop.title = 'Monta de novo o prompt, só com os itens marcados como Não ficou';
        bCop.disabled = !n.nao;
        bCop.addEventListener('click', (e) => { e.stopPropagation(); copiaNaoFicou(s, dados); });
        acoes.append(bConf, bCop);
        if (!s.aberta) {
          const bDel = el('button', 'b fino', 'Apagar');
          bDel.addEventListener('click', (e) => { e.stopPropagation(); apaga(s); });
          acoes.appendChild(bDel);
        }
        hd.append(tit, prog, acoes);
        hd.addEventListener('click', () => {
          if (abertas.has(s.id)) abertas.delete(s.id); else abertas.add(s.id);
          sec.classList.toggle('aberta');
        });

        const corpo = el('div', 'corpo');
        const grade = el('div', 'grade');
        if (!itens.length) corpo.appendChild(el('div', 'nums', 'Nada nesta sessão com esse filtro.'));
        for (const it of itens) grade.appendChild(cartao(s, it, dados, paginas.length > 1, envio.get(it.id)));
        corpo.appendChild(grade);
        sec.append(hd, corpo);
        main.appendChild(sec);
      }
      if (!algum) main.appendChild(el('div', 'vazio', 'Nada com esse filtro.'));
      limpaFotosSoltas(dados).catch(() => {});
    } finally {
      desenhando = false;
      if (deNovo) { deNovo = false; desenha(); }
    }
  }

  /* ------------------------------------------------------------------ */

  for (const b of document.querySelectorAll('#filtros button')) {
    b.addEventListener('click', () => { filtro = b.dataset.f; desenha(); });
  }
  $('#zoom').addEventListener('click', () => $('#zoom').classList.remove('on'));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') $('#zoom').classList.remove('on'); });

  $('#importar').addEventListener('click', () => { $('#msg').textContent = ''; $('#dlg').showModal(); $('#txt').focus(); });
  $('#cancela').addEventListener('click', () => $('#dlg').close());
  $('#vai').addEventListener('click', async () => {
    const sessoes = parseExport($('#txt').value);
    if (!sessoes.length) { $('#msg').textContent = 'Não achei nenhum export nesse texto.'; return; }
    let novas = 0, itens = 0;
    for (const s of sessoes) {
      if (!(await DB.get('sessoes', s.id))) novas++;
      await DB.put('sessoes', s);
      itens += s.items.length;
      abertas.add(s.id);
    }
    $('#msg').textContent = sessoes.length + (sessoes.length === 1 ? ' rodada lida' : ' rodadas lidas') +
      ', ' + itens + ' itens' + (novas < sessoes.length ? ' (' + (sessoes.length - novas) + ' já estavam aqui)' : '') + '.';
    $('#txt').value = '';
    desenha();
  });

  /* o fundo avisa quando uma sessão entra ou um item é conferido na página */
  let adiado = null;
  const agenda = () => { clearTimeout(adiado); adiado = setTimeout(desenha, 150); };
  api.runtime.onMessage.addListener((msg) => { if (msg && msg.type === 'rv-history-changed') agenda(); return false; });
  api.storage.onChanged.addListener((ch, area) => { if (area === 'local' && ch.rv_state) agenda(); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) agenda(); });

  /* o fundo importa as rodadas do historico-importar.md antes do primeiro desenho */
  ask({ type: 'rv-seed' }).then(desenha);
})();
