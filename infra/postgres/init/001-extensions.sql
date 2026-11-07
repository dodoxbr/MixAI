-- Executado uma única vez, na criação do volume. As tabelas são criadas (idempotente) pelo
-- próprio MixAI ao iniciar, com a dimensão do modelo de embedding configurada.
CREATE EXTENSION IF NOT EXISTS vector;
