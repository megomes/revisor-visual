Ainda não está na Chrome Web Store. O `.zip` daqui **não instala com clique
duplo**, porque o Chrome recusa extensão vinda de fora da loja no Windows e no
macOS. O caminho é carregar a pasta.

1. Baixe **`revisor-visual-chrome-__VERSION__.zip`**, na seção **Assets** desta
   página, e descompacte numa pasta definitiva. O Chrome lê dessa pasta toda vez
   que abre, então ela não pode ser apagada nem movida depois.
2. Abra `chrome://extensions`.
3. Ligue **Modo do desenvolvedor**, no canto superior direito.
4. Clique em **Carregar sem compactação** e escolha a pasta que você descompactou.
5. Clique em **Detalhes**, na extensão, e ligue **Permitir acesso a URLs de
   arquivo**. É o passo que quase todo mundo esquece.

Sem o passo 5 a extensão não roda em HTML aberto do disco, que é o caso dos
arquivos que o Claude gera. Ela fica instalada e parece funcionar, mas não
aparece nada na página.
