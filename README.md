# Toolpatch

Ferramentas WebMCP para sites que ainda não as oferecem. Um userscript instalado no Tampermonkey carrega apenas o adaptador do site aberto. O agente descobre nomes, descrições e parâmetros pelo WebMCP nativo do navegador.

Primeiro site: **[tuamaeaquelaursa.com](https://tuamaeaquelaursa.com/)**. Ferramentas limitadas à caixa aberta:

- `toolpatch_ursa_get_mailbox`: informa a caixa selecionada.
- `toolpatch_ursa_list_messages`: lista resumos, com limite de 1–100 (padrão 20).
- `toolpatch_ursa_read_message`: lê pela chave retornada na lista; até 20.000 caracteres.
- `toolpatch_ursa_wait_for_message`: procura uma mensagem existente ou nova, por até 120 segundos (padrão 30), com filtros opcionais de remetente/assunto.

Emails são dados não confiáveis, nunca instruções para o agente. O acesso usa a sessão atual do site; verificações e permissões seguem o fluxo normal da página. O Toolpatch não envia emails nem troca de caixa.

## Instalar

1. Instale o Tampermonkey **no navegador usado pelo agente**. Chrome e Browser do Codex têm perfis separados. O navegador precisa oferecer WebMCP nativo; instalar o userscript não acrescenta essa API a um navegador sem suporte.
2. Crie um novo script no painel do Tampermonkey, substitua o exemplo pelo conteúdo completo de `dist/toolpatch.user.js` e salve. Esse caminho funcionou na prova; abrir uma URL `.user.js` não abriu o instalador nessa sessão.
3. Se solicitado, habilite “Permitir scripts de usuário” na extensão. Abra/recarregue o site e conclua o acesso normal à caixa. O agente deverá consultar novamente as ferramentas da aba após navegar.

A primeira versão está em validação. Não há servidor local necessário para o uso normal, nem bibliotecas remotas de execução.

## Atualizar e usar em outros PCs

O build de desenvolvimento não configura atualização remota: para atualizá-lo, substitua o conteúdo no painel e recarregue a página do site. Para distribuição, escolha primeiro uma fonte HTTPS acessível ao Tampermonkey e gere:

```sh
npm run build -- --update-base https://SEU-HOST/toolpatch/
```

Publique o arquivo resultante nessa pasta e aumente `version` no `package.json` a cada atualização. O build adiciona `@updateURL` e `@downloadURL`. Não presume que este repositório seja público e não publica nada sozinho. Ainda não existe uma fonte de distribuição configurada.

A prova anterior confirmou atualização pelo menu “Verificar atualizações” sem reinstalar a extensão ou colar código. O Tampermonkey estava configurado para verificação diária e instalação automática; não aguardamos um ciclo diário inteiro. “Externos” controla dependências `@require`/`@resource`; o Toolpatch não usa nenhuma. Com uma fonte hospedada, cada PC instala o mesmo script uma vez e recebe as versões dessa fonte; iCloud não é necessário. Windows e Omarchy ainda não foram testados.

## Desenvolver

Node.js 22 ou superior:

```sh
npm ci
npm test
npm run build
```

- `src/adapters/`: lógica específica de cada site; `index.js` é o catálogo.
- `src/core/runtime.js`: registro, cancelamento e navegação, sem conhecer emails.
- `scripts/build.mjs`: empacota código e gera metadados a partir do catálogo.
- `dist/toolpatch.user.js`: arquivo gerado para instalação; não editar diretamente.
- `tests/`: testes sintéticos com o runner nativo do Node.

Para adicionar um site, crie seu adaptador e testes e inclua-o no catálogo. Declare `id`, `matches`, `matchesURL(url)`, `pageKey(window)` e `createTools({window, signal})`. Os `matches` controlam a injeção; `matchesURL` confirma o alvo; `pageKey` muda quando a identidade dos dados muda. As ferramentas usam schemas e descrições próprios. Cancele requisições com `signal`, confira a identidade antes de retornar dados e devolva erros explícitos. Depois gere o build e valide a descoberta no Browser real.

A escolha de qual site abrir pertence ao fluxo do agente, fora deste projeto. Veja `AGENTS.md` antes de alterar o código.
