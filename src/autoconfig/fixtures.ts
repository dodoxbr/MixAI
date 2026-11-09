import type { z } from "zod";
import type { Suggestion, AutoConfigProposal } from "./contracts.js";
/** Examples for B/C: suggestions are not commands or approval receipts. */
export const voiceReturnFixture = {
  id: "voice-return-example",
  operation: "level_delta",
  channel: 6,
  deltaDB: 1,
  rationale:
    "Teste virtual pequeno para revisão humana; não presume causa acústica.",
  evidence: [
    { kind: "human_report", text: "Minha voz está baixa no retorno." },
    {
      kind: "theory",
      text: "Relato não é medição. AUX1 é compartilhado por todos no HA800.",
    },
  ],
} satisfies z.input<typeof Suggestion>;
export const missingSourceFixture = {
  id: "missing-source-example",
  operation: "level_delta",
  rationale: "Confirmar canal e passo antes de propor qualquer teste.",
  evidence: [],
} satisfies z.input<typeof Suggestion>;

export const readyProposalFixture = {
  schemaVersion: 1,
  items: [voiceReturnFixture],
} satisfies z.input<typeof AutoConfigProposal>;
export const needsInformationFixture = {
  schemaVersion: 1,
  items: [missingSourceFixture],
} satisfies z.input<typeof AutoConfigProposal>;
