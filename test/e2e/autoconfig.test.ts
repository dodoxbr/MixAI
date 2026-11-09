import { afterAll, beforeAll, expect, it, vi } from "vitest";
import type { Browser, Page } from "playwright";
import {
  launch,
  enter,
  startLab,
  OPERATOR_PIN,
  MUSICIAN_PIN,
  physicalBandChannels,
  YOGA,
} from "./harness.js";
import { voiceReturnFixture } from "../../src/autoconfig/fixtures.js";
let browser: Browser;
beforeAll(async () => {
  browser = await launch();
});
afterAll(async () => {
  await browser.close();
});
async function api(page: Page, path: string, body?: object) {
  return page.evaluate(
    async ({ path, body }) => {
      const response = await fetch(path, {
        method: body ? "POST" : "GET",
        headers: {
          authorization: `Bearer ${sessionStorage.getItem("mixai.token")}`,
          ...(body ? { "content-type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      return { status: response.status, body: await response.json() };
    },
    { path, body },
  );
}
it("operator individually consents to virtual tests, verifies/reviews and saves an unapplied reference; musician cannot authorize", async () => {
  const t = await startLab({ channels: physicalBandChannels() });
  try {
    const { page: op } = await enter(browser, t.base, OPERATOR_PIN, YOGA);
    const { page: music } = await enter(
      browser,
      t.base,
      MUSICIAN_PIN,
      YOGA,
      undefined,
      false,
    );
    const write = vi.spyOn(t.mixer, "write");
    const baseline = t.server.core.snapshotFor("operator");
    const base = { serverId: t.server.core.serverId };
    let r = await api(op, "/api/autoconfig", {
      ...base,
      id: crypto.randomUUID(),
      title: "Retorno virtual",
      scope: "AUX1",
      items: [voiceReturnFixture],
    });
    expect(r.status).toBe(200);
    let p = r.body;
    const act = async (action: string, extra: object = {}) =>
      api(op, `/api/autoconfig/${p.id}/actions`, {
        ...base,
        requestId: crypto.randomUUID(),
        expectedVersion: p.version,
        action,
        ...extra,
      });
    p = (await act("prepare", { confirmed: true })).body;
    expect(p.state).toBe("proposed");
    expect(p.context.realObservation).toBe("unavailable");
    expect(p.context.acousticMeasurement).toBe("unavailable");
    const consent = {
      action: "approve",
      itemId: p.items[0].spec.id,
      digest: p.items[0].digest,
      confirmed: true,
      scope: "simulation_only",
      expectedStateRevision: baseline.revision,
    };
    const denied = await api(music, `/api/autoconfig/${p.id}/actions`, {
      ...base,
      requestId: crypto.randomUUID(),
      expectedVersion: p.version,
      ...consent,
    });
    expect(denied.status).toBe(403);
    p = (await act("approve", consent)).body;
    expect(p.state).toBe("approved_for_lab");
    p = (
      await act("simulate", {
        itemId: p.items[0].spec.id,
        approvalId: p.items[0].approval.id,
        expectedStateRevision: baseline.revision,
      })
    ).body;
    expect(p.items[0].result.outcome).toBe("passed");
    expect(p.virtualState["ch.6.aux.1.level"].appliedToMixer).toBe(false);
    p = (
      await act("review", {
        itemId: p.items[0].spec.id,
        accepted: true,
        assessment: "Apenas valor virtual conferido.",
      })
    ).body;
    p = (
      await act("save", {
        confirmed: true,
        expectedStateRevision: baseline.revision,
      })
    ).body;
    expect(p.state).toBe("saved");
    const detail = await api(op, `/api/autoconfig/${p.id}`);
    expect(detail.body.reference.simulation.notApplied).toBe(true);
    expect(detail.body.reference.validationStatus).toBe("UNVERIFIED");
    expect(write).not.toHaveBeenCalled();
    expect(t.server.core.snapshotFor("operator")).toEqual(baseline);
    expect((await api(music, `/api/autoconfig/${p.id}`)).status).toBe(403);
  } finally {
    for (const ctx of browser.contexts()) await ctx.close();
    await t.server.close();
  }
});
