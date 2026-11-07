/**
 * Base de conhecimento técnica local (RAG). Somente leitura de documentos: este módulo NÃO importa
 * mixer, controlador, fila nem autenticação. O que ele devolve é texto de apoio, nunca comando.
 */
export { openLocalKnowledge, inboxPath } from './open.js';
export { LocalKnowledge, KnowledgeError } from './service.js';
export type { KnowledgeContext, KnowledgeStatus, EnrichInput } from './service.js';
export { readPackFromDir, readPackFromZip, parsePack } from './pack.js';
export type { KnowledgePack, Assignment, CatalogEntry, MicModel } from './pack.js';
export { FileKnowledgeStore } from './store.js';
export type { KnowledgeStore, Passage } from './store.js';
export { PgKnowledgeStore } from './pg-store.js';
export { OllamaClient } from './ollama.js';
