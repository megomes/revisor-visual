/* Revisor Visual: o que a página revisada, o script de fundo e a página do
   histórico usam igual. Monta o texto do export, lê esse texto de volta e compara
   endereços. Pode ser injetado mais de uma vez na mesma página, por isso não
   declara nada no escopo global além de RVShared. */
globalThis.RVShared = globalThis.RVShared || (() => {
  'use strict';

  const PREAMBLE_BASE =
    'Cada item traz uma âncora, que é o texto como ele aparece na página e, em geral,\n' +
    'literalmente no arquivo fonte, mais um caminho CSS que confirma o alvo. Ache o\n' +
    'trecho pela âncora, confirme pelo caminho e aplique o pedido. Não altere nada\n' +
    'fora do que está listado.';
  const PREAMBLE_CTX =
    '\nNa linha Contexto, o que está entre « » é exatamente o trecho selecionado.';

  function stamp(d) {
    const p = (x) => String(x).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
      ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  /* o endereço que identifica a página: sem o fragmento, e no claude.ai também
     sem a query, que é a chave de compartilhamento e muda de um link para outro */
  function normUrl(url) {
    if (!url) return '';
    try {
      const u = new URL(url);
      u.hash = '';
      if (/(^|\.)claude\.ai$/.test(u.hostname)) u.search = '';
      return u.href;
    } catch (_) {
      const i = url.indexOf('#');
      return i === -1 ? url : url.slice(0, i);
    }
  }

  function sameUrl(a, b) { return normUrl(a) === normUrl(b); }

  function buildExport(items) {
    const list = items.filter((i) => (i.comment || '').trim());
    if (!list.length) return '';
    const groups = [];
    const byUrl = new Map();
    for (const it of list) {
      if (!byUrl.has(it.url)) { const g = { url: it.url, filePath: it.filePath, title: it.pageTitle, items: [] }; byUrl.set(it.url, g); groups.push(g); }
      byUrl.get(it.url).items.push(it);
    }
    const out = [];
    const plural = list.length === 1 ? 'item' : 'itens';
    const pg = groups.length === 1 ? 'página' : 'páginas';
    out.push('# Revisão visual: ' + list.length + ' ' + plural + ' em ' + groups.length + ' ' + pg);
    out.push('Gerado em ' + stamp(new Date()) + '.');
    out.push('');
    out.push(PREAMBLE_BASE + (list.some((i) => i.context) ? PREAMBLE_CTX : ''));
    out.push('');
    groups.forEach((g, gi) => {
      out.push('## Página ' + (gi + 1) + ': ' + g.title);
      if (g.filePath) out.push('Arquivo: ' + g.filePath);
      else if (/^https:\/\/claude\.ai\/(code\/)?artifact\//.test(g.url)) out.push('Artefato do Claude: ' + g.url);
      else out.push('URL: ' + g.url);
      out.push('');
      for (const it of g.items) {
        let head = '### ' + it.n + ' · ' + it.kind + ' ' + it.tagSig;
        if (it.inside) head += ' em ' + it.inside;
        out.push(head);
        if (it.anchor) {
          out.push('Âncora: "' + it.anchor + '"' +
            (it.anchorFrom !== 'texto' && it.anchorFrom !== 'seleção' ? '  (vem de ' + it.anchorFrom + ')' : ''));
        } else {
          out.push('Âncora: nenhuma, o elemento não tem texto próprio.');
          if (it.nearby) out.push('Perto de: "' + it.nearby.text + '" (' + it.nearby.como + ')');
        }
        if (it.context) out.push('Contexto: ' + it.context);
        if (it.path) out.push('Caminho: ' + it.path);
        if (it.occurrences > 1) out.push('Atenção: esse texto aparece ' + it.occurrences + ' vezes na página. Desempate pelo caminho.');
        out.push('Pedido: ' + it.comment.trim().replace(/\n/g, '\n  '));
        out.push('');
      }
    });
    return out.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
  }

  /* hash curto e estável, para que colar o mesmo export duas vezes dê os mesmos ids */
  function hash(s) {
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36);
  }

  /* lê de volta o texto que buildExport escreve. Aceita vários exports colados
     em sequência e devolve uma sessão por export */
  function parseExport(text) {
    const blocos = String(text || '').replace(/\r\n?/g, '\n').split(/^(?=# Revisão visual:)/m)
      .filter((b) => /^# Revisão visual:/.test(b));
    const sessoes = [];
    for (const bloco of blocos) {
      const g = bloco.match(/Gerado em (\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})/);
      const quando = g ? new Date(+g[1], +g[2] - 1, +g[3], +g[4], +g[5]) : new Date();
      const items = [];
      let pagina = null, it = null, noPedido = false;
      const fecha = () => { if (it) items.push(it); it = null; noPedido = false; };
      for (const linha of bloco.split('\n')) {
        let m;
        if ((m = linha.match(/^## Página \d+: (.*)$/))) {
          fecha();
          pagina = { title: m[1].trim(), url: '', filePath: null };
          continue;
        }
        if (!pagina) continue;
        if (!it) {
          if ((m = linha.match(/^Arquivo: (.+)$/))) {
            pagina.filePath = m[1].trim();
            const p = pagina.filePath.replace(/\\/g, '/');
            pagina.url = 'file://' + encodeURI(p.startsWith('/') ? p : '/' + p);
            continue;
          }
          if ((m = linha.match(/^(?:Artefato do Claude|URL): (.+)$/))) { pagina.url = m[1].trim(); continue; }
        }
        if ((m = linha.match(/^### (\d+) · (.*?) (<[^>]*>)(?: em (.+))?$/))) {
          fecha();
          it = {
            n: +m[1], kind: m[2], tagSig: m[3], inside: m[4] || null,
            url: pagina.url, filePath: pagina.filePath, pageTitle: pagina.title,
            anchor: '', anchorFrom: 'texto', nearby: null, context: null, path: '',
            occurrences: 1, comment: '', createdAt: quando.toISOString()
          };
          continue;
        }
        if (!it) continue;
        if (noPedido && linha.startsWith('  ')) { it.comment += '\n' + linha.slice(2); continue; }
        noPedido = false;
        if ((m = linha.match(/^Âncora: "(.*)"(?:  \(vem de (.+)\))?$/))) {
          it.anchor = m[1];
          it.anchorFrom = m[2] || (it.kind === 'trecho de texto' && !it.path ? 'seleção' : 'texto');
        } else if ((m = linha.match(/^Perto de: "(.*)" \((.*)\)$/))) {
          it.nearby = { text: m[1], como: m[2] };
        } else if ((m = linha.match(/^Contexto: (.*)$/))) {
          it.context = m[1];
          it.anchorFrom = 'seleção';
        } else if ((m = linha.match(/^Caminho: (.*)$/))) {
          it.path = m[1];
        } else if ((m = linha.match(/^Atenção: esse texto aparece (\d+) vezes/))) {
          it.occurrences = +m[1];
        } else if ((m = linha.match(/^Pedido: (.*)$/))) {
          it.comment = m[1];
          noPedido = true;
        }
      }
      fecha();
      if (!items.length) continue;
      const base = stamp(quando) + '|' + items.map((i) => i.url + '#' + i.n + ':' + i.comment).join('|');
      const sid = 'x' + hash(base);
      for (const i of items) i.id = sid + '-' + i.n + '-' + hash(i.comment);
      sessoes.push({
        id: sid,
        start: quando.toISOString(),
        end: quando.toISOString(),
        motivo: 'importado',
        items,
        sends: [{ at: quando.toISOString(), ids: items.map((i) => i.id), escopo: 'tudo' }]
      });
    }
    return sessoes;
  }

  return { stamp, normUrl, sameUrl, buildExport, parseExport };
})();
