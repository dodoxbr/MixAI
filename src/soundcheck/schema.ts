import { z } from "zod";
import { Envelope, Id, Observation, Text } from "../reference/values.js";
/** Instructional plan only: no parameter target, executable command, or recall. */
export const soundcheckPlan = [
  {
    id: "session",
    title: "Sessão e conexão LAB",
    channels: [],
    instruction:
      "Confirmar operador, conexão e modo LAB. Leituras e medidores simulados não comprovam som real.",
  },
  {
    id: "mapping",
    title: "Mapeamento e equipamento",
    channels: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
    instruction:
      "Conferir cada fonte/cabo/equipamento com a pessoa. Registrar desconhecidos; não presumir firmware ou captação.",
  },
  {
    id: "gain",
    title: "Verificação de ganhos",
    channels: [],
    instruction:
      "Operador verifica captação e ganhos por escuta/instrumentação apropriada, sem alvo numérico universal. O LAB não mede nível de entrada nem altera gain/phantom.",
  },
  {
    id: "cavaco",
    title: "CH1 — Cavaco",
    channels: [1],
    instruction:
      "Confirmar fonte, cabo e relato do cavaco; registrar problemas e verificações humanas.",
  },
  {
    id: "guitar",
    title: "CH2 — Violão de seis cordas (P10)",
    channels: [2],
    instruction:
      "Confirmar violão de seis cordas, conexão P10 e equipamento. O nome configurado não comprova ligação física.",
  },
  {
    id: "lead",
    title: "CH3 — Fred, voz principal",
    channels: [3],
    instruction:
      "Conferir voz principal e inteligibilidade com Fred; não deduzir ganho ou prioridade de fader pelo papel musical.",
  },
  {
    id: "chorus",
    title: "CH4–7 — Vozes de apoio",
    channels: [4, 5, 6, 7],
    instruction:
      "Conferir Lucius, Leandro, Fernando e Laviquinho individualmente e o coro junto. Registrar cada verificação.",
  },
  {
    id: "surdo",
    title: "CH8 — Surdo",
    channels: [8],
    instruction:
      "Conferir fonte, posição e relato por escuta humana; sem inferir espectro do fader.",
  },
  {
    id: "pandeiro",
    title: "CH9 — Pandeiro",
    channels: [9],
    instruction:
      "Registrar captação, relato e verificações, sem aplicar EQ ou ganho.",
  },
  {
    id: "tanta",
    title: "CH10 — Tantã",
    channels: [10],
    instruction:
      "Conferir fonte e relato humano; registrar problemas sem ajuste automático.",
  },
  {
    id: "aux",
    title: "AUX1 compartilhado — HA800",
    channels: [],
    instruction:
      "Confirmar HA800 e ouvir os músicos: todos recebem o mesmo AUX1. Não existem mixes individuais por pessoa neste fluxo.",
  },
  {
    id: "balance",
    title: "Balanço conjunto",
    channels: [],
    instruction:
      "Ouvir trecho conjunto e registrar inteligibilidade/balanço. LAB não comprova acústica, VU real ou ausência de microfonia.",
  },
  {
    id: "snapshot",
    title: "Show/Snapshot — instrução manual",
    channels: [],
    instruction:
      "Em ensaio físico autorizado, salvar Show/Snapshot pela UI oficial é tarefa manual do operador. Neste LAB, registrar não aplicável se não realizado. Não cria snapshot nativo, não carrega cena e não faz recall.",
  },
] as const;
export const StepId = z.enum(soundcheckPlan.map((s) => s.id));
export const HumanStep = z
  .object({
    stepId: StepId,
    status: z.enum(["pending", "verified", "problem", "not_applicable"]),
    report: Text.optional(),
    observations: Text.optional(),
    problem: Text.optional(),
    checksPerformed: z.array(Text).max(10),
    equipment: z.enum(["unknown", "confirmed"]),
    humanConfirmed: z.boolean(),
  })
  .strict()
  .superRefine((v, c) => {
    if (["verified", "not_applicable"].includes(v.status) && !v.humanConfirmed)
      c.addIssue({
        code: "custom",
        message: "Confirmação humana obrigatória.",
      });
    if (v.status === "problem" && !v.problem)
      c.addIssue({ code: "custom", message: "Descreva o problema." });
    if (v.status === "not_applicable" && !v.observations)
      c.addIssue({ code: "custom", message: "Informe o motivo." });
  });
const Observed = z
  .object({
    source: z.literal("lab_simulation"),
    realReading: z.literal("not_collected"),
    serverId: z.string().max(64),
    stateRevision: z.number().int().nonnegative(),
    available: z.boolean(),
    values: z.record(z.string(), Observation),
  })
  .strict();
export const StepRecord = z
  .object({
    human: HumanStep,
    recordedAt: z.iso.datetime(),
    operatorSessionId: z.string().max(64),
    observed: Observed,
  })
  .strict();
const EventHistory = z
  .object({
    version: z.number().int().positive(),
    at: z.iso.datetime(),
    operatorSessionId: z.string().max(64),
    action: z.enum([
      "created",
      "step",
      "pause",
      "resume",
      "complete",
      "link_reference",
      "link_request",
    ]),
    step: StepRecord.optional(),
    referenceId: Id.optional(),
    requestId: Id.optional(),
  })
  .strict();
export const SoundcheckEvent = z
  .object({
    schemaVersion: z.literal(1),
    planVersion: z.literal(1),
    id: Id,
    name: Text,
    date: z.iso.date(),
    operatorName: Text,
    createdBy: z.string().max(64),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    serverId: z.string().max(64),
    version: z.number().int().positive(),
    status: z.enum(["in_progress", "paused", "completed"]),
    channels: z
      .array(
        z.object({ number: z.number().int().positive(), name: Text }).strict(),
      )
      .max(64),
    steps: z.array(StepRecord).max(13),
    reference: z
      .object({ id: Id, version: z.number().int().positive() })
      .strict()
      .optional(),
    requestIds: z.array(Id).max(20),
    history: z.array(EventHistory).min(1).max(200),
  })
  .strict();
export type Soundcheck = z.infer<typeof SoundcheckEvent>;
export const CreateSoundcheck = Envelope.extend({
  id: Id,
  name: Text,
  date: z.iso.date(),
  operatorName: Text,
}).strict();
const base = {
  serverId: z.string().min(1).max(64),
  expectedVersion: z.number().int().positive(),
};
export const SoundcheckAction = z.discriminatedUnion("action", [
  z.object({ ...base, action: z.literal("step"), step: HumanStep }).strict(),
  z
    .object({ ...base, action: z.enum(["pause", "resume", "complete"]) })
    .strict(),
  z
    .object({ ...base, action: z.literal("link_reference"), referenceId: Id })
    .strict(),
  z
    .object({ ...base, action: z.literal("link_request"), requestId: Id })
    .strict(),
]);
