/** Separate AutoConfig advisory boundary; deliberately not installed in A1/A2 or server routes. */
export * from './contracts.js';
export { TechnicalPlanner, answerPlannerQuestion, plannerFingerprint, normalizedPlannerInput } from './planner.js';
export { bandKnowledgeAdapter, plannerInputFromConsultation } from './kb-adapter.js';
export { createConfiguredPlanner, textProviderAdapter } from './provider-adapter.js';
export { autoConfigCases } from './fixtures.js';
