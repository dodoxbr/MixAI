import { ReplaySubject, Subject } from 'rxjs';
import { ConnectionStatus } from 'soundcraft-ui-connection';
import { parseKey, type ParamKey, type ParamValue } from '../../src/core/revisions.js';

/**
 * Dublê mínimo da SoundcraftUI para testar o supervisor com controle total dos eventos
 * (inclusive eventos atrasados e fora de ordem de instâncias antigas).
 * Assim como a biblioteca, a escrita aparece no estado local na hora (eco local).
 */
export class StubUi {
  static created: StubUi[] = [];
  readonly status$ = new Subject<{ type: ConnectionStatus }>();
  readonly conn = { status: ConnectionStatus.Close as ConnectionStatus };
  readonly writes: Array<[string, unknown]> = [];
  disconnectCalls = 0;
  private subjects = new Map<string, ReplaySubject<unknown>>();

  constructor() {
    StubUi.created.push(this);
  }

  private subj(path: string) {
    let s = this.subjects.get(path);
    if (!s) {
      s = new ReplaySubject<unknown>(1);
      this.subjects.set(path, s);
    }
    return s;
  }
  private local(path: string, v: unknown) {
    this.writes.push([path, v]);
    this.subj(path).next(v);
  }
  private channel(prefix: string) {
    return {
      faderLevelDB$: this.subj(`${prefix}.mix`),
      mute$: this.subj(`${prefix}.mute`),
      name$: this.subj(`${prefix}.name`),
      setFaderLevelDB: (v: number) => this.local(`${prefix}.mix`, v),
      setMute: (v: boolean) => this.local(`${prefix}.mute`, v),
    };
  }

  readonly master = {
    faderLevelDB$: this.subj('m.mix'),
    setFaderLevelDB: (v: number) => this.local('m.mix', v),
    input: (n: number) => this.channel(`i.${n}`),
  };
  aux(a: number) {
    return { input: (n: number) => this.channel(`i.${n}.aux.${a}`) };
  }

  connect() {
    return Promise.resolve();
  }
  /** Como na biblioteca, depois de uma queda a promessa pode nunca resolver. */
  disconnect() {
    this.disconnectCalls++;
    return new Promise<void>(() => undefined);
  }

  // ---------- controle do teste ----------

  emit(type: ConnectionStatus) {
    this.conn.status = type;
    this.status$.next({ type });
  }
  /** Valor vindo "da mesa". */
  feed(key: ParamKey, value: ParamValue) {
    this.subj(pathOf(key)).next(value);
  }
  feedAll(entries: Array<[ParamKey, ParamValue]>) {
    for (const [k, v] of entries) this.feed(k, v);
  }
  /** Assinaturas de parâmetros ainda ativas (devem ser 0 depois do descarte). */
  observers(): number {
    let n = 0;
    for (const s of this.subjects.values()) if (s.observed) n++;
    return n;
  }
}

function pathOf(key: ParamKey): string {
  const p = parseKey(key);
  if (p.kind === 'master') return 'm.mix';
  if (p.kind !== 'channel') throw new Error(`stub não suporta ${key}`);
  const prefix = p.aux ? `i.${p.channel}.aux.${p.aux}` : `i.${p.channel}`;
  return `${prefix}.${p.param === 'level' ? 'mix' : 'mute'}`;
}
