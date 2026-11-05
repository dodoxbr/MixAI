import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

/**
 * Medidor vertical em SVG. Faixa de -60 a 0 dBFS. `simulated` mostra "SIM" bem visível:
 * no laboratório os valores NÃO são medição de áudio.
 */
@Component({
  selector: 'mx-meter',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'mx-meter', '[class.is-simulated]': 'simulated()' },
  template: `
    <svg viewBox="0 0 12 200" preserveAspectRatio="none" aria-hidden="true">
      <defs>
        <linearGradient id="mx-meter-grad" x1="0" y1="1" x2="0" y2="0">
          <stop offset="0" stop-color="#22c55e" />
          <stop offset="0.7" stop-color="#22c55e" />
          <stop offset="0.85" stop-color="#eab308" />
          <stop offset="1" stop-color="#ef4444" />
        </linearGradient>
      </defs>
      <rect class="meter-bg" x="0" y="0" width="12" height="200" rx="2" />
      <rect class="meter-fill" x="0" [attr.y]="200 - height()" width="12" [attr.height]="height()" rx="2" fill="url(#mx-meter-grad)" />
    </svg>
    @if (simulated()) {
      <span class="meter-sim" title="Medidor simulado (laboratório): não é o som real">SIM</span>
    }
  `,
})
export class MeterComponent {
  readonly level = input<number | '-inf' | null>(null);
  readonly simulated = input(false);
  readonly height = computed(() => {
    const l = this.level();
    if (l === null || l === '-inf') return 0;
    return Math.max(0, Math.min(1, (l + 60) / 60)) * 200;
  });
}
