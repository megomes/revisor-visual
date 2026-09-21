# Desenvolver o Revisor Visual

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

## Refazer os screenshots do README

`docs/demo.html` é uma página de exemplo que carrega o `content.js` solto, sem
extensão, e dirige a interface por script. O `?shot=1` deixa a caixa de comentário
aberta, o `?shot=2` deixa dois itens salvos no painel.

```bash
CH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
for s in 1 2; do "$CH" --headless --disable-gpu --hide-scrollbars \
  --allow-file-access-from-files --window-size=1600,760 \
  --force-device-scale-factor=2 --virtual-time-budget=16000 \
  --screenshot="docs/shot-$s.png" "file://$PWD/docs/demo.html?shot=$s"; done
mv docs/shot-1.png docs/comentario.png && mv docs/shot-2.png docs/painel.png
```

Funciona porque o `content.js` tem caminho para quando não há extensão. Ele cai
para `localStorage` e expõe `window.__rv.setActive()`.

O conteúdo da página sai borrado de propósito, por um `filter: blur(7px)` aplicado
só no `.wrap`. A interface da extensão vive fora dele, num host com shadow DOM, e
por isso continua nítida. Para capturar sem o blur, acrescente `&anon=0` na URL.
