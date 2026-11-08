import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { afterEach, expect, it, vi } from "vitest";
import { parseChannels, PROJECT_ROOT } from "../src/core/config.js";
import { soundcheckPlan } from "../src/soundcheck/schema.js";
import {
  startTestServer,
  OPERATOR_PIN,
  MUSICIAN_PIN,
} from "./server-support.js";
const servers: Awaited<ReturnType<typeof startTestServer>>[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const t of servers.splice(0)) await t.server.close();
});
async function setup(dir?: string, mode: "lab" | "mock" = "lab") {
  const t = await startTestServer({
    dir,
    mode,
    channels: parseChannels(
      parse(readFileSync(join(PROJECT_ROOT, "config/channels.yaml"), "utf8")),
    ),
  });
  servers.push(t);
  const op = await t.login(OPERATOR_PIN),
    music = await t.login(MUSICIAN_PIN),
    base = { serverId: t.server.core.serverId };
  const create = (extra: object = {}, token = op) =>
    t.http("/api/soundchecks", {
      token,
      body: {
        ...base,
        id: randomUUID(),
        name: "Roda LAB",
        date: "2026-11-08",
        operatorName: "Operador declarado",
        ...extra,
      },
    });
  const update = (
    e: Record<string, any>,
    action: string,
    extra: object = {},
    token = op,
  ) =>
    t.http("/api/soundchecks/" + e.id, {
      token,
      body: { ...base, expectedVersion: e.version, action, ...extra },
    });
  const step = (stepId: string, extra: object = {}) => ({
    stepId,
    status: "verified",
    equipment: "unknown",
    checksPerformed: ["Conferência humana registrada, sem medição"],
    humanConfirmed: true,
    ...extra,
  });
  return { t, op, music, base, create, update, step };
}
it("creates first/multiple events, uses correct instructional map, tracks problems, approvals and every revision without commands", async () => {
  const s = await setup();
  const write = vi.spyOn(s.t.mixer, "write"),
    execute = vi.spyOn(s.t.server.core, "execute");
  let e = (await s.create()).json;
  expect(e.pendingSteps).toHaveLength(13);
  expect(e.reference).toBeUndefined();
  expect((await s.create()).json.id).not.toBe(e.id);
  const list = (await s.t.http("/api/soundchecks", { token: s.op })).json;
  expect(list.plan.find((p: any) => p.id === "guitar").title).toContain(
    "seis cordas",
  );
  expect(list.plan.find((p: any) => p.id === "aux").instruction).toContain(
    "mesmo AUX1",
  );
  expect((await s.update(e, "complete")).status).toBe(409);
  expect(
    (
      await s.update(e, "step", {
        step: s.step("lead", { humanConfirmed: false }),
      })
    ).status,
  ).toBe(400);
  e = (
    await s.update(e, "step", {
      step: s.step("lead", {
        status: "problem",
        problem: "Relato de voz abafada",
        humanConfirmed: false,
      }),
    })
  ).json;
  expect(e.pendingSteps).toContain("lead");
  for (const p of soundcheckPlan) {
    e = (
      await s.update(e, "step", {
        step: s.step(
          p.id,
          p.id === "snapshot"
            ? {
                status: "not_applicable",
                observations: "LAB sem snapshot físico",
              }
            : {},
        ),
      })
    ).json;
  }
  e = (await s.update(e, "complete")).json;
  expect(e.status).toBe("completed");
  expect(e.pendingSteps).toEqual([]);
  expect(
    e.history.filter((h: any) => h.step?.human.stepId === "lead"),
  ).toHaveLength(2);
  expect(
    e.steps.every(
      (r: any) =>
        r.observed.source === "lab_simulation" &&
        r.observed.realReading === "not_collected",
    ),
  ).toBe(true);
  expect((await s.update(e, "step", { step: s.step("lead") })).status).toBe(
    409,
  );
  expect(write).not.toHaveBeenCalled();
  expect(execute).not.toHaveBeenCalled();
});
it("enforces two-operator CAS, session/mode permissions, strict inputs and revocation", async () => {
  const s = await setup();
  const op2 = await s.t.login(OPERATOR_PIN);
  const e = (await s.create()).json;
  expect((await s.t.http("/api/soundchecks")).status).toBe(401);
  expect((await s.create({}, s.music)).status).toBe(403);
  expect(
    (await s.t.http("/api/soundchecks/" + e.id, { token: s.music })).status,
  ).toBe(403);
  expect(
    (await s.update(e, "step", { step: s.step("lead") }, s.music)).status,
  ).toBe(403);
  const results = await Promise.all([
    s.update(e, "step", { step: s.step("lead") }),
    s.update(e, "step", { step: s.step("cavaco") }, op2),
  ]);
  expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
  const next = results.find((r) => r.status === 200)!.json;
  expect(
    (
      await s.update(next, "step", {
        step: s.step("lead"),
        command: { type: "set_level" },
      })
    ).status,
  ).toBe(400);
  expect(
    (await s.update(next, "pause", { serverId: "old-server" })).status,
  ).toBe(409);
  await s.t.http("/api/logout", { token: s.op, body: {} });
  expect((await s.t.http("/api/soundchecks", { token: s.op })).status).toBe(
    401,
  );
  const mock = await setup(undefined, "mock");
  expect(
    (await mock.t.http("/api/soundchecks", { token: mock.op })).status,
  ).toBe(404);
});
it("persists and resumes interrupted work after restart, pausing never loses steps or approval provenance", async () => {
  const s = await setup();
  let e = (await s.create()).json;
  e = (
    await s.update(e, "step", {
      step: s.step("lead", { observations: "Voz conferida no LAB" }),
    })
  ).json;
  await s.t.server.close();
  const again = await setup(s.t.dir);
  const detail = (
    await again.t.http("/api/soundchecks/" + e.id, { token: again.op })
  ).json;
  expect(detail.event.interrupted).toBe(true);
  expect(detail.event.steps[0].human.observations).toBe("Voz conferida no LAB");
  expect(
    (await again.update(e, "step", { step: again.step("cavaco") })).status,
  ).toBe(409);
  e = (await again.update(e, "resume")).json;
  expect(e.interrupted).toBe(false);
  e = (await again.update(e, "pause")).json;
  expect(e.status).toBe("paused");
  expect(
    (await again.update(e, "step", { step: again.step("cavaco") })).status,
  ).toBe(409);
  e = (await again.update(e, "resume")).json;
  expect(e.steps[0].operatorSessionId).not.toBe(
    again.t.server.core.auth.authenticate(again.op, "127.0.0.1")!.id,
  );
  expect(e.history.map((h: any) => h.action)).toEqual([
    "created",
    "step",
    "resume",
    "pause",
    "resume",
  ]);
});
it("reuses references/requests in the same store, labels unavailable state and preserves backups on corruption", async () => {
  const s = await setup();
  let e = (await s.create()).json;
  expect(
    (await s.update(e, "link_reference", { referenceId: randomUUID() })).status,
  ).toBe(400);
  const ref = (
    await s.t.http("/api/mix-references", {
      token: s.op,
      body: {
        ...s.base,
        eventId: e.id,
        eventName: e.name,
        eventDate: e.date,
        scope: "AUX1",
        expectedVersion: 0,
        expectedStateRevision: s.t.server.core.snapshotFor("operator").revision,
        operatorApproved: true,
      },
    })
  ).json;
  e = (await s.update(e, "link_reference", { referenceId: ref.id })).json;
  expect(e.reference).toEqual({ id: ref.id, version: 1 });
  const req = (
    await s.t.http("/api/mix-requests", {
      token: s.music,
      body: {
        ...s.base,
        requestId: randomUUID(),
        type: "mix_geral",
        report: "Retorno alto",
        destination: "AUX1",
      },
    })
  ).json;
  e = (await s.update(e, "link_request", { requestId: req.id })).json;
  expect(
    (await s.t.http("/api/soundchecks/" + e.id, { token: s.op })).json
      .requests[0].id,
  ).toBe(req.id);
  await s.t.mixer.disconnect();
  e = (
    await s.update(e, "step", {
      step: s.step("lead", { status: "pending", humanConfirmed: false }),
    })
  ).json;
  expect(e.steps[0].observed.available).toBe(false);
  expect(
    Object.values(e.steps[0].observed.values).every(
      (v: any) => v.status === "unavailable",
    ),
  ).toBe(true);
  const file = join(s.t.dir, "mix-reference-requests.json"),
    backup = readFileSync(file + ".bak", "utf8");
  writeFileSync(file, "{broken");
  expect((await s.t.http("/api/soundchecks", { token: s.op })).status).toBe(
    503,
  );
  expect(readFileSync(file + ".bak", "utf8")).toBe(backup);
});
