import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import type { Browser, Page } from "playwright";
import {
  enter,
  launch,
  startLab,
  OPERATOR_PIN,
  MUSICIAN_PIN,
  PHONE,
  YOGA,
} from "./harness.js";
let browser: Browser;
const labs: Awaited<ReturnType<typeof startLab>>[] = [];
beforeAll(async () => {
  browser = await launch();
});
afterEach(async () => {
  for (const ctx of browser.contexts()) await ctx.close();
  for (const lab of labs.splice(0)) await lab.server.close();
});
afterAll(async () => {
  await browser.close();
});
async function open(page: Page) {
  await page
    .getByRole("button", { name: "Passagem de som", exact: true })
    .click();
  await page
    .getByLabel("Nome do evento da passagem", { exact: true })
    .fill("Ensaio AutoConfig");
  await page.getByLabel("Data da passagem", { exact: true }).fill("2026-11-09");
  await page
    .getByLabel("Operador da passagem", { exact: true })
    .fill("Operador LAB");
  await page
    .getByRole("button", { name: "Iniciar passagem LAB", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Definir teste manualmente (sem planejador)", exact: true })
    .waitFor();
}
async function prepare(page: Page, multiple = false, another = false) {
  const auto = page.locator("mx-autoconfig");
  await auto
    .getByRole("button", {
      name: another ? "Iniciar novo plano LAB" : "Definir teste manualmente (sem planejador)",
      exact: true,
    })
    .click();
  await auto
    .getByRole("button", { name: "Melhorar clareza", exact: true })
    .click();
  await auto
    .getByLabel("Canal do AutoConfig", { exact: true })
    .selectOption("3");
  await auto
    .getByRole("button", { name: "Confirmar canal", exact: true })
    .click();
  await auto
    .getByRole("button", { name: "FONES · AUX1 compartilhado", exact: true })
    .click();
  await auto
    .getByLabel("Relato do AutoConfig", { exact: true })
    .fill("Voz abafada no retorno");
  await auto.getByLabel("Passo virtual em dB", { exact: true }).fill("1");
  await auto
    .getByRole("button", { name: "Visualizar plano LAB", exact: true })
    .click();
  await auto
    .getByRole("heading", { name: "Revise cada teste", exact: true })
    .waitFor();
  if (multiple) {
    await page.evaluate(async () => {
      const headers = {
        authorization: `Bearer ${sessionStorage.getItem("mixai.token")}`,
        "content-type": "application/json",
      };
      const workspace = await (
        await fetch("/api/autoconfig", { headers })
      ).json();
      const p = workspace.plans.at(-1);
      const response = await fetch(`/api/autoconfig/${p.id}/actions`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          serverId: workspace.serverId,
          requestId: crypto.randomUUID(),
          expectedVersion: p.version,
          action: "revise",
          items: [
            ...p.items.map((i: any) => i.spec),
            {
              id: crypto.randomUUID(),
              operation: "level_delta",
              channel: 4,
              deltaDB: 1,
              rationale: "Segundo item para teste independente.",
              evidence: [{ kind: "human_report", text: "Relato de teste." }],
            },
          ],
        }),
      });
      if (!response.ok) throw Error("fixture revise rejected");
    });
    await auto
      .getByRole("button", { name: "Consultar servidor", exact: true })
      .click();
    await expect.poll(() => auto.locator("article").count()).toBe(2);
  }
  await auto
    .getByRole("button", {
      name: "Preparar contexto no servidor (descarta aprovações)",
      exact: true,
    })
    .click();
  await auto
    .getByRole("button", {
      name: "Solicitar autorização deste teste LAB",
      exact: true,
    })
    .first()
    .waitFor();
  return auto;
}
for (const [name, device] of [
  ["Yoga", YOGA],
  ["celular", PHONE],
  ["paisagem", { ...PHONE, viewport: { width: 780, height: 360 } }],
] as const) {
  it(`per-item approvals, simulated review, rejection, versioned copy and one-touch Mesa — ${name}`, async () => {
    const lab = await startLab();
    labs.push(lab);
    const { page } = await enter(browser, lab.base, OPERATOR_PIN, device);
    const write = vi.spyOn(lab.mixer, "write");
    const commands: string[] = [];
    page.on("request", (r) => {
      if (r.url().includes("/api/command")) commands.push(r.url());
    });
    await open(page);
    const auto = await prepare(page, true);
    expect(await auto.textContent()).toContain("Núcleo virtual do servidor");
    expect(await auto.textContent()).toContain("SIMULAÇÃO LAB");
    expect(await auto.textContent()).toContain("AUX1 compartilhado");
    expect(await auto.locator("article").count()).toBe(2);
    const first = auto.locator("article").first(),
      second = auto.locator("article").nth(1);
    expect(
      await auto
        .getByRole("button", {
          name: "Executar este teste simulado",
          exact: true,
        })
        .count(),
    ).toBe(0);
    const approve = first.getByRole("button", {
      name: "Solicitar autorização deste teste LAB",
      exact: true,
    });
    expect((await approve.boundingBox())!.height).toBeGreaterThanOrEqual(48);
    await approve.focus();
    await page.keyboard.press("Enter");
    await first
      .getByRole("button", {
        name: "Executar este teste simulado",
        exact: true,
      })
      .click();
    await first
      .getByText("Resultado SIMULADO — acústica não validada", { exact: true })
      .waitFor();
    expect(await second.textContent()).toContain("Não autorizado");
    await first
      .getByRole("button", {
        name: "Confirmar resultado simulado",
        exact: true,
      })
      .click();
    const save = auto.getByRole("button", {
      name: "Salvar referência virtual no servidor",
      exact: true,
    });
    expect(await save.isDisabled()).toBe(true);
    await second
      .getByRole("button", {
        name: "Solicitar autorização deste teste LAB",
        exact: true,
      })
      .click();
    await second
      .getByRole("button", {
        name: "Executar este teste simulado",
        exact: true,
      })
      .click();
    await second
      .getByRole("button", {
        name: "Rejeitar e descartar cenário",
        exact: true,
      })
      .waitFor();
    await second
      .getByRole("button", {
        name: "Rejeitar e descartar cenário",
        exact: true,
      })
      .click();
    await save.click();
    await auto.getByText(/Referência v1/).waitFor();
    expect(await save.isDisabled()).toBe(true); // Saved references are immutable, not duplicate local versions.
    await prepare(page, false, true);
    await auto
      .getByRole("button", {
        name: "Solicitar autorização deste teste LAB",
        exact: true,
      })
      .click();
    await auto
      .getByRole("button", {
        name: "Executar este teste simulado",
        exact: true,
      })
      .click();
    await auto
      .getByRole("button", {
        name: "Confirmar resultado simulado",
        exact: true,
      })
      .click();
    await auto
      .getByRole("button", {
        name: "Salvar referência virtual no servidor",
        exact: true,
      })
      .click();
    await auto.getByText(/Referência v2/).waitFor();
    const downloaded = page.waitForEvent("download");
    await auto
      .getByRole("button", {
        name: "Baixar referência simulada v2",
        exact: true,
      })
      .click();
    const download = await downloaded;
    expect(download.suggestedFilename()).toBe("mixai-simulacao-lab-v2.json");
    const stream = (await download.createReadStream())!;
    let json = "";
    for await (const chunk of stream) json += chunk;
    expect(JSON.parse(json)).toMatchObject({
      validationStatus: "UNVERIFIED",
      simulation: { notApplied: true },
      version: 2,
    });
    expect(json).not.toMatch(/token|pin|authorization/i);
    expect(await auto.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(
      true,
    );
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await page.getByRole("button", { name: "Mesa", exact: true }).click();
    await page.locator(".mesa-main").waitFor();
    expect(await page.locator("mx-autoconfig").count()).toBe(0);
    expect(write).not.toHaveBeenCalled();
    expect(commands).toEqual([]);
  });
}
it("offline disables approvals, reconnect requires new review, logout clears temporary history", async () => {
  const lab = await startLab();
  labs.push(lab);
  const { page, ctx } = await enter(browser, lab.base, OPERATOR_PIN, PHONE);
  const write = vi.spyOn(lab.mixer, "write");
  await open(page);
  const auto = await prepare(page);
  await auto
    .locator("article")
    .first()
    .getByRole("button", {
      name: "Solicitar autorização deste teste LAB",
      exact: true,
    })
    .click();
  await auto
    .getByRole("button", { name: "Executar este teste simulado", exact: true })
    .waitFor();
  const eventId = await page
    .getByLabel("Evento da passagem", { exact: true })
    .inputValue();
  await ctx.setOffline(true);
  const sockets = (
    lab.server.https[0] as unknown as {
      websocketServer: { clients: Set<{ terminate(): void }> };
    }
  ).websocketServer;
  for (const socket of sockets.clients) socket.terminate();
  await expect
    .poll(() => auto.textContent(), { timeout: 15000 })
    .toContain("Sem conexão");
  expect(
    await auto
      .getByRole("button", {
        name: "Executar este teste simulado",
        exact: true,
      })
      .count(),
  ).toBe(1);
  expect(
    await auto
      .getByRole("button", {
        name: "Executar este teste simulado",
        exact: true,
      })
      .isDisabled(),
  ).toBe(true);
  await ctx.setOffline(false);
  await page.getByTestId("link").filter({ hasText: "Conectado" }).waitFor();
  expect(
    await auto
      .getByRole("button", {
        name: "Executar este teste simulado",
        exact: true,
      })
      .count(),
  ).toBe(0);
  const restoredEvent = page.getByLabel("Evento da passagem", { exact: true });
  await expect.poll(() => restoredEvent.locator("option").count()).toBe(2);
  await restoredEvent.selectOption(eventId);
  await auto
    .getByRole("button", { name: "Consultar servidor", exact: true })
    .click();
  await expect
    .poll(() =>
      auto
        .getByLabel("Plano AutoConfig do servidor", { exact: true })
        .locator("option")
        .count(),
    )
    .toBe(2);
  await auto
    .getByLabel("Plano AutoConfig do servidor", { exact: true })
    .selectOption({ index: 1 });
  await auto
    .getByRole("button", { name: "Executar este teste simulado", exact: true })
    .waitFor();
  expect(
    await auto
      .getByRole("button", {
        name: "Executar este teste simulado",
        exact: true,
      })
      .isDisabled(),
  ).toBe(true);
  await auto
    .getByRole("button", {
      name: "Preparar contexto no servidor (descarta aprovações)",
      exact: true,
    })
    .click();
  await auto
    .getByRole("button", {
      name: "Solicitar autorização deste teste LAB",
      exact: true,
    })
    .waitFor();
  const token = await page.evaluate(() =>
    sessionStorage.getItem("mixai.token"),
  );
  await lab.http("/api/logout", { token: token!, body: {} });
  await page.locator("mx-login").waitFor();
  expect(await page.locator("mx-autoconfig").count()).toBe(0);
  for (const digit of OPERATOR_PIN)
    await page.getByRole("button", { name: digit, exact: true }).click();
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await page
    .getByRole("button", { name: "Passagem de som", exact: true })
    .click();
  const events = page.getByLabel("Evento da passagem", { exact: true });
  await expect.poll(() => events.locator("option").count()).toBe(2);
  await events.selectOption({ index: 1 });
  await page
    .getByRole("button", { name: "Definir teste manualmente (sem planejador)", exact: true })
    .waitFor();
  expect(await page.locator("mx-autoconfig").textContent()).not.toContain(
    "Voz abafada",
  );
  expect(write).not.toHaveBeenCalled();
});
it("musician has no AutoConfig approval surface and preserves existing authorization", async () => {
  const lab = await startLab();
  labs.push(lab);
  const { page } = await enter(
    browser,
    lab.base,
    MUSICIAN_PIN,
    PHONE,
    undefined,
    false,
  );
  expect(await page.locator("mx-autoconfig").count()).toBe(0);
  expect(
    await page
      .getByRole("button", { name: "Passagem de som", exact: true })
      .count(),
  ).toBe(0);
  const token = await page.evaluate(() =>
    sessionStorage.getItem("mixai.token"),
  );
  expect(
    (await lab.command(token!, { type: "set_master", deltaDB: 1 })).json.result
      .code,
  ).toBe("FORBIDDEN");
});
it("a second operator cannot consume the first operator approval, and UI never fabricates success", async () => {
  const lab = await startLab();
  labs.push(lab);
  const a = await enter(browser, lab.base, OPERATOR_PIN, YOGA);
  await open(a.page);
  const auto = await prepare(a.page);
  await auto
    .getByRole("button", {
      name: "Solicitar autorização deste teste LAB",
      exact: true,
    })
    .click();
  await auto
    .getByRole("button", { name: "Executar este teste simulado", exact: true })
    .waitFor();
  const eventId = await a.page
    .getByLabel("Evento da passagem", { exact: true })
    .inputValue();
  const b = await enter(browser, lab.base, OPERATOR_PIN, PHONE);
  await b.page
    .getByRole("button", { name: "Passagem de som", exact: true })
    .click();
  await b.page
    .getByLabel("Evento da passagem", { exact: true })
    .selectOption(eventId);
  const other = b.page.locator("mx-autoconfig");
  await other
    .getByRole("button", { name: "Consultar servidor", exact: true })
    .click();
  await expect
    .poll(() =>
      other
        .getByLabel("Plano AutoConfig do servidor", { exact: true })
        .locator("option")
        .count(),
    )
    .toBe(2);
  await other
    .getByLabel("Plano AutoConfig do servidor", { exact: true })
    .selectOption({ index: 1 });
  await other
    .getByRole("button", { name: "Executar este teste simulado", exact: true })
    .waitFor();
  expect(
    await other
      .getByRole("button", {
        name: "Executar este teste simulado",
        exact: true,
      })
      .isDisabled(),
  ).toBe(true);
  const status = await b.page.evaluate(async () => {
    const headers = {
      authorization: `Bearer ${sessionStorage.getItem("mixai.token")}`,
      "content-type": "application/json",
    };
    const w = await (await fetch("/api/autoconfig", { headers })).json();
    const p = w.plans[0];
    const response = await fetch(`/api/autoconfig/${p.id}/actions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        serverId: w.serverId,
        requestId: crypto.randomUUID(),
        expectedVersion: p.version,
        action: "simulate",
        itemId: p.items[0].spec.id,
        approvalId: p.items[0].approval.id,
        expectedStateRevision: p.context.revision,
      }),
    });
    return response.status;
  });
  expect(status).toBe(403);
  expect(
    await other
      .getByText("Resultado SIMULADO — acústica não validada", { exact: true })
      .count(),
  ).toBe(0);
});
it("references persist across logout and reload, while session-private answers are cleared", async () => {
  const lab = await startLab();
  labs.push(lab);
  const { page } = await enter(browser, lab.base, OPERATOR_PIN, YOGA);
  await open(page);
  const auto = await prepare(page);
  await auto
    .getByRole("button", {
      name: "Solicitar autorização deste teste LAB",
      exact: true,
    })
    .click();
  await auto
    .getByRole("button", { name: "Executar este teste simulado", exact: true })
    .click();
  await auto
    .getByRole("button", { name: "Confirmar resultado simulado", exact: true })
    .click();
  await auto
    .getByRole("button", {
      name: "Salvar referência virtual no servidor",
      exact: true,
    })
    .click();
  await auto.getByText(/Referência v1/).waitFor();
  const eventId = await page
    .getByLabel("Evento da passagem", { exact: true })
    .inputValue();
  await page.getByRole("button", { name: "Sair", exact: true }).click();
  await page.locator("mx-login").waitFor();
  for (const d of OPERATOR_PIN)
    await page.getByRole("button", { name: d, exact: true }).click();
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await page.getByTestId("link").filter({ hasText: "Conectado" }).waitFor();
  await page
    .getByRole("button", { name: "Passagem de som", exact: true })
    .click();
  await page
    .getByLabel("Evento da passagem", { exact: true })
    .selectOption(eventId);
  await auto
    .getByRole("button", { name: "Consultar servidor", exact: true })
    .click();
  await expect
    .poll(() =>
      auto
        .getByLabel("Plano AutoConfig do servidor", { exact: true })
        .locator("option")
        .count(),
    )
    .toBe(2);
  await auto
    .getByLabel("Plano AutoConfig do servidor", { exact: true })
    .selectOption({ index: 1 });
  await auto.getByText(/Referência v1/).waitFor();
  expect(await auto.textContent()).toContain("persistida no servidor");
  expect(
    (
      await auto
        .locator("p.source")
        .filter({ hasText: /^Relato humano:/ })
        .first()
        .textContent()
    )?.trim(),
  ).toBe("Relato humano:");
  expect(await auto.textContent()).toContain(
    "Relato humano: Voz abafada no retorno",
  ); // Persisted evidence from an explicit server read.
});
it("answers canonical missing-field questions through revise and explicit prepare, without guessed observations", async () => {
  const lab = await startLab();
  labs.push(lab);
  const { page } = await enter(browser, lab.base, OPERATOR_PIN, PHONE);
  await open(page);
  const eventId = await page
    .getByLabel("Evento da passagem", { exact: true })
    .inputValue();
  const token = await page.evaluate(() =>
    sessionStorage.getItem("mixai.token"),
  );
  const created = await lab.http("/api/autoconfig", {
    token: token!,
    body: {
      serverId: lab.server.core.serverId,
      id: crypto.randomUUID(),
      title: "Canal ausente",
      eventId,
      scope: "AUX1",
      items: [
        {
          id: "missing-item",
          operation: "level_delta",
          rationale: "Contexto a confirmar.",
          evidence: [],
        },
      ],
    },
  });
  expect(created.status).toBe(200);
  const prepared = await lab.http(
    `/api/autoconfig/${created.json.id}/actions`,
    {
      token: token!,
      body: {
        serverId: lab.server.core.serverId,
        requestId: crypto.randomUUID(),
        expectedVersion: created.json.version,
        action: "prepare",
        confirmed: true,
      },
    },
  );
  expect(prepared.json.state).toBe("needs_info");
  const auto = page.locator("mx-autoconfig");
  await auto
    .getByRole("button", { name: "Consultar servidor", exact: true })
    .click();
  await expect
    .poll(() =>
      auto
        .getByLabel("Plano AutoConfig do servidor", { exact: true })
        .locator("option")
        .count(),
    )
    .toBe(2);
  await auto
    .getByLabel("Plano AutoConfig do servidor", { exact: true })
    .selectOption({ index: 1 });
  await auto
    .getByText("Pergunta do servidor: Confirme o canal.", { exact: true })
    .waitFor();
  expect(
    await auto
      .getByRole("button", {
        name: "Solicitar autorização deste teste LAB",
        exact: true,
      })
      .count(),
  ).toBe(0);
  await auto
    .getByLabel("Canal da resposta missing-item", { exact: true })
    .selectOption("3");
  await auto
    .getByLabel("Passo da resposta missing-item", { exact: true })
    .fill("1");
  await auto
    .getByRole("button", { name: "Enviar respostas ao servidor", exact: true })
    .click();
  await expect
    .poll(() =>
      auto
        .getByText("Pergunta do servidor: Confirme o canal.", { exact: true })
        .count(),
    )
    .toBe(0);
  await auto
    .getByRole("button", {
      name: "Preparar contexto no servidor (descarta aprovações)",
      exact: true,
    })
    .click();
  await auto
    .getByRole("button", {
      name: "Solicitar autorização deste teste LAB",
      exact: true,
    })
    .waitFor();
  expect(await auto.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(
    true,
  );
});
