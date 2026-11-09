import { afterAll, beforeAll, expect, it, vi } from "vitest";
import type { Browser } from "playwright";
import {
  launch,
  enter,
  startLab,
  OPERATOR_PIN,
  MUSICIAN_PIN,
  physicalBandChannels,
  YOGA,
} from "./harness.js";
let browser: Browser;
beforeAll(async () => {
  browser = await launch();
});
afterAll(async () => {
  await browser.close();
});
it("operator runs, pauses and resumes event checklist after page reload; approves completion without any mixer writes", async () => {
  const t = await startLab({ channels: physicalBandChannels() });
  try {
    const { page } = await enter(browser, t.base, OPERATOR_PIN, YOGA);
    const writes = vi.spyOn(t.mixer, "write");
    await page.getByRole("button", { name: "Passagem de som", exact: true }).click();
    await page
      .getByLabel("Nome do evento da passagem", { exact: true })
      .fill("Roda de ensaio LAB");
    await page
      .getByLabel("Data da passagem", { exact: true })
      .fill("2026-11-08");
    await page
      .getByLabel("Operador da passagem", { exact: true })
      .fill("Operador de teste");
    await page
      .getByRole("button", { name: "Iniciar passagem LAB", exact: true })
      .click();
    const wizard = page.locator("mx-soundcheck");
    await wizard
      .getByRole("button", { name: "Pausar passagem", exact: true })
      .waitFor();
    const id = await page
      .getByLabel("Evento da passagem", { exact: true })
      .inputValue();
    await page
      .getByLabel("Etapa da passagem", { exact: true })
      .selectOption("lead");
    await page
      .getByLabel("Situação da etapa", { exact: true })
      .selectOption("problem");
    await page
      .getByLabel("Problema da etapa", { exact: true })
      .fill("Relato de voz abafada — sem medição");
    await page
      .getByRole("button", { name: "Salvar etapa e avançar", exact: true })
      .click();
    await expect.poll(() => wizard.innerText()).toContain("v2");
    await page
      .getByRole("button", { name: "Pausar passagem", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Retomar passagem", exact: true })
      .waitFor();
    await page.reload();
    await page.getByTestId("link").filter({ hasText: "Conectado" }).waitFor();
    await page.getByRole("button", { name: "Passagem de som", exact: true }).click();
    await page
      .getByLabel("Evento da passagem", { exact: true })
      .selectOption(id);
    await page
      .getByRole("button", { name: "Retomar passagem", exact: true })
      .click();
    const selector = page.getByLabel("Etapa da passagem", { exact: true });
    const steps = await selector
      .locator("option")
      .evaluateAll((nodes) => nodes.map((n) => (n as HTMLOptionElement).value));
    for (const step of steps) {
      await selector.selectOption(step);
      await page
        .getByLabel("Situação da etapa", { exact: true })
        .selectOption(step === "snapshot" ? "not_applicable" : "verified");
      await page
        .getByLabel("Observações da etapa", { exact: true })
        .fill(
          step === "snapshot"
            ? "Não aplicável no LAB; nenhum snapshot físico salvo"
            : "Conferência humana apenas no LAB",
        );
      await page
        .getByRole("checkbox", { name: "Confirmo humanamente este registro" })
        .check();
      const response = page.waitForResponse(
        (r) =>
          r.url().endsWith("/api/soundchecks/" + id) &&
          r.request().method() === "POST",
      );
      await page
        .getByRole("button", { name: "Salvar etapa e avançar", exact: true })
        .click();
      const saved = await response;
      expect(saved.status()).toBe(200);
      const version = (await saved.json()).version;
      await expect
        .poll(() => wizard.locator("h3").innerText())
        .toContain("· v" + version + " ·");
      await expect
        .poll(() =>
          page
            .getByRole("button", {
              name: "Salvar etapa e avançar",
              exact: true,
            })
            .isEnabled(),
        )
        .toBe(true);
    }
    await page
      .getByRole("button", { name: "Concluir registro aprovado", exact: true })
      .click();
    await expect.poll(() => wizard.innerText()).toContain("completed");
    await wizard.getByText("Histórico do evento", { exact: true }).click();
    expect(await wizard.innerText()).toContain("Relato de voz abafada");
    expect(await wizard.innerText()).toContain("not_applicable");
    expect(writes).not.toHaveBeenCalled();
    const musician = await enter(
      browser,
      t.base,
      MUSICIAN_PIN,
      YOGA,
      undefined,
      false,
    );
    expect(await musician.page.locator("mx-soundcheck").count()).toBe(0);
  } finally {
    for (const ctx of browser.contexts()) await ctx.close();
    await t.server.close();
  }
}, 60000);
