# Revisor Visual

Extensão de navegador para revisar uma página HTML clicando nela, e devolver ao
Claude Code um texto que diz exatamente onde mexer.

Você liga o modo, segura Alt e clica no elemento que está errado. A extensão
reconhece o que você selecionou: título, botão, ícone, imagem, célula de tabela
ou trecho de texto. Ela desenha o contorno em volta dele e abre uma caixa para
você escrever. No fim, "Copiar tudo" põe na área de transferência um texto
pronto para colar no Claude.

Funciona em arquivo local (`file://`), em servidor de desenvolvimento
(`localhost`) e em qualquer site. Serve para HTML estático e para página gerada
por React.

Escrito em 2026-09-18, contra Chrome no Manifest V3 e Firefox 115 ou mais novo.

## Instalar

Baixe na [página de Releases](../../releases/latest). O passo a passo dos dois
navegadores está na nota da própria versão.

No Firefox é um `.xpi` assinado pela Mozilla, que abre no navegador e instala. No
Chrome é um `.zip` que você descompacta e carrega pelo `chrome://extensions`,
porque a extensão não está na Chrome Web Store.

## Rodar direto deste repositório

Para mexer no código e ver o efeito sem publicar versão.

**Chrome**

1. Abra `chrome://extensions`.
2. Ligue o **Modo do desenvolvedor**, no canto superior direito.
3. Clique em **Carregar sem compactação** e escolha esta pasta.
4. Clique em **Detalhes** na extensão e ligue **Permitir acesso a URLs de
   arquivo**. É o passo que quase todo mundo esquece. Sem ele a extensão não roda
   em nada que você abra do disco, que é justamente o caso dos HTML que o Claude
   gera.

**Firefox**

Instalação permanente no Firefox exige extensão assinada, então aqui a via é
temporária e dura até fechar o navegador.

1. Rode `cp manifest.firefox.json manifest.json`. A única diferença entre os dois
   é como o navegador carrega o script de fundo.
2. Abra `about:debugging#/runtime/this-firefox`.
3. Clique em **Carregar extensão temporária** e escolha o `manifest.json`.
4. Desfaça com `git checkout manifest.json`, senão você commita o manifest do
   Firefox no lugar do Chrome.

No Firefox o acesso a `file://` já vem com a permissão de host, não há botão
separado para ligar.

## Publicar uma versão

```bash
git tag v1.0.3 && git push origin v1.0.3
```

O `.github/workflows/release.yml` grava a versão nos dois manifests, monta o
`.zip` do Chrome, manda a pasta do Firefox para a Mozilla assinar no canal
*unlisted*, e cria o Release com os dois arquivos e a nota de instalação.

A assinatura usa os secrets `AMO_JWT_ISSUER` e `AMO_JWT_SECRET`, gerados em
`addons.mozilla.org/developers/addon/api/key/`. O id do add-on é
`revisor-visual@matheuservilha.github.io` e não pode mudar. Trocar o id faz a
extensão virar outra para quem já instalou.

Disparar o workflow pela interface do GitHub, sem tag, só confere o build e não
assina nada.

## Como usar

| O que você faz | O que acontece |
| --- | --- |
| `Alt+Shift+R`, ou clique no ícone da barra | Liga e desliga o modo de revisão |
| Segurar **Alt** (Option no Mac) | Mostra o contorno do elemento sob o cursor |
| **Alt + clique** | Abre a caixa de comentário naquele elemento |
| Selecionar um trecho e **Alt + clique** | Marca só o trecho, não o parágrafo inteiro |
| **Seta para cima** e **para baixo**, com Alt | Sobe e desce na árvore: do `span` para o cartão inteiro |
| **Enter** na caixa | Salva. `Shift+Enter` quebra linha, `Esc` cancela |
| Clique no número laranja na página | Reabre o comentário para editar |
| **Esc** com o modo ligado | Desliga o modo |

O painel tem uma opção **clique simples anota**, para quando você estiver numa
passada longa e não precisar navegar pela página. O modificador também é
configurável ali, se Alt colidir com alguma coisa.

### A sessão atravessa páginas

Os comentários não morrem ao recarregar, ao clicar num link ou ao trocar de
arquivo. A sessão é uma só, e o painel mostra os itens agrupados por página: os
desta página em cima, os das outras embaixo. A numeração é corrida, então o item
7 é o item 7 em qualquer página.

Dá para revisar um documento de várias páginas numa tacada só e exportar tudo
junto. "Só esta página" existe para quando você quiser fatiar.

Depois que o Claude reescreve o arquivo e você recarrega, o marcador de um
comentário cujo elemento não existe mais fica cinza, e o item continua na lista.
Ele não some sem avisar.

## O que sai na área de transferência

```
# Revisão visual: 4 itens em 2 páginas
Gerado em 2026-09-18 14:09.

Cada item traz uma âncora, que é o texto como ele aparece na página e, em geral,
literalmente no arquivo fonte, mais um caminho CSS que confirma o alvo. Ache o
trecho pela âncora, confirme pelo caminho e aplique o pedido. Não altere nada
fora do que está listado.

## Página 1: AS-IS da Máquina de Localização
Arquivo: /Users/reasset/Documents/.../1 - AS-IS/AS-IS.html

### 1 · título <h2 class="sec-title"> em section#diagnostico
Âncora: "Cobertura por safra"
Caminho: section#diagnostico > h2.sec-title
Atenção: esse texto aparece 2 vezes na página. Desempate pelo caminho.
Pedido: o título não diz o efeito. Trocar por um que diga o que a seção prova.

### 2 · ícone <svg> em section#numeros
Âncora: nenhuma, o elemento não tem texto próprio.
Perto de: "Cobertura por safra" (título acima)
Caminho: section#numeros > svg
Pedido: verde sugere aprovado, mas o dado é só medido. Usar cinza.
```

**A âncora vem primeiro porque é o que o Claude sabe procurar.** Seletor CSS de
página React (`css-1x9f3k7`) não existe no código fonte, então sozinho não serve
de endereço. Texto literal serve, porque o Claude acha por busca no arquivo.

**O caminho existe para desempatar, não para endereçar.** A extensão sobe a
árvore até o caminho identificar o elemento sozinho, e confere o resultado
contra a página antes de exportar. Quando o mesmo texto aparece mais de uma vez,
entra a linha de "Atenção" dizendo isso na cara.

**Elemento sem texto ganha um ponto de referência.** Ícone, imagem sem `alt` e
bloco vazio não têm âncora. A extensão procura o rótulo curto mais próximo, que
é o elemento logo antes ou o título acima, e diz de qual dos dois se trata. Ela
não despeja o texto do bloco inteiro no lugar.

O arquivo aparece como caminho absoluto no disco quando a página é `file://`, que
é o caso mais comum aqui. Em `localhost` sai a URL, porque não dá para saber o
arquivo que gerou a página.

## Limites conhecidos

- **Não abre o arquivo nem edita nada.** Ela só descreve. Quem mexe é o Claude.
- **Não faz captura de tela.** Imagem custa muito token e, na prática, a âncora
  mais o caminho já bastam.
- **Em React de produção não há mapeamento para linha do fonte.** O `_debugSource`
  do React (o campo que guarda arquivo e linha de origem de cada componente) só
  existe em build de desenvolvimento. Ler esse campo exigiria rodar script no
  mesmo mundo de JavaScript da página, o que o Chrome permite e o Firefox ainda
  não. Fica para uma versão seguinte, se fizer falta.
- **Não roda dentro de `iframe`.** `all_frames` está desligado de propósito, para
  não duplicar painel.
- **Não roda em página interna do navegador** (`chrome://`, `about:`), nem na loja
  de extensões. É restrição do navegador, não da extensão.

## Arquivos

| Arquivo | O que é |
| --- | --- |
| `manifest.json` | Configuração, versão Chrome |
| `manifest.firefox.json` | A mesma coisa, com o script de fundo no formato do Firefox |
| `background.js` | Liga e desliga pelo ícone e pelo atalho, e mantém o contador no ícone |
| `content.js` | Tudo o mais: seleção, âncora, caminho, painel, export |
| `icons/` | Ícones gerados, nos tamanhos 16, 32, 48 e 128 |
| `.github/workflows/release.yml` | Monta os pacotes, assina o `.xpi` e publica o Release a cada tag |
| `.github/release-notes.md` | Esqueleto da nota do Release |
| `.github/release-chrome-manual.md` | O bloco do Chrome na nota, enquanto a extensão não está na loja |
| `.github/release-chrome-loja.md` | O bloco do Chrome na nota, se um dia estiver |

Para mudar a cor do contorno e do painel, a constante `ACCENT` no topo de
`content.js`. Para mudar o texto que abre o export, `PREAMBLE_BASE` no mesmo
arquivo. Para mudar o atalho, o bloco `commands` do manifesto, ou a própria tela
de atalhos do navegador (`chrome://extensions/shortcuts`).

O painel, o contorno e os marcadores vivem num Shadow DOM, que é uma árvore de
elementos separada da página, com a folha de estilo construída em memória. Por
isso o CSS da página revisada não alcança a interface, e a política de segurança
de conteúdo da página não bloqueia o estilo dela.
