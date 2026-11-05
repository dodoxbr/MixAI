// Experimento (não é código de produção): comportamento da soundcraft-ui-connection 7.1.0
// quando a conexão com a mesa cai. Rodar na raiz do projeto: node docs/lab/spikes/reconexao.mjs
// Usa um WebSocket falso; não acessa rede nem mesa.
import { SoundcraftUI, ConnectionStatus } from '../../../node_modules/soundcraft-ui-connection/index.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const withTimeout = (p, ms) => Promise.race([p.then(() => 'ok'), sleep(ms).then(() => 'não resolveu')]);
const cmds = (s) => s.sent.filter((m) => m.includes('SETD'));

function fakeSocketClass(created) {
  return class FakeSocket {
    static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
    CONNECTING = 0; OPEN = 1; CLOSING = 2; CLOSED = 3;
    constructor() {
      this.readyState = 0; this.sent = []; created.push(this);
      setTimeout(() => { this.readyState = 1; this.onopen?.({}); }, 5);
    }
    send(m) { if (this.readyState !== 1) throw new Error('send em socket fechado'); this.sent.push(m); }
    close() { this.readyState = 3; this.onclose?.({ wasClean: true, code: 1000 }); }
    drop() { this.readyState = 3; this.onclose?.({ wasClean: false, code: 1006 }); }
  };
}

// 1) Comando dado DEPOIS que a biblioteca percebeu a queda: é guardado e reenviado na reconexão.
{
  const created = []; const ui = new SoundcraftUI({ targetIP: 'teste', webSocketCtor: fakeSocketClass(created) });
  const status = []; ui.status$.subscribe((e) => status.push(e.type));
  await ui.connect();
  ui.master.input(1).setFaderLevelDB(-10);
  created[0].drop();
  await sleep(50);
  ui.master.input(1).setFaderLevelDB(0);
  ui.master.input(2).setMute(true);
  await sleep(2600);
  console.log('1) reenvio após reconexão');
  console.log('   status:', status.join(' > '));
  console.log('   socket novo recebeu:', created[1] ? cmds(created[1]) : '(nenhum)');
  await withTimeout(ui.disconnect(), 500);
}

// 2) Comando dado NA JANELA da queda (socket já morto, status ainda OPEN): perde-se em silêncio.
{
  const created = []; const ui = new SoundcraftUI({ targetIP: 'teste', webSocketCtor: fakeSocketClass(created) });
  await ui.connect();
  created[0].readyState = 3;
  let erro = null;
  try { ui.master.input(1).setFaderLevelDB(-5); } catch (e) { erro = e.message; }
  created[0].drop();
  await sleep(2600);
  console.log('2) janela da queda');
  console.log('   erro devolvido ao chamador:', erro, '| socket velho:', cmds(created[0]), '| socket novo:', created[1] ? cmds(created[1]) : '(nenhum)');
  await withTimeout(ui.disconnect(), 500);
}

// 3) Estratégia: descartar a instância na primeira queda e criar outra.
{
  const created = []; const Fake = fakeSocketClass(created);
  const old = new SoundcraftUI({ targetIP: 'teste', webSocketCtor: Fake });
  await old.connect();
  created[0].drop();
  await sleep(20);
  const disc = withTimeout(old.disconnect(), 800);
  for (let i = 0; i < 3; i++) { old.master.input(1).setFaderLevelDB(-i); await sleep(1000); }
  const fresh = new SoundcraftUI({ targetIP: 'teste', webSocketCtor: Fake });
  await fresh.connect();
  await sleep(2600);
  console.log('3) descartar a instância');
  console.log('   disconnect() da instância velha:', await disc);
  console.log('   sockets criados:', created.length, '(2 = a velha não reconectou)');
  console.log('   socket da instância nova recebeu:', cmds(created.at(-1)));
  await withTimeout(fresh.disconnect(), 500);
}
process.exit(0);
