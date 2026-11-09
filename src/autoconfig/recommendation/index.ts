/** AutoConfig 2.0 — recomendações técnicas (protótipo offline). Deliberadamente NÃO instalado em rotas, serviço ou interface. */
export * from './contracts.js';
export { bandRecommendationKnowledge } from './kb-adapter.js';
export { type RecommendationKnowledge, type EqGuideView, RULES_VERSION, MODEL_SYSTEM, buildMenu, modelPrompt, parseModelText, recommend, draftFromAdjustment, DraftError, type Menu } from './engine.js';
