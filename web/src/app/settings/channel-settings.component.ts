import { Component, ChangeDetectionStrategy, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { SessionService } from '../core/session.service';
import { LiveService } from '../core/live.service';
interface Entry {
  number: number;
  name: string;
  aliases: string[];
  aliasText: string;
}
interface Settings {
  revision: string;
  channels: Entry[];
  aux: Entry[];
  mixerNames: Array<{ number: number; name: string | null }>;
}
@Component({
  selector: 'mx-channel-settings',
  imports: [FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h3>Canais e AUX</h3>
    <p>
      Cadastro local do MixAI. Os números físicos são fixos. Salvar nomes não envia comandos à
      Soundcraft.
    </p>
    <p>AUX1 alimenta o mix compartilhado dos fones pelo HA800.</p>
    @if (error()) {
      <p role="alert">{{ error() }}</p>
    }
    @if (notice()) {
      <p role="status">{{ notice() }}</p>
    }
    @if (busy()) {
      <p role="status">{{ saving() ? 'Salvando cadastro…' : 'Carregando cadastro…' }}</p>
    }
    <button type="button" class="btn" [disabled]="busy()" (click)="load()">
      Recarregar cadastro
    </button>
    @if (settings(); as config) {
      <form (submit)="$event.preventDefault(); save()" [attr.aria-busy]="busy()">
        <fieldset [disabled]="busy() || !allowed()">
          <legend>Canais físicos</legend>
          @for (row of config.channels; track row.number) {
            <section>
              <h4>CH{{ row.number }}</h4>
              <label
                >Nome de exibição CH{{ row.number
                }}<input
                  [attr.aria-label]="'Nome CH' + row.number"
                  [name]="'ch-name-' + row.number"
                  maxlength="80"
                  required
                  [(ngModel)]="row.name"
              /></label>
              <label
                >Nomes alternativos CH{{ row.number
                }}<textarea
                  [attr.aria-label]="'Apelidos CH' + row.number"
                  [name]="'ch-alias-' + row.number"
                  [(ngModel)]="row.aliasText"
                  rows="2"
                  placeholder="Um nome por linha"
                ></textarea>
              </label>
              <small>Um apelido por linha; nomes ambíguos são recusados pelo servidor.</small>
              <p>
                Nome relatado pela mesa: {{ deviceName(row.number) }}.
                @if (
                  deviceName(row.number) !== 'Indisponível' && deviceName(row.number) !== row.name
                ) {
                  <strong>Difere do nome local; não será importado automaticamente.</strong>
                }
              </p>
            </section>
          }
        </fieldset>
        <fieldset [disabled]="busy() || !allowed()">
          <legend>AUX cadastrados</legend>
          @for (row of config.aux; track row.number) {
            <section>
              <h4>AUX {{ row.number }}</h4>
              <label
                >Nome de exibição AUX {{ row.number
                }}<input
                  [attr.aria-label]="'Nome AUX' + row.number"
                  [name]="'aux-name-' + row.number"
                  maxlength="80"
                  required
                  [(ngModel)]="row.name"
              /></label>
              <label
                >Nomes alternativos AUX {{ row.number
                }}<textarea
                  [attr.aria-label]="'Apelidos AUX' + row.number"
                  [name]="'aux-alias-' + row.number"
                  [(ngModel)]="row.aliasText"
                  rows="2"
                ></textarea>
              </label>
            </section>
          }
        </fieldset>
        <button type="submit" class="btn btn-primary" [disabled]="busy() || !allowed()">
          Salvar nomes locais
        </button>
      </form>
    }
  `,
  styles: [
    `
      section { overflow-wrap:anywhere; }
    fieldset {
        border: 0;
        padding: 0;
        min-width: 0;
      }
      section {
        padding: 12px;
        margin: 12px 0;
        border: 1px solid var(--line);
        border-radius: 8px;
      }
      label {
        display: block;
        margin: 8px 0;
      }
      input,
      textarea {
        display: block;
        width: 100%;
        box-sizing: border-box;
        min-height: 48px;
        background: var(--panel-2);
        color: var(--text);
        border: 1px solid var(--line);
        border-radius: 6px;
        padding: 10px;
        font: inherit;
      }
      button {
        min-height: 48px;
      }
      small {
        color: var(--muted);
      }
      [role='alert'] {
        color: var(--warn);
      }
      h4 {
        margin: 0;
      }
    `,
  ],
})
export class ChannelSettingsComponent {
  readonly session = inject(SessionService);
  readonly live = inject(LiveService);
  readonly settings = signal<Settings | null>(null);
  readonly busy = signal(false);
  readonly saving = signal(false);
  readonly error = signal('');
  readonly notice = signal('');
  constructor() {
    void this.load();
  }
  allowed() {
    return (
      this.session.role() === 'operator' &&
      !!this.session.token() &&
      this.live.connection() === 'online'
    );
  }
  deviceName(number: number) {
    return this.settings()?.mixerNames.find((e) => e.number === number)?.name ?? 'Indisponível';
  }
  async load() {
    await this.request(false);
  }
  async save() {
    await this.request(true);
  }
  private async request(save: boolean) {
    if (this.busy() || !this.allowed()) return;
    const token = this.session.token(),
      server = this.live.hello()?.serverId,
      config = this.settings();
    if (save && !config) return;
    this.busy.set(true);
    this.saving.set(save);
    this.error.set('');
    this.notice.set('');
    try {
      const rows = (list: Entry[]) =>
        list.map((r) => ({
          number: r.number,
          name: r.name.trim(),
          aliases: r.aliasText
            .split(/\r?\n/)
            .map((s) => s.trim())
            .filter(Boolean),
        }));
      const result = await fetch('/api/settings/channels', {
        method: save ? 'PUT' : 'GET',
        headers: {
          authorization: 'Bearer ' + token,
          ...(save ? { 'content-type': 'application/json' } : {}),
        },
        ...(save
          ? {
              body: JSON.stringify({
                serverId: server,
                revision: config!.revision,
                channels: rows(config!.channels),
                aux: rows(config!.aux),
              }),
            }
          : {}),
      });
      const body = await result.json();
      if (token !== this.session.token() || server !== this.live.hello()?.serverId) return;
      if (!result.ok)
        throw Error(body.message ?? 'Configuração indisponível ou sessão sem permissão.');
      if (body.serverId !== server) throw Error('Servidor mudou. Recarregue a página.');
      const data = body.settings as Settings;
      for (const list of [data.channels, data.aux])
        for (const row of list) row.aliasText = row.aliases.join('\n');
      this.settings.set(data);
      if (save) this.notice.set('Nomes locais salvos. Nenhum parâmetro físico foi alterado.');
    } catch (e) {
      if (token === this.session.token() && server === this.live.hello()?.serverId)
        this.error.set(e instanceof Error ? e.message : 'Falha ao acessar cadastro.');
    } finally {
      this.busy.set(false);
      this.saving.set(false);
    }
  }
}
