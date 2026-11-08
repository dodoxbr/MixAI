import type { Principal } from "../server/auth.js";
import type { WireSnapshot } from "../core/state.js";
import { ReferenceError } from "../reference/schema.js";
import type { ReferenceStore } from "../reference/store.js";
import {
  CreateSoundcheck,
  SoundcheckAction,
  soundcheckPlan,
  type Soundcheck,
} from "./schema.js";
export interface SoundcheckReadPort {
  mode: string;
  serverId: string;
  active(p: Principal): boolean;
  snapshot(): WireSnapshot;
  channels(): { number: number; name: string }[];
}
/** Event workflow owns no mixer/controller/scene-load capability. Uses the existing atomic store. */
export class SoundcheckService {
  constructor(
    private store: ReferenceStore,
    private read: SoundcheckReadPort,
    private clock = Date.now,
  ) {}
  private guard(p: Principal) {
    if (this.read.mode !== "lab") throw new ReferenceError("MODE_MISMATCH");
    if (!this.read.active(p)) throw new ReferenceError("UNAUTHORIZED");
    if (p.role !== "operator") throw new ReferenceError("FORBIDDEN");
  }
  private now() {
    return new Date(this.clock()).toISOString();
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
  private view(event: Soundcheck) {
    return {
      ...event,
      interrupted:
        event.status !== "completed" && event.serverId !== this.read.serverId,
      pendingSteps: soundcheckPlan
        .filter(
          (s) =>
            !event.steps.some(
              (e) =>
                e.human.stepId === s.id &&
                ["verified", "not_applicable"].includes(e.human.status),
            ),
        )
        .map((s) => s.id),
    };
  }
  list(p: Principal) {
    this.guard(p);
    return {
      schemaVersion: 1,
      serverId: this.read.serverId,
      plan: soundcheckPlan,
      events: this.store.read().soundchecks.map((e) => this.view(e)),
    };
  }
  detail(p: Principal, id: string) {
    this.guard(p);
    const doc = this.store.read();
    const event = doc.soundchecks.find((e) => e.id === id);
    if (!event) throw new ReferenceError("NOT_FOUND");
    return {
      event: this.view(event),
      references: doc.references
        .filter((r) => r.eventId === id)
        .map((r) => ({
          id: r.id,
          version: r.version,
          scope: r.scope,
          eventName: r.eventName,
        })),
      requests: doc.requests
        .filter((r) => event.requestIds.includes(r.id))
        .map((r) => ({
          id: r.id,
          report: r.report,
          state: r.state,
          channel: r.channel,
          destination: r.destination,
          version: r.version,
        })),
    };
  }
  create(p: Principal, raw: unknown) {
    this.guard(p);
    const input = this.parse(CreateSoundcheck, raw);
    const doc = this.store.read();
    const previous = doc.soundchecks.find((e) => e.id === input.id);
    if (previous) {
      if (
        previous.name !== input.name ||
        previous.date !== input.date ||
        previous.operatorName !== input.operatorName ||
        previous.createdBy !== p.id
      )
        throw new ReferenceError("CONFLICT");
      return this.view(previous);
    }
    if (doc.soundchecks.length >= 50) throw new ReferenceError("CAPACITY");
    const now = this.now();
    const event: Soundcheck = {
      schemaVersion: 1,
      planVersion: 1,
      id: input.id,
      name: input.name,
      date: input.date,
      operatorName: input.operatorName,
      createdBy: p.id,
      createdAt: now,
      updatedAt: now,
      serverId: this.read.serverId,
      version: 1,
      status: "in_progress",
      channels: this.read.channels(),
      steps: [],
      requestIds: [],
      history: [
        { version: 1, at: now, operatorSessionId: p.id, action: "created" },
      ],
    };
    doc.soundchecks.push(event);
    this.store.commit(doc, doc.revision);
    return this.view(event);
  }
  update(p: Principal, id: string, raw: unknown) {
    this.guard(p);
    const input = this.parse(SoundcheckAction, raw);
    const doc = this.store.read();
    const event = doc.soundchecks.find((e) => e.id === id);
    if (!event) throw new ReferenceError("NOT_FOUND");
    if (event.version !== input.expectedVersion || event.status === "completed")
      throw new ReferenceError("CONFLICT");
    if (event.history.length >= 199 && input.action !== "complete")
      throw new ReferenceError("CAPACITY");
    if (event.history.length >= 200) throw new ReferenceError("CAPACITY");
    if (
      input.action !== "resume" &&
      (event.serverId !== this.read.serverId || event.status === "paused")
    )
      throw new ReferenceError("STALE_STATE");
    const now = this.now();
    const history: Soundcheck["history"][number] = {
      version: event.version + 1,
      at: now,
      operatorSessionId: p.id,
      action: input.action,
    };
    if (input.action === "step") {
      const snapshot = this.read.snapshot();
      if (snapshot.mode !== "lab") throw new ReferenceError("MODE_MISMATCH");
      const step = soundcheckPlan.find((s) => s.id === input.step.stepId)!;
      const values: Soundcheck["steps"][number]["observed"]["values"] = {};
      for (const channel of step.channels)
        for (const suffix of [
          "main.level",
          "main.mute",
          "aux.1.level",
          "aux.1.mute",
        ]) {
          const key = `ch.${channel}.${suffix}`;
          const value = snapshot.params[key];
          values[key] = {
            ...(!snapshot.available
              ? { status: "unavailable" as const }
              : (value?.value ?? { status: "unknown" as const })),
            revision: value?.revision ?? 0,
          };
        }
      const record: Soundcheck["steps"][number] = {
        human: input.step,
        recordedAt: now,
        operatorSessionId: p.id,
        observed: {
          source: "lab_simulation",
          realReading: "not_collected",
          serverId: this.read.serverId,
          stateRevision: snapshot.revision,
          available: snapshot.available,
          values,
        },
      };
      event.steps = event.steps.filter((s) => s.human.stepId !== step.id);
      event.steps.push(record);
      history.step = record;
    } else if (input.action === "pause") event.status = "paused";
    else if (input.action === "resume") {
      if (event.status !== "paused" && event.serverId === this.read.serverId)
        throw new ReferenceError("CONFLICT");
      event.status = "in_progress";
      event.serverId = this.read.serverId;
    } else if (input.action === "complete") {
      if (this.view(event).pendingSteps.length)
        throw new ReferenceError("CONFLICT");
      event.status = "completed";
    } else if (input.action === "link_reference") {
      const ref = doc.references.find(
        (r) => r.id === input.referenceId && r.eventId === event.id,
      );
      if (!ref) throw new ReferenceError("INVALID");
      event.reference = { id: ref.id, version: ref.version };
      history.referenceId = ref.id;
    } else if (input.action === "link_request") {
      if (!doc.requests.some((r) => r.id === input.requestId))
        throw new ReferenceError("INVALID");
      if (event.requestIds.includes(input.requestId))
        throw new ReferenceError("CONFLICT");
      if (event.requestIds.length >= 20) throw new ReferenceError("CAPACITY");
      event.requestIds.push(input.requestId);
      history.requestId = input.requestId;
    }
    event.version++;
    event.updatedAt = now;
    event.history.push(history);
    this.store.commit(doc, doc.revision);
    return this.view(event);
  }
}
