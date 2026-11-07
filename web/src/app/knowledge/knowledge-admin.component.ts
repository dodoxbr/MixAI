import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { safeReference } from '../assistant/diagnostic-view';
import { KnowledgeAdminService } from './knowledge.service';

const EVIDENCE: Record<string, string> = {
  operator_confirmed: 'confirmado na tela', operator_report: 'relato do operador', unconfirmed: 'não confirmado',
};

/**
 * Administração da base de conhecimento (operador). Importa o pacote base, ingere documentos da
 * pasta local, cadastra o microfone de cada canal e pesquisa. Não envia nada para a mesa.
 */
@Component({
  selector: 'mx-knowledge-admin',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (k.available()) {
      <section class="knowledge-admin" aria-label="Base de conhecimento">
        <header class="knowledge-head">
          <h2>Base de conhecimento</h2>
          <button type="button" class="btn btn-small" [attr.aria-expanded]="k.open()" (click)="k.open.set(!k.open())">{{ k.open() ? 'Recolher' : 'Abrir' }}</button>
        </header>
        @if (k.status(); as s) {
          <p class="knowledge-status" role="status">
            <span class="chip-state" [class.ok]="s.store.ok" [class.warn]="!s.store.ok">Base: {{ s.store.kind === 'postgres' ? 'PostgreSQL' : 'arquivo local' }}</span>
            <span class="chip-state" [class.ok]="s.ollama.reachable" [class.warn]="!s.ollama.reachable">Ollama: {{ s.ollama.reachable ? 'ligado' : 'desligado' }}</span>
            <span class="chip-state">Busca: {{ modeLabel(s.mode) }}</span>
          </p>
        }
        @if (k.open()) {
          @if (k.status(); as s) {
            <p class="knowledge-note">{{ s.note }}</p>
            @if (s.store.fallbackFrom) { <p class="knowledge-warning" role="alert">PostgreSQL indisponível: usando arquivo local ({{ s.store.fallbackFrom }}).</p> }
            <p class="knowledge-note">{{ s.sources }} fonte(s) · {{ s.documents }} documento(s) · {{ s.chunks }} trecho(s) · {{ s.embeddedChunks }} com embedding</p>
            <p class="knowledge-note">{{ s.store.detail }}</p>
            @if (s.ollama.narrative && narrativeSummary(); as summary) { <p class="knowledge-note">{{ summary }}</p> }
          }
          @if (k.error()) { <p class="knowledge-warning" role="alert">{{ k.error() }}</p> }
          @if (k.notice()) { <p class="knowledge-ok" role="status">{{ k.notice() }}</p> }

          <div class="knowledge-actions">
            <button type="button" class="btn" [disabled]="k.busy()" (click)="k.importSeed()">Importar pacote base</button>
            <button type="button" class="btn" [disabled]="k.busy()" (click)="k.runIngest()">Ingerir pasta de documentos</button>
            <button type="button" class="btn btn-ghost" [disabled]="k.busy()" (click)="k.refresh()">Atualizar</button>
          </div>
          <p class="knowledge-note">Coloque arquivos .md, .txt ou .pdf em <code>data/knowledge/inbox</code> (nome igual ao id da fonte, ex.: <code>akg-p3.pdf</code>).</p>
          @for (item of k.ingest(); track item.file) {
            <p class="knowledge-note">{{ item.status }} · {{ item.file }}@if (item.chunks !== undefined) { · {{ item.chunks }} trechos }@if (item.reason) { — {{ item.reason }} }</p>
          }

          @if (k.mics(); as m) {
            <h3>Microfones por canal</h3>
            <p class="knowledge-note">{{ m.bandMicModel }}. {{ m.safety }}</p>
            <table class="knowledge-table" aria-label="Microfones por canal">
              <thead><tr><th>Canal</th><th>Pessoa</th><th>Modelo</th><th>Situação</th></tr></thead>
              <tbody>
                @for (row of rows(); track row.channel) {
                  <tr>
                    <td>{{ row.channel }}</td>
                    <td>{{ row.musician }}</td>
                    <td>
                      <select [attr.aria-label]="'Modelo do microfone no ' + row.channel" [disabled]="k.busy()" (change)="pick(row.number, $any($event.target).value)">
                        <option value="" [selected]="!row.modelId">Não confirmado</option>
                        @for (id of modelIds(); track id) { <option [value]="id" [selected]="row.modelId === id">{{ m.models[id]!.model }}</option> }
                      </select>
                    </td>
                    <td>{{ evidence(row.evidence) }}</td>
                  </tr>
                }
              </tbody>
            </table>
          }

          <h3>Pesquisar na base</h3>
          <form class="knowledge-search" (submit)="$event.preventDefault(); search(q.value)">
            <input #q type="text" maxlength="300" autocomplete="off" placeholder="Ex.: padrão polar do microfone" aria-label="Pesquisar na base de conhecimento" />
            <button type="submit" class="btn" [disabled]="k.busy()">Pesquisar</button>
          </form>
          @if (k.results(); as r) {
            <p class="knowledge-note">Modo: {{ r.mode }}@if (r.reason) { — {{ r.reason }} }</p>
            <ul class="knowledge-passages">
              @for (p of r.passages; track p.locator + p.title + p.excerpt) {
                <li>
                  @if (link(p.url); as href) { <a [href]="href" target="_blank" rel="noopener noreferrer">{{ p.title }}</a> } @else { <strong>{{ p.title }}</strong> }
                  · {{ p.locator }} — {{ p.excerpt }}@if (p.caution) { <em class="knowledge-warning-inline"> ⚠ {{ p.caution }}</em> }
                </li>
              } @empty { <li>Nenhum trecho encontrado.</li> }
            </ul>
          }

          <h3>Fontes e documentos</h3>
          <ul class="knowledge-sources">
            @for (s of k.sources(); track s.id) {
              <li>
                @if (link(s.url); as href) { <a [href]="href" target="_blank" rel="noopener noreferrer">{{ s.title }}</a> } @else { <strong>{{ s.title }}</strong> }
                — {{ s.documents ? s.documents + ' documento(s) ingerido(s)' : 'sem documento local' }}
              </li>
            }
          </ul>
          @for (d of k.documents(); track d.id) {
            <p class="knowledge-doc">
              {{ d.fileName }} ({{ d.sourceId }}) · {{ d.chunks }} trechos · {{ d.embedded }} com embedding
              <button type="button" class="btn btn-small btn-ghost" [disabled]="k.busy()" (click)="k.removeDocument(d.id)" [attr.aria-label]="'Remover ' + d.fileName">Remover</button>
            </p>
          }
          <p class="knowledge-note">Somente leitura de documentos técnicos. Nada aqui altera a mesa; o diagnóstico continua sem comandos.</p>
        }
      </section>
    }
  `,
})
export class KnowledgeAdminComponent {
  readonly k = inject(KnowledgeAdminService);
  readonly link = safeReference;
  readonly modelIds = computed(() => Object.keys(this.k.mics()?.models ?? {}));
  readonly rows = computed(() =>
    Object.entries(this.k.mics()?.assignments ?? {})
      .map(([channel, a]) => ({ channel, number: Number(channel.slice(2)), musician: a.musician, modelId: a.modelId, evidence: a.evidence }))
      .sort((a, b) => a.number - b.number));
  readonly narrativeSummary = computed(() => {
    const st = this.k.status()?.narrativeStats;
    if (!st) return '';
    const dropped = Object.entries(st.dropped ?? {}).filter(([, n]) => Number.isFinite(n) && n > 0);
    const total = dropped.reduce((n, [, c]) => n + c, 0);
    return `Resumo do modelo local: ${st.used ?? 0} exibido(s), ${total} descartado(s)${dropped.length ? ` (${dropped.map(([why, n]) => `${why.replace(/[^a-z_:]/g, '').slice(0, 40)} × ${n}`).join(', ')})` : ''} desde que o servidor iniciou.`;
  });
  evidence(e: string): string { return EVIDENCE[e] ?? e; }
  modeLabel(mode: string): string { return mode === 'vector' ? 'semântica' : mode === 'keyword' ? 'por palavras' : 'motor determinístico'; }
  pick(channel: number, value: string): void { void this.k.setMicrophone(channel, value || null); }
  search(query: string): void { if (query.trim().length >= 2) void this.k.search(query.trim()); }
}
