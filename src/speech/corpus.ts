/** Text only, no recordings or personal identities. References are never decoder prompts. */
export const SPEECH_CORPUS = [
  { id: 'cavaco-fones', reference: 'Aumenta o cavaco no meu fone.', category: 'short' },
  { id: 'voz', reference: 'Baixa a voz do vocalista.', category: 'short' },
  { id: 'surdo', reference: 'O surdo está muito alto.', category: 'observation' },
  { id: 'negacao', reference: 'Não altere nada.', category: 'negation' },
  { id: 'negacao-volume', reference: 'Não aumenta o volume do surdo.', category: 'negation' },
  { id: 'ambiguo', reference: 'Baixa um pouco.', category: 'ambiguous' },
  { id: 'destino', reference: 'Aumenta a voz no PA e no fone.', category: 'ambiguous' },
  { id: 'homofono', reference: 'A voz está alta, mas o baixo está baixo.', category: 'homophone' },
  { id: 'violao', reference: 'O violão está abafado no retorno.', category: 'instrument' },
  { id: 'pandeiro', reference: 'Baixa o pandeiro dois decibéis.', category: 'numbers' },
  { id: 'coloquial', reference: 'O cavaco tá muito alto no meu fone.', category: 'colloquial' },
  { id: 'silencio', reference: '', category: 'silence' },
  { id: 'ruido-sem-fala', reference: '', category: 'noise' },
] as const;
