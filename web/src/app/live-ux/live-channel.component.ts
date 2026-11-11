import { ChangeDetectionStrategy, Component, ElementRef, afterNextRender, computed, effect, inject, input, output, signal, untracked } from '@angular/core';
import { ActionsService } from '../core/actions.service';
import { LiveService } from '../core/live.service';
import { SessionService } from '../core/session.service';
import { keys, type StateValue } from '../core/protocol';
import { formatDb } from '../core/db';
import { operationView } from './operation-view';
const unavailable: StateValue = { status: 'unavailable' };
const levelLabel = (v: StateValue) => v.status === 'known' ? typeof v.value === 'number' ? formatDb(v.value) + ' dB' : 'Não disponível' : 'Não disponível';
/** Read-only inspector. Route/channel selection changes the view, never executes a command. */
@Component({
  selector: 'mx-live-channel', changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'live-channel', role: 'region', 'aria-label': 'Canal selecionado' },
  template: `
    <header><h2 tabindex="-1">Canal selecionado</h2><button type="button" class="btn btn-ghost" (click)="closed.emit()" aria-label="Fechar detalhes do canal">Fechar</button></header>
    <label>Canal <select aria-label="Canal" [value]="channel()" (change)="channelChanged.emit(+$any($event.target).value)">
      @for (ch of live.channels(); track ch.number) { <option [value]="ch.number">CH{{ ch.number }} — {{ ch.name }}</option> }
    </select></label>
    <label>Destino dos controles <select aria-label="Destino dos controles" [value]="aux() === undefined ? 'pa' : '' + aux()" (change)="routeChanged.emit($any($event.target).value)">
      <option value="pa">PA</option>
      @for (route of live.auxes(); track route.number) {
        <option [value]="route.number" [disabled]="live.hello()?.mode === 'real' && route.number !== live.hello()?.musicianAux">AUX {{ route.number }} — {{ route.name }}</option>
      }
    </select></label>
    <p class="live-name"><strong>CH{{ channel() }} — {{ name() }}</strong> · {{ aux() === undefined ? 'PA' : 'AUX ' + aux() }}</p>
    <dl aria-live="polite">
      <dt>Fader observado</dt><dd>{{ levelText() }}</dd>
      <dt>Mute</dt><dd>{{ muteText() }}</dd>
      <dt>Sincronização</dt><dd>{{ syncText() }}</dd>
      <dt>Modo</dt><dd>{{ live.hello()?.mode === 'real' ? 'REAL — estado observado não é áudio medido' : 'LAB/MOCK — simulação' }}</dd>
    </dl>
    @if (aux() === 1) { <p class="live-warning">AUX1 é compartilhado no HA800. Alterações afetam todos que o utilizam.</p> }
    @else if (aux() !== undefined) { <p class="live-warning">Rota do cadastro do servidor. Saída física não validada por esta tela. AUX adicional disponível somente em LAB/MOCK.</p> }
    @if (live.pending().length) { <p role="status" class="live-warning">{{ live.pending().length }} aprovação(ões) especial(is) pendente(s). Confira os cartões antes de decidir.</p> }
    @if (actions.busy().size || actions.deciding()) { <p role="status">Operação aguardando resposta do servidor…</p> }
    <details>
      <summary>Último retorno e alterações recentes</summary>
      @if (canRead() && latest(); as receipt) {
        <p><strong>{{ resultView().label }}</strong></p><p>{{ receipt.result.message }}</p>
        <small>Última operação recebida, de qualquer canal. Não é prova de confirmação física.</small>
      } @else { <p>Último retorno não disponível.</p> }
      <ol aria-label="Alterações observadas desde a abertura">
        @for (change of recent(); track change.id) { <li>{{ change.key }}: {{ change.value }} · revisão {{ change.revision }}</li> }
        @empty { <li>Nenhuma alteração observada desde a abertura. Isso não prova ausência de mudanças na mesa.</li> }
      </ol>
    </details>
    <div class="live-tools"><button type="button" class="btn" (click)="historyRequested.emit()">Ver histórico</button><button type="button" class="btn" [disabled]="!live.writable() || actions.isBusy('undo')" (click)="undoRequested.emit()">Desfazer último ajuste</button></div>
  `,
  styles: [`
    :host { display:block; padding:12px; border:1px solid var(--brass-lo); border-radius:var(--radius); background:var(--panel); }
    header { display:flex; align-items:center; justify-content:space-between; gap:8px; } h2 { font-size:1.1rem; margin:0; }
    label { display:block; margin:12px 0; } select { display:block; width:100%; min-height:48px; background:var(--panel-2); color:var(--text); border:1px solid var(--line); font:inherit; padding:8px; border-radius:6px; }
    dl { display:grid; grid-template-columns:1fr 1.3fr; gap:8px; } dt,small {color:var(--muted);} dd { margin:0; overflow-wrap:anywhere; }
    .live-warning { color:var(--warn); } .live-tools {display:flex;flex-wrap:wrap;gap:8px;margin-top:12px;} .live-tools .btn {flex:1;}
    summary { cursor:pointer; min-height:48px; display:flex;align-items:center; } ol {padding-left:20px;overflow-wrap:anywhere;} .live-name {overflow-wrap:anywhere;}
  `],
})
export class LiveChannelComponent {
  readonly live = inject(LiveService);
  readonly actions = inject(ActionsService);
  private readonly session = inject(SessionService);
  readonly channel = input.required<number>();
  readonly aux = input<number | undefined>();
  readonly closed = output<void>();
  readonly channelChanged = output<number>();
  readonly routeChanged = output<string>();
  readonly historyRequested = output<void>();
  readonly undoRequested = output<void>();
  readonly name = computed(() => this.live.channels().find(c => c.number === this.channel())?.name ?? 'Nome não disponível');
  readonly canRead = computed(() => this.live.connection() === 'online' && !this.live.synchronizing() && this.live.state()?.available === true);
  readonly level = computed(() => this.canRead() ? this.live.state()?.params[keys.level(this.channel(), this.aux())]?.value ?? unavailable : unavailable);
  readonly mute = computed(() => this.canRead() ? this.live.state()?.params[keys.mute(this.channel(), this.aux())]?.value ?? unavailable : unavailable);
  readonly levelText = computed(() => levelLabel(this.level()));
  readonly muteText = computed(() => { const v = this.mute(); return v.status === 'known' && typeof v.value === 'boolean' ? v.value ? 'MUTE ativo' : 'Aberto' : 'Não disponível'; });
  readonly syncText = computed(() => !this.canRead() ? 'Leitura não disponível / sincronização pendente' : 'Espelho do servidor · revisão ' + this.live.state()!.revision);
  readonly latest = computed(() => [this.actions.receipt(), this.live.faderReceipt()].filter(x => x !== null).sort((a,b)=>b.receivedAt-a.receivedAt)[0] ?? null);
  readonly resultView = computed(() => operationView(this.latest()?.result, this.live.hello()?.mode));
  readonly recent = signal<Array<{id:number;key:string;value:string;revision:number}>>([]);
  constructor() {
    const host: ElementRef<HTMLElement> = inject(ElementRef);
    afterNextRender(() => { host.nativeElement.querySelector<HTMLElement>('h2')?.focus({preventScroll:true}); host.nativeElement.scrollIntoView?.({block:'nearest'}); });
    let previous: Record<string,{value:StateValue;revision:number}> | null = null, seq=0;
    let owner: string | null | undefined, serverId: string | undefined;
    effect(() => {
      const token = this.session.token(); const server = this.live.hello()?.serverId; const state = this.live.state(), readable=this.canRead();
      if (owner !== token || serverId !== server) { owner=token; serverId=server; previous=null; untracked(()=>this.recent.set([])); }
      if (!readable || !server) { previous=null; untracked(()=>this.recent.set([])); return; }
      const params=state!.params;
      if (previous) {
        const updates=Object.entries(params).filter(([key,p])=>previous![key] && p.revision > previous![key]!.revision && JSON.stringify(p.value)!==JSON.stringify(previous![key]!.value));
        if(updates.length) untracked(()=>this.recent.update(list=>[...updates.map(([key,p])=>({id:++seq,key,value:p.value.status==='known'?typeof p.value.value==='boolean'?(p.value.value?'MUTE':'Aberto'):levelLabel(p.value):'Não disponível',revision:p.revision})),...list].slice(0,8)));
      }
      previous={...params};
    });
  }
}
