import { createHash, randomUUID } from "node:crypto";
import type { Principal } from "../server/auth.js";
import type { WireSnapshot } from "../core/state.js";
import type { SceneStore } from "../core/scene-store.js";
import type { DeviceProfile } from "../core/scene.js";
import type { ParamKey, ParamValue } from "../core/revisions.js";
import {
  ReferenceError,
  type Document,
  type Reference,
} from "../reference/schema.js";
import type { ReferenceStore } from "../reference/store.js";
import {
  AutoQuestion,
  AutoAction,
  CreateAutoConfig,
  virtualSimulator,
  type AutoConfigItem,
  type AutoConfigPlan,
  type AutoConfigReadModel,
  type AutoConfigSimulator,
} from "./contracts.js";
import { z } from "zod";
const closed = new Set(["saved", "rejected", "expired"]);
export interface AutoConfigReadPort {
  mode(): "lab" | "mock" | "real";
  serverId: string;
  active(p: Principal): boolean;
  snapshot(): WireSnapshot;
  channels(): { number: number; name: string }[];
  supports(key: string): boolean;
  device: DeviceProfile;
  scenes: Pick<SceneStore, "create">;
}
/** Pure virtual changes. The only writable capability is the local records/scene store. */
export class AutoConfigService {
  private stopped = false;
  stop() {
    this.stopped = true;
    for (const run of this.running.values())
      run.controller.abort("server_stopped");
    this.running.clear();
  }
  private running = new Map<
    string,
    { id: string; controller: AbortController }
  >();
  constructor(
    private store: ReferenceStore,
    private read: AutoConfigReadPort,
    private simulator: AutoConfigSimulator = virtualSimulator,
    private clock = Date.now,
    private timeoutMs = 1500,
  ) {
    if (timeoutMs < 1 || timeoutMs > 5000)
      throw new Error("AutoConfig timeout inválido.");
  }
  private guard(p: Principal) {
    if (this.stopped) throw new ReferenceError("DEPENDENCY_UNAVAILABLE");
    if (!["lab", "mock"].includes(this.read.mode()))
      throw new ReferenceError("MODE_MISMATCH");
    if (!this.read.active(p)) throw new ReferenceError("UNAUTHORIZED");
    if (p.role !== "operator") throw new ReferenceError("FORBIDDEN");
  }
  private now() {
    return new Date(this.clock()).toISOString();
  }
  private hash(value: unknown) {
    return createHash("sha256").update(JSON.stringify(value)).digest("hex");
  }
  private parse<T>(
    schema: { safeParse(v: unknown): { success: boolean; data?: T } },
    raw: unknown,
  ): T {
    const r = schema.safeParse(raw);
    if (!r.success) throw new ReferenceError("INVALID");
    if ((r.data as { serverId: string }).serverId !== this.read.serverId)
      throw new ReferenceError("SERVER_CHANGED");
    return r.data as T;
  }
  private history(
    plan: AutoConfigPlan,
    actor: string,
    action: string,
    itemId?: string,
    note?: string,
  ) {
    if (plan.history.length >= 100) throw new ReferenceError("CAPACITY");
    plan.version++;
    plan.history.push({
      version: plan.version,
      at: this.now(),
      actor,
      action,
      ...(note ? { note } : {}),
      ...(itemId ? { itemId } : {}),
      items: structuredClone(plan.items),
    });
  }
  private doc() {
    const doc = this.store.read();
    let changed = false;
    for (const p of doc.autoconfig) {
      if (!closed.has(p.state) && Date.parse(p.expiresAt) <= this.clock()) {
        p.state = "expired";
        p.running = undefined;
        for (const i of p.items)
          if (!["rejected", "saved"].includes(i.state)) i.state = "expired";
        this.history(p, "system", "expired");
        this.running.get(p.id)?.controller.abort("expired");
        changed = true;
      }
    }
    if (changed) this.store.commit(doc, doc.revision);
    return changed ? this.store.read() : doc;
  }
  private view(plan: AutoConfigPlan, doc: Document): AutoConfigReadModel {
    const current = this.snapshot();
    const stale =
      !!plan.context &&
      (plan.serverId !== this.read.serverId ||
        !current.available ||
        current.revision !== plan.context.revision ||
        current.mode !== plan.context.mode ||
        !!(
          plan.eventId &&
          doc.soundchecks.find((e) => e.id === plan.eventId)?.version !==
            plan.context.eventVersion
        ));
    return {
      ...plan,
      interrupted:
        plan.serverId !== this.read.serverId && !closed.has(plan.state),
      stale,
      simulationOnly: true,
      availability: {
        context: plan.context ? "known" : "not_prepared",
        realObservation: "unavailable",
        acousticMeasurement: "unavailable",
        reference: plan.referenceId ? "saved" : "absent",
      },
      virtualState: Object.fromEntries(
        plan.items
          .filter((i) => i.spec.channel !== undefined)
          .map((i) => {
            const before =
              typeof i.observation?.value === "number"
                ? i.observation.value
                : null;
            const active =
              !["rejected", "expired", "failed"].includes(plan.state) &&
              i.result?.outcome === "passed" &&
              !i.result.undo &&
              ["simulated", "reviewed", "saved"].includes(i.state);
            return [
              this.key(plan, i),
              {
                value: active ? i.result!.after! : before,
                status: before === null ? "unknown" : "known",
                origin: "isolated_simulation",
                appliedToMixer: false,
              },
            ];
          }),
      ),
      counts: Object.fromEntries(
        ["proposed", "approved_for_lab", "simulated", "reviewed", "failed"].map(
          (s) => [s, plan.items.filter((i) => i.state === s).length],
        ),
      ),
    };
  }
  list(p: Principal) {
    this.guard(p);
    const doc = this.doc();
    return {
      schemaVersion: 1,
      serverId: this.read.serverId,
      mode: this.read.mode(),
      capabilities: {
        operations: ["level_delta"],
        maxStepDB: 3,
        scopes: ["PA", "AUX1"],
        execution: "virtual_only",
        realWrite: false,
      },
      channels: this.read.channels(),
      plans: doc.autoconfig.map((v) => this.view(v, doc)),
    };
  }
  detail(p: Principal, id: string) {
    this.guard(p);
    const doc = this.doc(),
      plan = doc.autoconfig.find((v) => v.id === id);
    if (!plan) throw new ReferenceError("NOT_FOUND");
    return {
      plan: this.view(plan, doc),
      reference: plan.referenceId
        ? doc.references.find((r) => r.id === plan.referenceId)
        : null,
    };
  }
  create(p: Principal, raw: unknown) {
    this.guard(p);
    const input = this.parse(CreateAutoConfig, raw),
      doc = this.doc();
    const existing = doc.autoconfig.find((v) => v.id === input.id);
    if (existing) {
      if (
        existing.history[0]?.actor !== p.id ||
        this.hash(existing.history[0].items.map((i) => i.spec)) !==
          this.hash(input.items) ||
        existing.title !== input.title ||
        existing.scope !== input.scope ||
        existing.eventId !== input.eventId ||
        existing.parentReferenceId !== input.parentReferenceId
      )
        throw new ReferenceError("CONFLICT");
      return this.view(existing, doc);
    }
    if (doc.autoconfig.length >= 50) throw new ReferenceError("CAPACITY");
    if (input.eventId && !doc.soundchecks.some((e) => e.id === input.eventId))
      throw new ReferenceError("INVALID");
    if (
      input.parentReferenceId &&
      !doc.references.some(
        (r) =>
          r.id === input.parentReferenceId &&
          r.scope === input.scope &&
          r.source.mode === this.read.mode() &&
          JSON.stringify(r.deviceProfile) ===
            JSON.stringify(this.read.device) &&
          (!input.eventId || r.eventId === input.eventId),
      )
    )
      throw new ReferenceError("INVALID");
    const plan: AutoConfigPlan = {
      schemaVersion: 1,
      id: input.id,
      title: input.title,
      eventId: input.eventId,
      parentReferenceId: input.parentReferenceId,
      scope: input.scope,
      version: 1,
      serverId: this.read.serverId,
      createdAt: this.now(),
      expiresAt: new Date(this.clock() + 600000).toISOString(),
      state: "draft",
      items: input.items.map((spec) => ({
        spec,
        state: "draft",
        questions: [],
      })),
      history: [],
      receipts: [],
    };
    plan.history.push({
      version: 1,
      at: this.now(),
      actor: p.id,
      action: "created",
      items: structuredClone(plan.items),
    });
    doc.autoconfig.push(plan);
    this.store.commit(doc, doc.revision);
    return this.view(plan, doc);
  }
  private key(plan: AutoConfigPlan, i: AutoConfigItem) {
    return `ch.${i.spec.channel}.${plan!.scope === "PA" ? "main" : "aux.1"}.level`;
  }
  private snapshot() {
    const s = this.read.snapshot();
    if (s.mode !== this.read.mode() || !["lab", "mock"].includes(s.mode))
      throw new ReferenceError("MODE_MISMATCH");
    return s;
  }
  private current(plan: AutoConfigPlan, expected?: number) {
    if (!plan.context || plan.serverId !== this.read.serverId)
      throw new ReferenceError("SERVER_CHANGED");
    const s = this.snapshot();
    if (
      !s.available ||
      s.revision !== plan.context.revision ||
      (expected !== undefined && expected !== s.revision)
    )
      throw new ReferenceError("STALE_STATE");
    if (
      plan.eventId &&
      this.store.read().soundchecks.find((e) => e.id === plan!.eventId)
        ?.version !== plan.context.eventVersion
    )
      throw new ReferenceError("STALE_STATE");
    for (const i of plan.items)
      if (
        i.approval &&
        !["rejected", "failed"].includes(i.state) &&
        !this.read.active({
          id: i.approval.operatorSessionId,
          role: "operator",
          label: "operador",
        })
      )
        throw new ReferenceError("STALE_STATE");
    return s;
  }
  private checkedItem(plan: AutoConfigPlan, item: AutoConfigItem) {
    const before =
      item.observation?.status === "known" ? item.observation.value : undefined;
    if (
      typeof before !== "number" ||
      item.target === undefined ||
      item.spec.deltaDB === undefined ||
      Math.abs(item.target - before - item.spec.deltaDB) > 0.00001 ||
      this.hash({
        spec: item.spec,
        scope: plan.scope,
        context: plan.context,
        observation: item.observation,
        target: item.target,
      }) !== item.digest
    )
      throw new ReferenceError("CONFLICT");
  }
  private aggregate(plan: AutoConfigPlan) {
    const states = plan.items.map((i) => i.state);
    plan.state = states.includes("approved_for_lab")
      ? "approved_for_lab"
      : states.includes("simulated")
        ? "simulated"
        : states.every((s) => ["reviewed", "rejected", "failed"].includes(s)) &&
            states.includes("reviewed")
          ? "reviewed"
          : states.includes("proposed")
            ? "proposed"
            : states.includes("needs_info")
              ? "needs_info"
              : states.every((s) => s === "rejected")
                ? "rejected"
                : states.every((s) => ["failed", "rejected"].includes(s))
                  ? "failed"
                  : "draft";
  }
  async action(p: Principal, id: string, raw: unknown) {
    this.guard(p);
    const input = this.parse(AutoAction, raw);
    let doc = this.doc();
    let plan = doc.autoconfig.find((v) => v.id === id);
    if (!plan) throw new ReferenceError("NOT_FOUND");
    const digest = this.hash(input),
      receipt = plan.receipts.find(
        (r) => r.id === input.requestId && r.actor === p.id,
      );
    if (receipt) {
      if (receipt.digest !== digest) throw new ReferenceError("CONFLICT");
      return {
        ...this.view(plan, doc),
        replayed: true,
        receiptVersion: receipt.version,
      };
    }
    if (plan.version !== input.expectedVersion || closed.has(plan.state))
      throw new ReferenceError("CONFLICT");
    if (
      (plan.history.length >= 97 || plan.receipts.length >= 99) &&
      input.action !== "cancel"
    )
      throw new ReferenceError("CAPACITY");
    if (
      plan.running &&
      input.action !== "cancel" &&
      !(input.action === "prepare" && plan.serverId !== this.read.serverId)
    )
      throw new ReferenceError("CONFLICT");
    if (
      !["prepare", "cancel"].includes(input.action) &&
      plan.serverId !== this.read.serverId
    )
      throw new ReferenceError("SERVER_CHANGED");
    const item =
      "itemId" in input
        ? plan.items.find((i) => i.spec.id === input.itemId)
        : undefined;
    if ("itemId" in input && !item) throw new ReferenceError("NOT_FOUND");
    if (input.action === "cancel") {
      plan.state = "rejected";
      plan.running = undefined;
      for (const i of plan.items)
        if (!["reviewed", "saved"].includes(i.state)) i.state = "rejected";
      this.running.get(id)?.controller.abort("cancelled");
    } else if (input.action === "revise") {
      if (plan.items.some((i) => i.approval || i.result))
        throw new ReferenceError("CONFLICT");
      plan.items = input.items.map((spec) => ({
        spec,
        state: "draft",
        questions: [],
      }));
      plan.context = undefined;
      plan.state = "draft";
    } else if (input.action === "prepare") {
      if (plan.eventId && !doc.soundchecks.some((e) => e.id === plan!.eventId))
        throw new ReferenceError("NOT_FOUND");
      const snapshot = this.snapshot(),
        mode = snapshot.mode as "lab" | "mock";
      plan.serverId = this.read.serverId;
      plan.running = undefined;
      plan.context = {
        mode,
        serverId: this.read.serverId,
        revision: snapshot.revision,
        ...(plan.eventId
          ? {
              eventVersion: doc.soundchecks.find((e) => e.id === plan!.eventId)
                ?.version,
            }
          : {}),
        origin: mode === "lab" ? "lab_simulation" : "mock_simulation",
        realObservation: "unavailable",
        acousticMeasurement: "unavailable",
      };
      plan.items = plan.items.map(({ spec }) => {
        const key = `ch.${spec.channel}.${plan!.scope === "PA" ? "main" : "aux.1"}.level`,
          state = snapshot.params[key];
        const questions: z.infer<typeof AutoQuestion>[] = [];
        const ask = (id: z.infer<typeof AutoQuestion>["id"], message: string) =>
          questions.push({
            schemaVersion: 1,
            id,
            message,
            required: true,
            source: "server_validation",
          });
        if (spec.channel === undefined) ask("channel", "Confirme o canal.");
        else if (
          !this.read.channels().some((c) => c.number === spec.channel) ||
          !this.read.supports(key)
        )
          ask("channel", "Canal/parâmetro indisponível.");
        if (spec.deltaDB === undefined)
          ask("deltaDB", "Informe o passo pequeno para simular.");
        if (!snapshot.available)
          ask(
            "connectivity",
            "Conexão indisponível: nenhuma simulação autorizada.",
          );
        const value = state?.value;
        const before =
          value?.status === "known" &&
          typeof value.value === "number" &&
          Number.isFinite(value.value)
            ? value.value
            : undefined;
        if (before === undefined)
          ask(
            "observation",
            "Valor inicial desconhecido ou não numérico; não presumir nível.",
          );
        const target =
          before !== undefined && spec.deltaDB !== undefined
            ? before + spec.deltaDB
            : undefined;
        if (target !== undefined && (target < -100 || target > 10))
          ask("limits", "Alvo fora do intervalo conservador.");
        const observation = {
          ...(!snapshot.available
            ? { status: "unavailable" as const }
            : (value ?? { status: "unknown" as const })),
          revision: state?.revision ?? 0,
        };
        return {
          spec,
          state: questions.length
            ? ("needs_info" as const)
            : ("proposed" as const),
          questions,
          observation,
          ...(target !== undefined && target >= -100 && target <= 10
            ? { target }
            : {}),
          digest: this.hash({
            spec,
            scope: plan!.scope,
            context: plan!.context,
            observation,
            target,
          }),
        };
      });
      plan.state = plan.items.some((i) => i.questions.length)
        ? "needs_info"
        : "proposed";
    } else if (input.action === "approve") {
      this.current(plan, input.expectedStateRevision);
      if (item) this.checkedItem(plan, item);
      if (
        item!.state !== "proposed" ||
        plan.items.some((i) => i.questions.length) ||
        item!.digest !== input.digest
      )
        throw new ReferenceError("CONFLICT");
      item!.approval = {
        id: randomUUID(),
        operatorSessionId: p.id,
        scope: "simulation_only",
        digest: input.digest,
        at: this.now(),
      };
      item!.state = "approved_for_lab";
      this.aggregate(plan);
    } else if (input.action === "simulate") {
      this.current(plan, input.expectedStateRevision);
      if (item) this.checkedItem(plan, item);
      if (
        item!.state !== "approved_for_lab" ||
        !item!.approval ||
        item!.approval.id !== input.approvalId ||
        item!.approval.operatorSessionId !== p.id ||
        item!.approval.consumedAt ||
        item!.approval.digest !== item!.digest
      )
        throw new ReferenceError("FORBIDDEN");
      const runId = randomUUID(),
        controller = new AbortController(),
        before = item!.observation!.value as number,
        target = item!.target!;
      item!.approval.consumedAt = this.now();
      plan.running = {
        id: runId,
        itemId: item!.spec.id,
        deadline: new Date(this.clock() + this.timeoutMs).toISOString(),
      };
      this.history(plan, p.id, "simulation_started", item!.spec.id);
      this.store.commit(doc, doc.revision);
      this.running.set(id, { id: runId, controller });
      let timer: ReturnType<typeof setTimeout> | undefined;
      let onAbort: () => void = () => {};
      let after: number | undefined,
        outcome: "passed" | "mismatch" | "timeout" | "failed" = "failed";
      try {
        const result = await Promise.race([
          Promise.resolve().then(() =>
            this.simulator.simulate({
              planId: id,
              itemId: item!.spec.id,
              mode: plan!.context!.mode,
              channel: item!.spec.channel!,
              destination: plan!.scope,
              before,
              target,
              signal: controller.signal,
            }),
          ),
          new Promise<never>((_, reject) => {
            onAbort = () =>
              reject(
                new Error(String(controller.signal.reason ?? "cancelled")),
              );
            controller.signal.addEventListener("abort", onAbort, {
              once: true,
            });
            timer = setTimeout(
              () => controller.abort("timeout"),
              this.timeoutMs,
            );
          }),
        ]);
        const parsed = z
          .object({ after: z.number().finite().min(-100).max(10) })
          .strict()
          .safeParse(result);
        if (parsed.success) {
          after = parsed.data.after;
          outcome = Math.abs(after - target) < 0.0001 ? "passed" : "mismatch";
        }
        if (this.clock() > Date.parse(plan.running!.deadline))
          outcome = "timeout";
      } catch {
        outcome = controller.signal.reason === "timeout" ? "timeout" : "failed";
      } finally {
        if (timer) clearTimeout(timer);
        controller.signal.removeEventListener("abort", onAbort);
        if (this.running.get(id)?.id === runId) this.running.delete(id);
      }
      if (this.stopped) throw new ReferenceError("CONFLICT");
      doc = this.doc();
      plan = doc.autoconfig.find((v) => v.id === id)!;
      if (plan.running?.id !== runId) throw new ReferenceError("CONFLICT");
      const latest = plan.items.find((i) => i.spec.id === input.itemId)!;
      let denied: ReferenceError | undefined;
      try {
        this.guard(p);
        this.current(plan, input.expectedStateRevision);
      } catch (error) {
        denied =
          error instanceof ReferenceError
            ? error
            : new ReferenceError("INVALID");
        outcome = "failed";
      }
      plan.running = undefined;
      latest.result = {
        id: runId,
        origin: plan.context!.origin,
        before,
        target,
        ...(after !== undefined ? { after } : {}),
        outcome,
        verification: "virtual_values_only",
        audioAnalysis: "not_performed",
      };
      latest.state = outcome === "passed" ? "simulated" : "failed";
      this.aggregate(plan);
      this.history(
        plan,
        denied ? "system" : p.id,
        "simulation_finished",
        latest.spec.id,
      );
      plan.receipts.push({
        id: input.requestId,
        actor: p.id,
        digest,
        version: plan.version,
      });
      this.store.commit(doc, doc.revision);
      if (denied) throw denied;
      return this.view(plan, doc);
    } else if (input.action === "review") {
      this.current(plan);
      if (item) this.checkedItem(plan, item);
      if (
        item!.state !== "simulated" ||
        item!.approval?.operatorSessionId !== p.id ||
        item!.result?.outcome !== "passed" ||
        item!.result.undo
      )
        throw new ReferenceError("CONFLICT");
      item!.review = {
        accepted: input.accepted,
        assessment: input.assessment,
        operatorSessionId: p.id,
        at: this.now(),
      };
      item!.state = input.accepted ? "reviewed" : "rejected";
      this.aggregate(plan);
    } else if (input.action === "undo") {
      this.current(plan, input.expectedStateRevision);
      if (item) this.checkedItem(plan, item);
      if (
        !item!.result ||
        item!.result.id !== input.resultId ||
        item!.result.outcome !== "passed" ||
        item!.result.undo ||
        item!.approval?.operatorSessionId !== p.id
      )
        throw new ReferenceError("CONFLICT");
      item!.result.undo = { at: this.now(), operatorSessionId: p.id };
      item!.state = "rejected";
      this.aggregate(plan);
    } else if (input.action === "save") {
      this.current(plan, input.expectedStateRevision);
      if (item) this.checkedItem(plan, item);
      if (
        plan.state !== "reviewed" ||
        !plan.items.some((i) => i.state === "reviewed") ||
        plan.items.some(
          (i) => !["reviewed", "rejected", "failed"].includes(i.state),
        )
      )
        throw new ReferenceError("CONFLICT");
      if (doc.references.length >= 100) throw new ReferenceError("CAPACITY");
      const reviewed = plan.items.filter(
        (i) =>
          i.state === "reviewed" &&
          i.result?.outcome === "passed" &&
          !i.result.undo,
      );
      if (!reviewed.length) throw new ReferenceError("CONFLICT");
      const values = new Map<ParamKey, ParamValue>();
      const observations: Reference["observations"] = {};
      for (const i of reviewed) {
        this.checkedItem(plan, i);
        values.set(this.key(plan, i) as ParamKey, i.result!.after!);
        observations[this.key(plan, i)] = {
          status: "known",
          value: i.result!.after!,
          revision: plan.context!.revision,
          actor: "autoconfig_simulated",
        };
      }
      const event = doc.soundchecks.find((e) => e.id === plan!.eventId);
      const eventId = plan.eventId ?? plan.id,
        version =
          Math.max(
            0,
            ...doc.references
              .filter((r) => r.eventId === eventId && r.scope === plan!.scope)
              .map((r) => r.version),
          ) + 1;
      const refId = randomUUID();
      const scene = this.read.scenes.create({
        name: `AutoConfig SIM ${plan.id.slice(0, 8)} v${version}`,
        description: "Referência virtual NÃO APLICADA. Sem validação acústica.",
        values,
        source: { mode: plan.context!.mode, app: "AutoConfig virtual" },
      });
      if (!scene.ok)
        throw new ReferenceError(
          scene.code === "CONFLICT" ? "CAPACITY" : "STORE_UNAVAILABLE",
        );
      const reference: Reference = {
        id: refId,
        eventId,
        eventName: event?.name ?? plan.title,
        eventDate: event?.date ?? plan.createdAt.slice(0, 10),
        version,
        scope: plan.scope,
        createdAt: this.now(),
        channels: this.read
          .channels()
          .filter((c) => reviewed.some((i) => i.spec.channel === c.number)),
        scene: scene.value,
        deviceProfile: this.read.device,
        source: {
          mode: plan.context!.mode,
          app: "MixAI",
          serverId: this.read.serverId,
          stateRevision: plan.context!.revision,
        },
        simulation: {
          planId: plan.id,
          mode: plan.context!.mode,
          notApplied: true,
        },
        validationStatus: "UNVERIFIED",
        operatorApprovedAt: this.now(),
        approvedBy: { sourceSessionId: p.id, role: "operator" },
        observations,
        history: [
          {
            version,
            at: this.now(),
            action: "virtual_reference_saved",
            role: "operator",
            sourceSessionId: p.id,
          },
        ],
      };
      doc.references.push(reference);
      plan.referenceId = refId;
      plan.state = "saved";
      for (const i of reviewed) i.state = "saved";
    }
    this.history(
      plan,
      p.id,
      input.action,
      item?.spec.id,
      input.action === "cancel" ? input.reason : undefined,
    );
    plan.receipts.push({
      id: input.requestId,
      actor: p.id,
      digest,
      version: plan.version,
    });
    this.store.commit(doc, doc.revision);
    return this.view(plan, doc);
  }
}
