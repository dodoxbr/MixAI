import { sources } from '../../../../src/knowledge/sound-engineer/sources';
import { technicalModules } from '../../../../src/knowledge/sound-engineer/technical-modules';
import type { InstructionCatalog, Ui16Procedure } from './instructor-contract';

const manual = sources['ui16-manual'];
const limit = 'Fixture de navegação, não validada na interface/firmware da sua Ui16. O contrato técnico de C ainda não foi integrado. Não presume posição, cor ou existência de botões nesta versão.';
const caution = 'Treinamento de leitura no LAB: não altere a mesa. Avançar confirma apenas sua revisão, não a execução ou verificação de uma operação.';
const alternative = 'Pare nesta etapa. Confira modelo e versão da interface com o operador e abra a referência do manual. Não use um controle parecido por tentativa; volte quando o controle for confirmado.';
function fixture(id: string, title: string, control: string, purpose: string, module?: keyof typeof technicalModules): Ui16Procedure {
  const existing = module ? technicalModules[module] : undefined;
  return {
    id, title, purpose, version: 'fixture-1', scope: 'lab_instruction', validation: 'fixture', interfaceLimit: limit,
    preconditions: ['Sessão MixAI em LAB; estudo sem executar comandos.', 'Modelo Ui12/Ui16 e versão da interface conferidos pelo operador.', 'Não informar senhas, PINs ou dados da rede neste instrutor.'],
    origin: { title: manual.title, url: manual.url, version: manual.version, locator: existing?.references.find(r => r.source === 'ui16-manual')?.locator ?? 'Localizar o assunto no manual completo; seção e controle específicos pendentes do contrato C (#65).' },
    steps: [
      { id: `${id}-locate`, control, action: `Localize na referência o assunto “${title}” e compare o nome com a interface oficial da sua versão. Não clique em controles por semelhança.`, expected: 'Você consegue reconhecer o assunto e conferir o controle no manual; este desenho não confirma a tela da mesa.', alternative, caution, schematic: ['Manual / versão', control, 'Conferência humana'] },
      { id: `${id}-understand`, control, action: existing?.guidance ?? 'Leia as instruções do manual para esta tarefa com o operador. A sequência técnica ainda aguarda publicação por C; esta fixture não ensina uma alteração não verificada.', expected: existing?.limitation ?? 'Pré-condições e cuidados conferidos no manual. Nenhuma configuração, senha, nome ou snapshot foi alterado pelo MixAI.', alternative, caution, schematic: [control, 'Ler orientação', 'Sem execução'] },
      { id: `${id}-review`, control: 'Revisão do aprendizado', action: 'Revise o que encontrou e os cuidados. Se houver divergência, use “Não encontrei” e retorne à referência antes de concluir.', expected: 'Somente o progresso local do tutorial será concluído. Nenhuma operação na Ui16 é atestada.', alternative, caution, schematic: ['Conferir', 'Revisar', 'Concluir estudo'] },
    ],
  };
}
/** Temporary UI fixtures: no copied manual, secret defaults, numeric recipes or execution payloads. */
export const instructorFixtures: InstructionCatalog = { schemaVersion: 1, procedures: [
  fixture('connection', 'Conexão e segurança do hotspot', 'Conexão / hotspot — nome do controle a confirmar', 'Reconhecer a orientação de conexão e proteção da rede; nenhuma senha é solicitada ou modificada.'),
  fixture('channel-name', 'Nome e identificação de canais', 'Nome do canal — controle a confirmar', 'Conferir a entrada física e sua identificação; nome local MixAI não renomeia a mesa.'),
  fixture('eq', 'EDIT → EQ', 'EDIT → EQ (referência de navegação da tarefa)', 'Entender o acesso ao EQ, sem editar parâmetros.', 'eq_hpf'),
  fixture('hpf', 'HPF do canal', 'HPF no contexto de EQ', 'Entender a função do HPF e limites antes de qualquer operação.', 'eq_hpf'),
  fixture('gain', 'Ganho e PFL', 'GAIN / PFL (referências da tarefa)', 'Distinguir estágio de entrada e escuta de conferência; sem alvo universal.', 'gain'),
  fixture('aux1', 'AUX SENDS e retorno AUX1', 'AUX SENDS / AUX1', 'Diferenciar envio e destino. AUX1 é compartilhado no HA800: todos ouvem a mesma mix.', 'monitoring'),
  fixture('snapshots', 'Shows e Snapshots', 'Shows / Snapshots (referências da tarefa)', 'Reconhecer salvamento e conferência; não salvar nem carregar snapshots. Cena MixAI não é snapshot nativo.'),
] };
