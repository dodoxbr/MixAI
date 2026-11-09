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
    .getByRole("button", { name: "Iniciar AutoConfig LAB", exact: true })
    .waitFor();
}
async function prepare(page: Page) {
  const auto = page.locator("mx-autoconfig");
  await auto
    .getByRole("button", { name: "Iniciar AutoConfig LAB", exact: true })
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
  await auto
    .getByRole("button", { name: "Visualizar plano LAB", exact: true })
    .click();
  await auto
    .getByRole("heading", { name: "Revise cada teste", exact: true })
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
    const auto = await prepare(page);
    expect(await auto.textContent()).toContain(
      "Demonstração local de interface",
    );
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
      name: "Autorizar somente este teste LAB",
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
      name: "Salvar referência temporária da sessão",
      exact: true,
    });
    expect(await save.isDisabled()).toBe(true);
    await second
      .getByRole("button", {
        name: "Rejeitar e descartar cenário",
        exact: true,
      })
      .click();
    await save.click();
    await auto.getByText(/Referência v1 · 1 item/).waitFor();
    await save.click();
    await auto.getByText(/Referência v2 · 1 item/).waitFor();
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
      scope: "lab_simulation",
      temporary: true,
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
      name: "Autorizar somente este teste LAB",
      exact: true,
    })
    .click();
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
  ).toBe(0);
  await ctx.setOffline(false);
  await page.getByTestId("link").filter({ hasText: "Conectado" }).waitFor();
  expect(await auto.locator("article").count()).toBe(0);
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
    .getByRole("button", { name: "Iniciar AutoConfig LAB", exact: true })
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
