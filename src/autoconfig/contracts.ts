import { z } from "zod";
import { Envelope, Id, Observation, Scope, Text } from "../reference/values.js";
export const AutoState = z.enum([
  "draft",
  "needs_info",
  "proposed",
  "approved_for_lab",
  "simulated",
  "reviewed",
  "saved",
  "rejected",
  "expired",
  "failed",
]);
export const Suggestion = z
  .object({
    id: Id,
    operation: z.literal("level_delta"),
    channel: z.number().int().min(1).max(64).optional(),
    deltaDB: z
      .number()
      .finite()
      .min(-3)
      .max(3)
      .refine((n) => n !== 0)
      .optional(),
    rationale: Text,
    evidence: z
      .array(
        z
          .object({ kind: z.enum(["human_report", "theory"]), text: Text })
          .strict(),
      )
      .max(10),
  })
  .strict();
const suggestions = z
  .array(Suggestion)
  .min(1)
  .max(8)
  .superRefine((items, c) => {
    if (new Set(items.map((i) => i.id)).size !== items.length)
      c.addIssue({ code: "custom", message: "IDs repetidos." });
    const channels = items
      .filter((i) => i.channel !== undefined)
      .map((i) => i.channel);
    if (new Set(channels).size !== channels.length)
      c.addIssue({
        code: "custom",
        message: "Um teste por canal em cada plano.",
      });
  });
export const AutoQuestion = z
  .object({
    schemaVersion: z.literal(1),
    id: z.enum(["channel", "deltaDB", "observation", "connectivity", "limits"]),
    message: Text,
    required: z.literal(true),
    source: z.literal("server_validation"),
  })
  .strict();
export const AutoConfigProposal = z
  .object({ schemaVersion: z.literal(1), items: suggestions })
  .strict();
/** C produces suggestions only; the operator submits them through the authenticated draft API. */
export interface AutoConfigSuggestionSource {
  propose(input: {
    eventId?: string;
    scope: "PA" | "AUX1";
    report?: string;
  }): Promise<z.infer<typeof AutoConfigProposal>>;
}
const Approval = z
  .object({
    id: Id,
    operatorSessionId: Id,
    scope: z.literal("simulation_only"),
    digest: z.string().length(64),
    at: z.iso.datetime(),
    consumedAt: z.iso.datetime().optional(),
  })
  .strict();
export const SimulationResult = z
  .object({
    id: Id,
    origin: z.enum(["lab_simulation", "mock_simulation"]),
    before: z.number(),
    target: z.number(),
    after: z.number().optional(),
    outcome: z.enum(["passed", "mismatch", "timeout", "failed"]),
    verification: z.literal("virtual_values_only"),
    audioAnalysis: z.literal("not_performed"),
    undo: z
      .object({ at: z.iso.datetime(), operatorSessionId: Id })
      .strict()
      .optional(),
  })
  .strict();
export const AutoItem = z
  .object({
    spec: Suggestion,
    state: AutoState,
    questions: z.array(AutoQuestion).max(10),
    observation: Observation.optional(),
    target: z.number().finite().min(-100).max(10).optional(),
    digest: z.string().length(64).optional(),
    approval: Approval.optional(),
    result: SimulationResult.optional(),
    review: z
      .object({
        accepted: z.boolean(),
        assessment: Text,
        operatorSessionId: Id,
        at: z.iso.datetime(),
      })
      .strict()
      .optional(),
  })
  .strict();
const Context = z
  .object({
    mode: z.enum(["lab", "mock"]),
    serverId: Id,
    revision: z.number().int().nonnegative(),
    eventVersion: z.number().int().positive().optional(),
    origin: z.enum(["lab_simulation", "mock_simulation"]),
    realObservation: z.literal("unavailable"),
    acousticMeasurement: z.literal("unavailable"),
  })
  .strict();
export const AutoPlan = z
  .object({
    schemaVersion: z.literal(1),
    id: Id,
    title: Text,
    eventId: Id.optional(),
    parentReferenceId: Id.optional(),
    scope: Scope,
    version: z.number().int().positive(),
    serverId: Id,
    createdAt: z.iso.datetime(),
    expiresAt: z.iso.datetime(),
    state: AutoState,
    items: z.array(AutoItem).min(1).max(8),
    context: Context.optional(),
    running: z
      .object({ id: Id, itemId: Id, deadline: z.iso.datetime() })
      .strict()
      .optional(),
    referenceId: Id.optional(),
    receipts: z
      .array(
        z
          .object({
            id: Id,
            actor: Id,
            digest: z.string().length(64),
            version: z.number().int().positive(),
          })
          .strict(),
      )
      .max(100),
    history: z
      .array(
        z
          .object({
            version: z.number().int().positive(),
            at: z.iso.datetime(),
            actor: z.string().max(64),
            action: Text,
            note: Text.optional(),
            itemId: Id.optional(),
            items: z.array(AutoItem).max(8),
          })
          .strict(),
      )
      .max(100),
  })
  .strict();
export const AutoConfigView = AutoPlan.extend({
  interrupted: z.boolean(),
  stale: z.boolean(),
  simulationOnly: z.literal(true),
  availability: z
    .object({
      context: z.enum(["not_prepared", "known"]),
      realObservation: z.literal("unavailable"),
      acousticMeasurement: z.literal("unavailable"),
      reference: z.enum(["absent", "saved"]),
    })
    .strict(),
  virtualState: z.record(
    z.string(),
    z
      .object({
        value: z.number().nullable(),
        status: z.enum(["known", "unknown"]),
        origin: z.literal("isolated_simulation"),
        appliedToMixer: z.literal(false),
      })
      .strict(),
  ),
  counts: z.record(z.string(), z.number().int().nonnegative()),
  replayed: z.boolean().optional(),
  receiptVersion: z.number().int().positive().optional(),
});
export type AutoConfigReadModel = z.infer<typeof AutoConfigView>;
export type AutoConfigPlan = z.infer<typeof AutoPlan>;
export type AutoConfigItem = z.infer<typeof AutoItem>;
export const CreateAutoConfig = Envelope.extend({
  id: Id,
  title: Text,
  eventId: Id.optional(),
  parentReferenceId: Id.optional(),
  scope: Scope,
  items: suggestions,
}).strict();
const actionBase = {
  serverId: Id,
  requestId: Id,
  expectedVersion: z.number().int().positive(),
};
export const AutoAction = z.discriminatedUnion("action", [
  z
    .object({
      ...actionBase,
      action: z.literal("prepare"),
      confirmed: z.literal(true),
    })
    .strict(),
  z
    .object({ ...actionBase, action: z.literal("revise"), items: suggestions })
    .strict(),
  z
    .object({
      ...actionBase,
      action: z.literal("approve"),
      itemId: Id,
      digest: z.string().length(64),
      confirmed: z.literal(true),
      scope: z.literal("simulation_only"),
      expectedStateRevision: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      ...actionBase,
      action: z.literal("simulate"),
      itemId: Id,
      approvalId: Id,
      expectedStateRevision: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      ...actionBase,
      action: z.literal("review"),
      itemId: Id,
      accepted: z.boolean(),
      assessment: Text,
    })
    .strict(),
  z
    .object({
      ...actionBase,
      action: z.literal("undo"),
      itemId: Id,
      resultId: Id,
      confirmed: z.literal(true),
      expectedStateRevision: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({ ...actionBase, action: z.literal("cancel"), reason: Text })
    .strict(),
  z
    .object({
      ...actionBase,
      action: z.literal("save"),
      confirmed: z.literal(true),
      expectedStateRevision: z.number().int().nonnegative(),
    })
    .strict(),
]);
/** A virtual calculator, never a transport/mixer. No command, apply, recall or write callback. */
export interface AutoConfigSimulator {
  simulate(input: {
    planId: string;
    itemId: string;
    mode: "lab" | "mock";
    channel: number;
    destination: "PA" | "AUX1";
    before: number;
    target: number;
    signal: AbortSignal;
  }): Promise<{ after: number }>;
}
export const virtualSimulator: AutoConfigSimulator = {
  simulate: async (input) => ({ after: input.target }),
};
