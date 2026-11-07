# MixAI — pacote de conhecimento inicial (07/11/2026)

## Importante: AKG P35 precisa de confirmação
Não foi encontrado um modelo oficial **AKG P35** nas fontes consultadas. Os candidatos AKG **P3 S** (cardioide) e **P5 S** (supercardioide) têm captações diferentes. Não use os dados desses modelos para comandar EQ, ganho ou definir rejeição de retorno antes de verificar a gravação na carcaça/embalagem e a configuração real da banda.

## Conteúdo
- `sources/catalog.json`: URLs oficiais, status de consulta e download.
- `microphone-models.json`: fichas de P3 S / P5 S e identificação P35 **pendente**.
- `diagnostic-cases.json`: 6 exemplos de roteiros técnicos condicionais, somente leitura.
- `download-fontes.ps1`: baixa PDFs acessíveis e salva um manifesto local (nenhum download automático de páginas HTML).
- `INTEGRACAO.md`: plano de integração no projeto, sem mudanças automáticas no GitHub.

O manual Soundcraft v3.0 pode ser baixado pela página oficial. Manuais completos são documentos dos fabricantes: conservar cópias para referência pessoal e incorporar ao aplicativo referências e conhecimento derivado, não republicar textos inteiros.

## Ollama posterior
Comece com dados determinísticos em JSON. Quando instalar Docker/Ollama, a LLM poderá redigir respostas com base em resultados recuperados, não substituir autorização server-side ou inventar medição.

## Limitações
Os PDFs não foram baixados neste ambiente (acesso à rede indisponível na máquina de arquivos); o script PowerShell foi preparado para executar no PC. A execução do script depende de acesso à internet e da disponibilidade dos endpoints do fabricante.
