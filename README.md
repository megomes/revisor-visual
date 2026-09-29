# Revisor Visual

Extensão de navegador para revisar uma página HTML clicando nela, e devolver ao
Claude Code um texto que diz exatamente onde mexer.

Você liga o modo, segura Alt e clica no elemento que está errado. A extensão
reconhece o que você selecionou, desenha o contorno em volta dele e abre uma
caixa para você escrever.

![Caixa de comentário aberta sobre um título de uma página borrada, com o painel da extensão à direita](docs/comentario.png)

No fim, **Copiar tudo** põe na área de transferência um texto pronto para colar no
Claude. Os marcadores laranjas ficam na página e o painel lista os comentários.

![Página borrada com dois marcadores laranjas, e o painel da extensão listando os dois comentários](docs/painel.png)

Funciona em arquivo local (`file://`), em `localhost`, em qualquer site e em
Artefato do Claude. Serve para HTML estático e para página gerada por React.

## Instalar

Baixe na [página de Releases](../../releases/latest). O passo a passo dos dois
navegadores está na nota da própria versão.

No Firefox é um `.xpi` assinado pela Mozilla, que abre no navegador e instala. No
Chrome é um `.zip` que você descompacta e carrega pelo `chrome://extensions`,
porque a extensão não está na Chrome Web Store.

Para mexer no código, publicar versão nova ou entender os arquivos, veja o
[CONTRIBUTING.md](CONTRIBUTING.md).

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
| **Limpar**, duas vezes | Guarda a sessão no histórico e esvazia o painel |
| **Histórico**, no topo do painel | Troca a lista do painel pelas sessões anteriores, para conferir item a item |

O painel tem uma opção **clique simples anota**, para quando você estiver numa
passada longa e não precisar navegar pela página. O modificador também é
configurável ali, se Alt colidir com alguma coisa.

Os comentários não morrem ao recarregar, ao clicar num link ou ao trocar de
arquivo. A sessão é uma só, a numeração é corrida, e o painel mostra os itens
desta página em cima e os das outras embaixo. Depois que o Claude reescreve o
arquivo e você recarrega, o marcador de um comentário cujo elemento não existe
mais fica cinza, e o item continua na lista.

## Histórico e conferência

O histórico guarda cada sessão com uma foto de cada item, para você conferir
depois, item a item, se o Claude aplicou o pedido. Uma sessão é o que está no
painel entre um **Limpar** e o próximo.

A sessão vai para o histórico em três momentos: quando você copia, quando limpa e
quando desliga o modo. A sessão que ainda está no painel também aparece no
histórico, marcada como aberta. A foto é recortada da aba no momento em que você
salva o item, com o contorno laranja em volta do elemento.

O botão **Histórico**, no topo do painel, mostra as sessões no próprio painel,
em cima da página, sem trocar de aba. Cada sessão tem uma barra de quantos itens
já foram conferidos, e cada item tem **✓** para ficou e **✗** para não ficou.
Clicar num item desta página rola até ele. Clicar num item de outra página leva
esta aba até lá.

O elemento aparece destacado, e um cartão no canto inferior esquerdo mostra o
pedido e a foto de antes. **Ficou** e **Não ficou** registram e
já levam ao próximo item sem conferência. Se o elemento sumiu da página, o cartão
avisa. Se no mesmo lugar agora há outro texto, o cartão mostra o texto novo.

**Página inteira**, no painel do histórico, abre o histórico numa aba própria,
com as fotos grandes. Ali, **Copiar os que não ficaram** monta de novo o texto
para o Claude, só com os itens marcados como **Não ficou**. **Importar export** lê o texto que você já colou no
Claude antes, de uma cópia ou de várias em sequência, e cria uma sessão por cópia,
sem foto. Importar a mesma cópia duas vezes não duplica nada.

O histórico e as fotos ficam só neste navegador, no armazenamento da extensão, e
não saem dele.

## O que sai na área de transferência

```
# Revisão visual: 2 itens em 1 página
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
```

Três decisões de formato, que são o motivo de o texto funcionar:

- **A âncora vem primeiro**, porque é o que o Claude sabe procurar. Seletor CSS de
  página React (`css-1x9f3k7`) não existe no código fonte, então sozinho não serve
  de endereço. Texto literal serve.
- **O caminho desempata, não endereça.** A extensão sobe a árvore até o caminho
  identificar o elemento sozinho, e confere contra a página antes de exportar.
  Texto repetido ganha a linha de "Atenção".
- **Elemento sem texto ganha ponto de referência.** Ícone e imagem sem `alt` não
  têm âncora, então entra o rótulo curto mais próximo, dizendo qual dos dois é.

O arquivo aparece como caminho absoluto no disco quando a página é `file://`. Em
`localhost` sai a URL, porque não dá para saber o arquivo que gerou a página.

## Limites conhecidos

- **Não abre o arquivo nem edita nada.** Ela só descreve. Quem mexe é o Claude.
- **O texto para o Claude não leva imagem.** Imagem custa muito token e, na
  prática, a âncora mais o caminho já bastam. A foto de cada item serve só ao
  histórico.
- **A foto sai da parte visível da aba.** Elemento maior que a tela sai cortado, e
  o painel sai junto se estiver por cima do elemento.
- **Em React de produção não há mapeamento para linha do fonte.** O `_debugSource`
  do React só existe em build de desenvolvimento, e lê-lo exigiria rodar script no
  mesmo mundo de JavaScript da página, o que o Chrome permite e o Firefox ainda
  não.
- **Só revisa um frame por aba.** Quando um `iframe` cobre metade da janela ou
  mais, como no Artefato do Claude, a revisão acontece dentro dele e o resto da
  página fica de fora. Um `iframe` menor, como um vídeo no meio de um artigo, fica
  de fora, e a revisão é da página em volta.
- **Não roda em página interna do navegador** (`chrome://`, `about:`), nem na loja
  de extensões. É restrição do navegador, não da extensão.

Atualizado em 2026-09-29, contra Chrome no Manifest V3 e Firefox 115 ou mais novo.
