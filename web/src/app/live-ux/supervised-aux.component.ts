import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { LiveService } from '../core/live.service';
import { formatDb } from '../core/db';
import { STEP_DB, SupervisedAuxService, type AuxOutcome } from './supervised-aux.service';

const db = (v: number | '-inf' | null | undefined) => v === null || v === undefined ? 'Não disponível' : v === '-inf' ? '−∞ dB' : formatDb(v) + ' dB';
const OUTCOME: Record<AuxOutcome['status'], string> = {
  observed_target: 'observed_target — amostra independente no valor pedido (não é ACK causal)',
  unconfirmed: 'unconfirmed — não confirmado; confira na mesa',
  not_sent: 'not_sent — nada foi enviado à mesa',
  indeterminate: 'indeterminado — sem resposta; confira na mesa',
};

/**
 * Teste supervisionado da PRIMEIRA alteração física de um envio AUX (Ui16). Usa SOMENTE prévia e confirmação do servidor (#100).
 * Não há executor, fila nem transporte aqui: o botão de confirmação é uma ação humana que chama o endpoint de confirmação.
 * Sem gate confiável no servidor (padrão) ou em LAB/MOCK a tela fica bloqueada e nada é chamado para escrever.
 */
@Component({
  selector: 'mx-supervised-aux', changeDetection: ChangeDetectionStrategy.OnPush, providers: [SupervisedAuxService],
  host: { class: 'supervised-aux' },
  template: `
    @if (svc.operator()) {
      <details class="sup-panel" [open]="open()" (toggle)="open.set($any($event.target).open)">
        <summary>Teste supervisionado — primeiro envio AUX (REAL)</summary>
        <p class="sup-note">Altera um único fader de envio AUX por vez, em passos de {{ stepText }}. Observação da mesa não é prova de causa nem de melhora de áudio. AUX1/HA800 é compartilhado.</p>
        <dl class="sup-state" aria-live="polite">
          <dt>Conexão</dt><dd data-testid="sup-link">{{ svc.status()?.link ?? live.hello()?.link ?? 'Não disponível' }}</dd>
          <dt>Mesa</dt><dd data-testid="sup-model">{{ svc.status()?.model ?? live.hello()?.model ?? 'Não disponível' }}</dd>
          <dt>Recurso REAL</dt><dd data-testid="sup-feature" [class.sup-blocked]="!svc.enabled()">{{ featureText() }}</dd>
          <dt>Valor observado</dt><dd data-testid="sup-observed">{{ observedText() }}</dd>
        </dl>
        @if (svc.lab()) {
          <p class="sup-blocked" role="status" data-testid="sup-lab">Bloqueado: o servidor está em LAB/MOCK. Nenhum envio físico é possível aqui. O fluxo simulado só roda nos testes automatizados com transporte falso.</p>
        } @else if (!svc.enabled()) {
          <p class="sup-blocked" role="status" data-testid="sup-disabled">Bloqueado: {{ blockedReason() }} Nada pode ser preparado nem enviado.</p>
        }
        @if (svc.error()) { <p class="sup-error" role="alert" data-testid="sup-error">{{ svc.error() }}</p> }
        @if (svc.status(); as s) {
          <label>Canal (cadastrado) <select aria-label="Canal do teste" [disabled]="!svc.enabled() || !!svc.busy()" (change)="svc.selectChannel($any($event.target).value === '' ? null : +$any($event.target).value)">
            <option value="" [selected]="svc.channel() === null">Selecione um canal…</option>
            @for (c of s.channels; track c.number) { <option [value]="c.number" [selected]="c.number === svc.channel()">CH{{ c.number }} — {{ c.name }}</option> }
          </select></label>
          <label>AUX (cadastrado) <select aria-label="AUX do teste" [disabled]="!svc.enabled() || !!svc.busy()" (change)="svc.selectAux($any($event.target).value === '' ? null : +$any($event.target).value)">
            <option value="" [selected]="svc.aux() === null">Selecione um AUX…</option>
            @for (a of s.aux; track a.number) { <option [value]="a.number" [selected]="a.number === svc.aux()">AUX {{ a.number }} — {{ a.name }}</option> }
          </select></label>
        }
        <div class="sup-actions">
          <button type="button" class="btn" data-testid="sup-minus" [disabled]="!svc.enabled() || !!svc.busy() || !!svc.preview() || svc.channel() === null || svc.aux() === null" (click)="svc.prepare(-1)">Preparar −{{ stepText }}</button>
          <button type="button" class="btn" data-testid="sup-plus" [disabled]="!svc.enabled() || !!svc.busy() || !!svc.preview() || svc.channel() === null || svc.aux() === null" (click)="svc.prepare(1)">Preparar +{{ stepText }}</button>
        </div>
        @if (svc.preview(); as p) {
          <section class="sup-preview" aria-label="Prévia do ajuste" data-testid="sup-preview">
            <h3>Confira antes de confirmar</h3>
            <dl>
              <dt>Destino</dt><dd>CH{{ p.channel }} → AUX {{ p.aux }}</dd>
              <dt>Valor anterior</dt><dd data-testid="sup-previous">{{ db(p.previous) }}</dd>
              <dt>Valor solicitado</dt><dd data-testid="sup-requested">{{ db(p.requested) }}</dd>
              <dt>Observado agora</dt><dd>{{ db(p.observed) }}</dd>
              <dt>Validade da prévia</dt><dd>{{ seconds() }} s</dd>
            </dl>
            @if (!svc.previewValid()) { <p class="sup-error" role="alert">A prévia expirou. Cancele e prepare de novo; nada foi enviado.</p> }
            <div class="sup-actions">
              <button type="button" class="btn btn-reject" data-testid="sup-cancel" [disabled]="svc.busy() === 'confirm'" (click)="svc.cancel()">Cancelar</button>
              <button type="button" class="btn btn-approve" data-testid="sup-confirm" [disabled]="!svc.previewValid() || !svc.enabled() || !!svc.busy()" (click)="svc.confirm()">{{ svc.busy() === 'confirm' ? 'Aguardando retorno…' : 'Confirmar envio físico' }}</button>
            </div>
          </section>
        }
        @if (svc.outcome(); as o) {
          <section class="sup-outcome" [attr.data-status]="o.status" aria-label="Resultado" data-testid="sup-outcome" role="status">
            <h3>Resultado</h3>
            <p data-testid="sup-status"><strong>{{ outcomeLabel(o) }}</strong></p>
            <dl>
              <dt>Anterior</dt><dd>{{ db(o.previous) }}</dd>
              <dt>Solicitado</dt><dd>{{ db(o.requested) }}</dd>
              <dt>Resultado observado</dt><dd data-testid="sup-result-observed">{{ db(o.observed) }}</dd>
            </dl>
            <p>{{ o.message }}</p>
            <small>Sem confirmação causal do protocolo (causalAcknowledgement: falso). Sem repetição nem desfazer automático.</small>
          </section>
        }
      </details>
    }
  `,
  styles: [`
    :host { display:block; margin:8px 0; } .sup-panel { border:1px solid var(--brass-lo); border-radius:var(--radius); background:var(--panel); padding:8px 12px; }
    summary { cursor:pointer; min-height:44px; display:flex; align-items:center; font-weight:600; } .sup-note,small { color:var(--muted); }
    dl { display:grid; grid-template-columns:1fr 1.4fr; gap:6px 8px; } dt { color:var(--muted); } dd { margin:0; overflow-wrap:anywhere; }
    label { display:block; margin:10px 0; } select { display:block; width:100%; min-height:44px; background:var(--panel-2); color:var(--text); border:1px solid var(--line); font:inherit; padding:8px; border-radius:6px; }
    .sup-blocked { color:var(--warn); } .sup-error { color:var(--bad, #c0392b); } .sup-actions { display:flex; flex-wrap:wrap; gap:8px; margin:10px 0; } .sup-actions .btn { flex:1; min-height:48px; }
    .sup-preview, .sup-outcome { border:1px solid var(--line); border-radius:var(--radius); padding:8px 12px; margin-top:8px; } h3 { margin:4px 0; font-size:1rem; }
  `],
})
export class SupervisedAuxComponent {
  readonly svc = inject(SupervisedAuxService);
  readonly live = inject(LiveService);
  readonly open = signal(false);
  readonly stepText = String(STEP_DB).replace('.', ',') + ' dB';
  readonly db = db;
  readonly seconds = computed(() => Math.ceil(this.svc.remainingMs() / 1000));
  readonly featureText = computed(() => {
    const s = this.svc.status();
    if (this.svc.lab()) return 'Bloqueado — servidor em LAB/MOCK';
    if (!s) return this.svc.real() ? 'Estado desconhecido — tratado como bloqueado' : 'Não disponível';
    return s.feature.state === 'enabled' ? `Habilitado (validação: ${s.feature.validation})` : s.feature.state === 'disabled' ? 'Desabilitado (padrão) — sem validação física' : 'Habilitado no servidor, mas bloqueado agora (conexão, identificação ou rota)';
  });
  readonly observedText = computed(() => this.svc.lab() ? 'Não disponível' : db(this.svc.status()?.observed));
  readonly blockedReason = computed(() => {
    const s = this.svc.status();
    if (!s) return 'estado do recurso REAL desconhecido.';
    if (s.feature.state === 'disabled') return 'a validação física supervisionada ainda não foi registrada no servidor (gate fechado).';
    if (s.feature.state === 'blocked') return 'conexão, identificação da mesa ou rota válidas não confirmadas.';
    return 'recurso indisponível.';
  });
  outcomeLabel(o: AuxOutcome) { return OUTCOME[o.status]; }
}
