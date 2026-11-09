import { AutoConfigView } from "../src/autoconfig/contracts.js";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { afterEach, expect, it, vi } from "vitest";
import { parseChannels, PROJECT_ROOT } from "../src/core/config.js";
import { AutoConfigService } from "../src/autoconfig/service.js";
import { ReferenceStore } from "../src/reference/store.js";
import {
  voiceReturnFixture,
  missingSourceFixture,
} from "../src/autoconfig/fixtures.js";
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
async function boot(opts: Parameters<typeof startTestServer>[0] = {}) {
  const t = await startTestServer({
    channels: parseChannels(
      parse(readFileSync(join(PROJECT_ROOT, "config/channels.yaml"), "utf8")),
    ),
    ...opts,
  });
  servers.push(t);
  const op = await t.login(OPERATOR_PIN),
    music = await t.login(MUSICIAN_PIN);
  const base = { serverId: t.server.core.serverId };
  const create = (extra: object = {}, token = op) =>
    t.http("/api/autoconfig", {
      token,
      body: {
        ...base,
        id: randomUUID(),
        title: "Plano virtual de retorno",
        scope: "AUX1",
        items: [voiceReturnFixture],
        ...extra,
      },
    });
  const action = (
    plan: Record<string, any>,
    action: string,
    extra: object = {},
    token = op,
  ) =>
    t.http(`/api/autoconfig/${plan.id}/actions`, {
      token,
      body: {
        ...base,
        requestId: randomUUID(),
        expectedVersion: plan.version,
        action,
        ...extra,
      },
    });
  const prepare = async (plan: Record<string, any>) => {
    const r = await action(plan, "prepare", { confirmed: true });
    expect(r.status).toBe(200);
    return r.json;
  };
  const approve = async (plan: Record<string, any>, index = 0) => {
    const r = await action(plan, "approve", {
      itemId: plan.items[index].spec.id,
      digest: plan.items[index].digest,
      confirmed: true,
      scope: "simulation_only",
      expectedStateRevision: t.server.core.snapshotFor("operator").revision,
    });
    expect(r.status).toBe(200);
    return r.json;
  };
  const simulate = (plan: Record<string, any>, index = 0, extra: object = {}) =>
    action(plan, "simulate", {
      itemId: plan.items[index].spec.id,
      approvalId: plan.items[index].approval.id,
      expectedStateRevision: t.server.core.snapshotFor("operator").revision,
      ...extra,
    });
  return { t, op, music, base, create, action, prepare, approve, simulate };
}
it("runs each approved item through virtual verification/review and reuses immutable E5 references without moving mixer state", async () => {
  const s = await boot();
  const event = (
    await s.t.http("/api/soundchecks", {
      token: s.op,
      body: {
        ...s.base,
        id: randomUUID(),
        name: "Evento AutoConfig",
        date: "2026-11-08",
        operatorName: "Operador declarado",
      },
    })
  ).json;
  const write = vi.spyOn(s.t.mixer, "write"),
    execute = vi.spyOn(s.t.server.core, "execute"),
    snapshot = s.t.server.core.snapshotFor("operator");
  let p = (
    await s.create({
      eventId: event.id,
      items: [
        voiceReturnFixture,
        {
          ...voiceReturnFixture,
          id: "cavaco-return-example",
          channel: 1,
          deltaDB: -1,
        },
      ],
    })
  ).json;
  expect(p.state).toBe("draft");
  p = await s.prepare(p);
  expect(p.state).toBe("proposed");
  for (const index of [0, 1]) {
    p = await s.approve(p, index);
    expect(p.items[1 - index].approval !== undefined).toBe(index === 1);
    const r = await s.simulate(p, index);
    expect(r.status).toBe(200);
    p = r.json;
    expect(p.items[index].result).toMatchObject({
      outcome: "passed",
      verification: "virtual_values_only",
      audioAnalysis: "not_performed",
    });
    p = (
      await s.action(p, "review", {
        itemId: p.items[index].spec.id,
        accepted: true,
        assessment: "Valor virtual conferido; sem escuta ou medição.",
      })
    ).json;
  }
  expect(p.state).toBe("reviewed");
  p = (
    await s.action(p, "save", {
      confirmed: true,
      expectedStateRevision: snapshot.revision,
    })
  ).json;
  expect(p.state).toBe("saved");
  expect(AutoConfigView.safeParse(p).success).toBe(true);
  const detail = (await s.t.http(`/api/autoconfig/${p.id}`, { token: s.op }))
    .json;
  expect(detail.reference).toMatchObject({
    id: p.referenceId,
    scope: "AUX1",
    simulation: { planId: p.id, notApplied: true },
    validationStatus: "UNVERIFIED",
    scene: { kind: "mixai-scene" },
  });
  expect(
    (await s.t.http("/api/reference-workspace", { token: s.op })).json
      .references,
  ).toEqual([]);
  expect(
    (await s.t.http(`/api/soundchecks/${event.id}`, { token: s.op })).json
      .references,
  ).toEqual([]);
  expect(s.t.server.core.snapshotFor("operator")).toEqual(snapshot);
  expect(write).not.toHaveBeenCalled();
  expect(execute).not.toHaveBeenCalled();
});
it("asks for missing/unknown inputs, refuses forbidden operations and does not invent a starting level", async () => {
  const s = await boot();
  let p = (await s.create({ items: [missingSourceFixture] })).json;
  p = await s.prepare(p);
  expect(p.state).toBe("needs_info");
  expect(p.items[0].questions.length).toBeGreaterThan(0);
  expect(
    (
      await s.action(p, "approve", {
        itemId: p.items[0].spec.id,
        digest: p.items[0].digest,
        confirmed: true,
        scope: "simulation_only",
        expectedStateRevision: 0,
      })
    ).status,
  ).toBe(409);
  p = (await s.action(p, "revise", { items: [voiceReturnFixture] })).json;
  p = await s.prepare(p);
  expect(p.state).toBe("proposed");
  for (const items of [
    [{ ...voiceReturnFixture, operation: "phantom" }],
    [{ ...voiceReturnFixture, deltaDB: 10 }],
    [{ ...voiceReturnFixture, channel: 0 }],
    [{ ...voiceReturnFixture, command: { type: "set_master" } }],
    [voiceReturnFixture, voiceReturnFixture],
  ])
    expect((await s.create({ items })).status).toBe(400);
  const realRead = s.t.mixer.read.bind(s.t.mixer);
  vi.spyOn(s.t.mixer, "read").mockImplementation((k) =>
    k === "ch.6.aux.1.level" ? { known: false } : realRead(k),
  );
  p = await s.prepare(p);
  expect(p.items[0].observation.status).toBe("unknown");
  expect(p.items[0].target).toBeUndefined();
  await s.t.mixer.disconnect();
  p = await s.prepare(p);
  expect(p.items[0].observation.status).toBe("unavailable");
  expect(p.state).toBe("needs_info");
});
it("enforces role/session authorization, per-item consent and server-owned payload digests", async () => {
  const s = await boot();
  expect((await s.t.http("/api/autoconfig")).status).toBe(401);
  expect((await s.create({}, s.music)).status).toBe(403);
  const agent = readFileSync(join(s.t.dir, "agent-lab.token"), "utf8");
  expect((await s.create({}, agent)).status).toBe(403);
  let p = await s.prepare((await s.create()).json);
  const fields = {
    itemId: p.items[0].spec.id,
    digest: p.items[0].digest,
    scope: "simulation_only",
    expectedStateRevision: s.t.server.core.snapshotFor("operator").revision,
  };
  expect(
    (await s.action(p, "approve", { ...fields, confirmed: false })).status,
  ).toBe(400);
  expect(
    (
      await s.action(p, "approve", {
        ...fields,
        confirmed: true,
        scope: "real",
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await s.action(p, "approve", {
        ...fields,
        confirmed: true,
        digest: "0".repeat(64),
      })
    ).status,
  ).toBe(409);
  expect(
    (
      await s.action(p, "approve", {
        ...fields,
        confirmed: true,
        operatorSessionId: "forged-session",
      })
    ).status,
  ).toBe(400);
  p = await s.approve(p);
  const other = await s.t.login(OPERATOR_PIN);
  expect(
    (
      await s.action(
        p,
        "simulate",
        {
          itemId: p.items[0].spec.id,
          approvalId: p.items[0].approval.id,
          expectedStateRevision:
            s.t.server.core.snapshotFor("operator").revision,
        },
        other,
      )
    ).status,
  ).toBe(403);
  await s.t.http("/api/logout", { token: s.op, body: {} });
  expect((await s.simulate(p)).status).toBe(401);
  expect(
    (await s.t.http(`/api/autoconfig/${p.id}`, { token: s.music })).status,
  ).toBe(403);
});
it("serializes competing revisions, returns idempotent receipts and refuses approval replay or changed payload", async () => {
  const simulator = {
    simulate: vi.fn(async (input: { target: number }) => ({
      after: input.target,
    })),
  };
  const s = await boot({ autoConfigSimulator: simulator });
  let p = await s.prepare((await s.create()).json);
  const fields = {
    itemId: p.items[0].spec.id,
    digest: p.items[0].digest,
    confirmed: true,
    scope: "simulation_only",
    expectedStateRevision: s.t.server.core.snapshotFor("operator").revision,
  };
  const results = await Promise.all([
    s.action(p, "approve", fields),
    s.action(p, "approve", fields),
  ]);
  expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
  p = results.find((r) => r.status === 200)!.json;
  const nonce = randomUUID(),
    r = await s.simulate(p, 0, { requestId: nonce });
  expect(r.status).toBe(200);
  const replay = await s.simulate(p, 0, { requestId: nonce });
  expect(replay.status).toBe(200);
  expect(replay.json.replayed).toBe(true);
  expect(simulator.simulate).toHaveBeenCalledTimes(1);
  expect(
    (await s.simulate(p, 0, { requestId: nonce, approvalId: randomUUID() }))
      .status,
  ).toBe(409);
  expect((await s.simulate(r.json)).status).toBe(403);
});
it("refuses stale approval and undo after an external change; virtual undo never overwrites the mixer", async () => {
  const s = await boot();
  let p = await s.approve(await s.prepare((await s.create()).json));
  p = (await s.simulate(p)).json;
  const write = vi.spyOn(s.t.mixer, "write");
  let r = await s.action(p, "undo", {
    itemId: p.items[0].spec.id,
    resultId: p.items[0].result.id,
    confirmed: true,
    expectedStateRevision: s.t.server.core.snapshotFor("operator").revision,
  });
  expect(r.status).toBe(200);
  expect(r.json.virtualState["ch.6.aux.1.level"].value).toBe(
    p.items[0].result.before,
  );
  expect(write).not.toHaveBeenCalled();
  p = await s.approve(await s.prepare((await s.create()).json));
  p = (await s.simulate(p)).json;
  await s.t.mixer.write("ch.6.aux.1.level", -15);
  (s.t.mixer as any).emitChange("ch.6.aux.1.level", -15, "external");
  write.mockClear();
  r = await s.action(p, "undo", {
    itemId: p.items[0].spec.id,
    resultId: p.items[0].result.id,
    confirmed: true,
    expectedStateRevision: s.t.server.core.snapshotFor("operator").revision,
  });
  expect(r.status).toBe(409);
  expect(write).not.toHaveBeenCalled();
  expect(s.t.mixer.read("ch.6.aux.1.level")).toMatchObject({ value: -15 });
});
it("expires unsaved work and requires a fresh preparation after restart while references remain provider independent", async () => {
  const s = await boot();
  let p = await s.approve(await s.prepare((await s.create()).json));
  await s.t.server.close();
  const again = await boot({ dir: s.t.dir });
  const existing = (
    await again.t.http(`/api/autoconfig/${p.id}`, { token: again.op })
  ).json.plan;
  expect(existing.interrupted).toBe(true);
  expect((await again.simulate(existing)).status).toBe(409);
  p = await again.prepare(existing);
  expect(p.items[0].approval).toBeUndefined();
  again.t.clock.advance(600001);
  const expired = (
    await again.t.http(`/api/autoconfig/${p.id}`, { token: again.op })
  ).json.plan;
  expect(expired.state).toBe("expired");
  expect(
    (await again.action(expired, "prepare", { confirmed: true })).status,
  ).toBe(409);
});
it("blocks REAL in the service before reading a transport or invoking simulator/scene capabilities", async () => {
  const snapshot = vi.fn(),
    create = vi.fn(),
    simulate = vi.fn();
  const s = await boot();
  const service = new AutoConfigService(
    new ReferenceStore(join(s.t.dir, "never-created.json")),
    {
      mode: () => "real",
      serverId: randomUUID(),
      active: () => true,
      snapshot,
      channels: () => [],
      supports: () => false,
      device: { model: "ui16", inputs: 12, aux: 6 },
      scenes: { create },
    },
    { simulate },
  );
  expect(() =>
    service.list({ id: "operator-test", role: "operator", label: "operador" }),
  ).toThrow("MODE_MISMATCH");
  expect(snapshot).not.toHaveBeenCalled();
  expect(create).not.toHaveBeenCalled();
  expect(simulate).not.toHaveBeenCalled();
  expect(existsSync(join(s.t.dir, "never-created.json"))).toBe(false);
});
it("cancels an in-flight test, consumes approval once and discards late results without resurrection", async () => {
  let release!: (r: { after: number }) => void;
  let started!: () => void;
  const began = new Promise<void>((r) => {
    started = r;
  });
  let signal: AbortSignal | undefined;
  const s = await boot({
    autoConfigSimulator: {
      simulate: async (input) => {
        signal = input.signal;
        started();
        return new Promise((r) => {
          release = r;
        });
      },
    },
  });
  let p = await s.approve(await s.prepare((await s.create()).json));
  const pending = s.simulate(p);
  await began;
  p = (await s.t.http(`/api/autoconfig/${p.id}`, { token: s.op })).json.plan;
  expect(p.running).toBeTruthy();
  expect(p.items[0].approval.consumedAt).toBeTruthy();
  const cancelled = await s.action(p, "cancel", {
    reason: "Operador cancelou o teste virtual.",
  });
  expect(cancelled.status).toBe(200);
  expect(cancelled.json.state).toBe("rejected");
  expect(signal!.aborted).toBe(true);
  expect((await pending).status).toBe(409);
  release({ after: 9 });
  await Promise.resolve();
  const after = (await s.t.http(`/api/autoconfig/${p.id}`, { token: s.op }))
    .json.plan;
  expect(after.state).toBe("rejected");
  expect(after.items[0].result).toBeUndefined();
});
it("times out an unresponsive calculator and rejects failed/mismatched/forged results without accepting review", async () => {
  const never = await boot({
    autoConfigSimulator: { simulate: async () => new Promise(() => {}) },
  });
  let p = await never.approve(await never.prepare((await never.create()).json));
  let r = await never.simulate(p);
  expect(r.status).toBe(200);
  expect(r.json.items[0].result.outcome).toBe("timeout");
  expect(
    (
      await never.action(r.json, "review", {
        itemId: p.items[0].spec.id,
        accepted: true,
        assessment: "aceitar",
      })
    ).status,
  ).toBe(409);
  for (const reply of [
    { after: 3 },
    { after: -19, command: { type: "set_master" } },
  ]) {
    const s = await boot({
      autoConfigSimulator: { simulate: async () => reply },
    });
    p = await s.approve(await s.prepare((await s.create()).json));
    r = await s.simulate(p);
    expect(r.status).toBe(200);
    expect(r.json.items[0].result.outcome).toBe(
      "command" in reply ? "failed" : "mismatch",
    );
    expect(r.json.state).toBe("failed");
  }
  const failed = await boot({
    autoConfigSimulator: {
      simulate: async () => {
        throw new Error("private provider failure");
      },
    },
  });
  p = await failed.approve(await failed.prepare((await failed.create()).json));
  r = await failed.simulate(p);
  expect(r.json.items[0].result.outcome).toBe("failed");
  expect(JSON.stringify(r.json)).not.toContain("private provider failure");
});
it("rechecks revocation and connection after awaiting the calculator, never trusting a late success", async () => {
  for (const reason of ["logout", "disconnect"] as const) {
    let release!: (r: { after: number }) => void;
    let started!: () => void;
    const began = new Promise<void>((r) => {
      started = r;
    });
    const s = await boot({
      autoConfigSimulator: {
        simulate: async () => {
          started();
          return new Promise((r) => {
            release = r;
          });
        },
      },
    });
    let p = await s.approve(await s.prepare((await s.create()).json));
    const pending = s.simulate(p);
    await began;
    if (reason === "logout")
      await s.t.http("/api/logout", { token: s.op, body: {} });
    else await s.t.mixer.disconnect();
    release({ after: p.items[0].target });
    expect((await pending).status).toBe(reason === "logout" ? 401 : 409);
    const fresh = await s.t.login(OPERATOR_PIN);
    const after = (await s.t.http(`/api/autoconfig/${p.id}`, { token: fresh }))
      .json.plan;
    expect(after.state).toBe("failed");
    expect(after.items[0].result.outcome).toBe("failed");
  }
});
it("supports MOCK references and persistence without provider availability, keeping synthetic references out of observed soundchecks", async () => {
  const s = await boot({ mode: "mock" });
  let p = await s.approve(await s.prepare((await s.create()).json));
  p = (await s.simulate(p)).json;
  expect(p.items[0].result.origin).toBe("mock_simulation");
  p = (
    await s.action(p, "review", {
      itemId: p.items[0].spec.id,
      accepted: true,
      assessment: "Revisão virtual apenas.",
    })
  ).json;
  p = (
    await s.action(p, "save", {
      confirmed: true,
      expectedStateRevision: s.t.server.core.snapshotFor("operator").revision,
    })
  ).json;
  expect(p.state).toBe("saved");
  expect(AutoConfigView.safeParse(p).success).toBe(true);
  const reference = (await s.t.http(`/api/autoconfig/${p.id}`, { token: s.op }))
    .json.reference;
  await s.t.server.close();
  const again = await boot({
    mode: "mock",
    dir: s.t.dir,
    autoConfigSimulator: {
      simulate: async () => {
        throw new Error("simulator unavailable");
      },
    },
  });
  expect(
    (await again.t.http(`/api/autoconfig/${p.id}`, { token: again.op })).json
      .reference,
  ).toEqual(reference);
  expect(reference.simulation).toMatchObject({
    mode: "mock",
    notApplied: true,
  });
});
it("revises references as new immutable versions and invalidates consent when its soundcheck changes", async () => {
  const s = await boot();
  let event = (
    await s.t.http("/api/soundchecks", {
      token: s.op,
      body: {
        ...s.base,
        id: randomUUID(),
        name: "Evento de revisão",
        date: "2026-11-08",
        operatorName: "Operador",
      },
    })
  ).json;
  let firstReference: any;
  for (const iteration of [0, 1]) {
    let p = await s.approve(
      await s.prepare(
        (
          await s.create({
            eventId: event.id,
            ...(firstReference ? { parentReferenceId: firstReference.id } : {}),
          })
        ).json,
      ),
    );
    if (iteration === 0) {
      event = (
        await s.t.http(`/api/soundchecks/${event.id}`, {
          token: s.op,
          body: { ...s.base, expectedVersion: event.version, action: "pause" },
        })
      ).json;
      expect((await s.simulate(p)).status).toBe(409);
      p = await s.approve(await s.prepare(p));
    }
    p = (await s.simulate(p)).json;
    p = (
      await s.action(p, "review", {
        itemId: p.items[0].spec.id,
        accepted: true,
        assessment: "Valor virtual revisto.",
      })
    ).json;
    p = (
      await s.action(p, "save", {
        confirmed: true,
        expectedStateRevision: s.t.server.core.snapshotFor("operator").revision,
      })
    ).json;
    const r = (await s.t.http(`/api/autoconfig/${p.id}`, { token: s.op })).json
      .reference;
    if (!firstReference) firstReference = r;
    else {
      expect(r.version).toBe(firstReference.version + 1);
      expect(r.id).not.toBe(firstReference.id);
    }
  }
  const references = JSON.parse(
    readFileSync(join(s.t.dir, "mix-reference-requests.json"), "utf8"),
  ).references;
  expect(references.find((r: any) => r.id === firstReference.id)).toEqual(
    firstReference,
  );
});
it("fences unfinished simulation on shutdown and never resumes or writes from a late callback after restart", async () => {
  let release!: (r: { after: number }) => void, started!: () => void;
  const began = new Promise<void>((r) => {
    started = r;
  });
  const s = await boot({
    autoConfigSimulator: {
      simulate: async () => {
        started();
        return new Promise((r) => {
          release = r;
        });
      },
    },
  });
  let p = await s.approve(await s.prepare((await s.create()).json));
  const pending = s.simulate(p).catch(() => undefined);
  await began;
  await s.t.server.close();
  const file = join(s.t.dir, "mix-reference-requests.json"),
    before = readFileSync(file, "utf8");
  release({ after: p.items[0].target });
  await pending;
  expect(readFileSync(file, "utf8")).toBe(before);
  const again = await boot({ dir: s.t.dir });
  p = (await again.t.http(`/api/autoconfig/${p.id}`, { token: again.op })).json
    .plan;
  expect(p.interrupted).toBe(true);
  p = await again.prepare(p);
  expect(p.running).toBeUndefined();
  expect(p.items[0].approval).toBeUndefined();
});
it("detects altered persisted targets instead of accepting a stale approval digest", async () => {
  const s = await boot();
  const p = await s.approve(await s.prepare((await s.create()).json));
  const file = join(s.t.dir, "mix-reference-requests.json");
  const document = JSON.parse(readFileSync(file, "utf8"));
  document.autoconfig[0].items[0].target += 1;
  const { writeFileSync } = await import("node:fs");
  writeFileSync(file, JSON.stringify(document));
  expect((await s.simulate(p)).status).toBe(409);
});
it("records a human rejection as rejection rather than successful verification or technical failure", async () => {
  const s = await boot();
  let p = await s.approve(await s.prepare((await s.create()).json));
  p = (await s.simulate(p)).json;
  p = (
    await s.action(p, "review", {
      itemId: p.items[0].spec.id,
      accepted: false,
      assessment: "Não aceito este teste virtual.",
    })
  ).json;
  expect(p.state).toBe("rejected");
  expect(p.items[0].review.accepted).toBe(false);
  expect(p.virtualState["ch.6.aux.1.level"].value).toBe(
    p.items[0].result.before,
  );
  expect(
    (
      await s.action(p, "save", {
        confirmed: true,
        expectedStateRevision: s.t.server.core.snapshotFor("operator").revision,
      })
    ).status,
  ).toBe(409);
});
