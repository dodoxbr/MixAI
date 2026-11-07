/** Base determinística da consulta runtime. Não contém adaptador, execução ou autorização. */
export * from './contracts.js';
export { sources } from './sources.js';
export { capabilities } from './capabilities.js';
export { fundamentals } from './fundamentals.js';
export { procedures } from './procedures.js';
export { instruments } from './instruments.js';
export { diagnose } from './diagnose.js';
export { examples } from './examples.js';

export { KNOWLEDGE_VERSION, technicalModules, technicalModuleSchema, citations, modulesFor } from './technical-modules.js';
export { instrumentProfiles, interactions, voiceRole } from './band-context.js';
export * from './conversation-contracts.js';
export { diagnosticChecks, planDiagnosticConversation } from './conversation-plan.js';
