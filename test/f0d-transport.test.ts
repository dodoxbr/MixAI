import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseObserverArgs, runF0Observer } from '../src/f0-observer-cli.js';
import { Ui16ReadOnlyObserver, type ObserverOptions } from '../src/mixer/readonly-observer.js';
import { exportObserverReport, parseObserverReport } from '../src/mixer/observer-report.js';
import { RouteDecisionSchema, type ObserverTransport } from '../src/mixer/observer-network.js';
import { isObserverReadFrame } from '../src/mixer/readonly-socket.js';
import { RealMixer } from '../src/mixer/real.js';
import { createFakeUi, stateMessages } from './support/fake-ui-socket.js';

let dir: string;
const sessions: Ui16ReadOnlyObserver[] = [];
const ip = '10.10.1.1'; // fixture; não há target default na aplicação
const common = ['--physical-readonly','--audio-disconnected','--ip',ip,'--channels','1','--duration','1'];
const wifi = [...common,'--transport','wifi','--confirm-wifi-ip',ip,'--confirm-soundcraft-hotspot','--interface-index','7'];
const ethernet = [...common,'--transport','ethernet','--confirm-ethernet-ip',ip,'--interface-index','8'];
beforeEach(() => {
  dir=mkdtempSync(join(tmpdir(),'mixai-f0d-'));
  vi.stubEnv('MIXAI_LOCK_DIR',join(dir,'locks'));
  vi.useFakeTimers({toFake:['setTimeout','clearTimeout','setInterval','clearInterval','Date']});
});
afterEach(async () => {
  await Promise.all(sessions.splice(0).map(s=>s.stop()));
  vi.restoreAllMocks();vi.unstubAllEnvs();vi.unstubAllGlobals();vi.useRealTimers();
  rmSync(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100});
});

it('mantém o formato Ethernet legado, sem deduzir Wi-Fi pelo IP do hotspot', () => {
  const parsed=parseObserverArgs([...common,'--confirm-ethernet-ip',ip]);
  expect(parsed).toMatchObject({transport:'ethernet',verifyRoute:false,interfaceIndex:undefined});
  expect(parseObserverArgs(wifi)).toMatchObject({transport:'wifi',verifyRoute:true,interfaceIndex:7});
  expect(parseObserverArgs(ethernet)).toMatchObject({transport:'ethernet',verifyRoute:true,interfaceIndex:8});
});
it.each([
  wifi.filter(x=>x!=='--confirm-soundcraft-hotspot'),
  [...wifi,'--confirm-ethernet-ip',ip],
  [...ethernet,'--confirm-wifi-ip',ip],
  [...ethernet,'--confirm-soundcraft-hotspot'],
  wifi.filter((_,i,a)=>a[i]!=='--interface-index'&&a[i-1]!=='--interface-index'),
  [...common,'--confirm-wifi-ip',ip,'--confirm-soundcraft-hotspot','--interface-index','7'],
  [...common,'--transport','auto','--confirm-ethernet-ip',ip,'--interface-index','8'],
  [...common,'--transport','wifi','--confirm-wifi-ip','192.168.50.1','--confirm-soundcraft-hotspot','--interface-index','7'],
].map(a=>[a]))('recusa confirmação cruzada, implícita ou ambígua: %j', a=>{
  expect(()=>parseObserverArgs(a)).toThrow();
});

for (const transport of ['wifi','ethernet'] as const) {
  describe(transport,()=>{
    it('usa o mesmo observador, valida cada reconexão e não envia escrita',async()=>{
      const write=vi.spyOn(RealMixer.prototype,'write'),load=vi.spyOn(RealMixer.prototype,'loadSnapshot');
      const fake=createFakeUi({autoOpen:false});
      const route=vi.fn(()=>true);
      const observer=new Ui16ReadOnlyObserver({source:'fake_websocket',webSocketCtor:fake.Ctor,transport,routeGuard:route,
        ip:'f0d.invalid',scope:{channels:[1],aux:[],master:false},appVersion:'0.7.0',durationMs:10_000,
        connectTimeoutMs:200,syncTimeoutMs:20,reconnectBaseMs:10,reconnectMaxDelayMs:20,clock:()=>Date.now()});
      sessions.push(observer);
      const start=observer.start();fake.last()!.open();fake.last()!.deliver(...stateMessages({channels:[1],aux:[]}));await start;
      for(let i=0;i<3;i++){
        const old=fake.last()!;old.drop();await vi.advanceTimersByTimeAsync(11);
        fake.last()!.open();fake.last()!.deliver(...stateMessages({channels:[1],aux:[]}));
        const count=observer.report().counters.parameter;
        old.deliver('SETD^i.0.mix^0');expect(observer.report().counters.parameter).toBe(count);
      }
      fake.last()!.deliver('SETD^i.0.mute^1');
      await vi.advanceTimersByTimeAsync(2600);await observer.stop();
      expect(route).toHaveBeenCalledTimes(4);expect(fake.sockets).toHaveLength(4);
      expect(fake.sockets.flatMap(s=>s.commands())).toEqual([]);
      expect(fake.sockets.flatMap(s=>s.sent).every(isObserverReadFrame)).toBe(true);
      expect(write).not.toHaveBeenCalled();expect(load).not.toHaveBeenCalled();
      expect(observer.report()).toMatchObject({schemaVersion:2,transport,routeCheck:'simulated',hardwareValidation:'pending'});
    });
    it('rota mudou para outro adaptador: encerra antes de abrir novo socket, sem failover',async()=>{
      const fake=createFakeUi({autoOpen:false});let allowed=true;
      const observer=new Ui16ReadOnlyObserver({source:'fake_websocket',webSocketCtor:fake.Ctor,transport,routeGuard:()=>allowed,
        ip:'f0d.invalid',scope:{channels:[1],aux:[],master:false},appVersion:'0.7.0',durationMs:10000,
        connectTimeoutMs:200,syncTimeoutMs:20,reconnectBaseMs:10,reconnectMaxDelayMs:20});sessions.push(observer);
      const start=observer.start();fake.last()!.open();fake.last()!.deliver(...stateMessages({channels:[1],aux:[]}));await start;
      allowed=false;fake.last()!.drop();await vi.advanceTimersByTimeAsync(11);await observer.done;
      expect(observer.report().stopReason).toBe('route_mismatch');
      await vi.advanceTimersByTimeAsync(3000);
      expect(fake.sockets).toHaveLength(1);expect(fake.alive()).toHaveLength(0);
      expect(fake.sockets.flatMap(s=>s.commands())).toEqual([]);
    });
    it('CLI físico é ensaiado com socket/rota falsos; metadados não revelam rede',async()=>{
      const internet=vi.fn(()=>{throw new Error('Internet indisponível');});vi.stubGlobal('fetch',internet);
      const fake=createFakeUi({initialState:()=>stateMessages({channels:[1],aux:[]})});vi.stubGlobal('WebSocket',fake.Ctor);
      const route=vi.fn((_ip:string,_mode:ObserverTransport,_index:number)=>true),lines:string[]=[];
      const prefix=join(dir,'evidence');
      const run=runF0Observer([...(transport==='wifi'?wifi:ethernet),'--report',prefix],{interactive:true,write:s=>lines.push(s),checkRoute:route});
      await vi.advanceTimersByTimeAsync(1100);expect(await run).toBe(0);
      expect(route).toHaveBeenCalledWith(ip,transport,transport==='wifi'?7:8);
      const text=readFileSync(prefix+'.json','utf8'),report=parseObserverReport(JSON.parse(text));
      expect(report).toMatchObject({schemaVersion:2,transport,routeCheck:'each_connection_gate'});
      expect(text+readFileSync(prefix+'.md','utf8')+lines.join('')).not.toMatch(/10\.10\.1\.1|SSID|MAC|password|senha|InterfaceIndex/);
      expect(fake.sockets.flatMap(s=>s.commands())).toEqual([]);
      expect(internet).not.toHaveBeenCalled();
    });
    it('rota recusada ou desconhecida não abre socket nem envia frames',async()=>{
      const fake=createFakeUi();vi.stubGlobal('WebSocket',fake.Ctor);
      const run=runF0Observer(transport==='wifi'?wifi:ethernet,{interactive:true,write:()=>undefined,checkRoute:()=>false});
      await vi.advanceTimersByTimeAsync(1);expect(await run).toBe(1);
      expect(fake.sockets).toHaveLength(0);expect(existsSync(join(dir,'locks','mesa-real.lock'))).toBe(false);
    });
  });
}

it('Wi-Fi no núcleo não aceita Ethernet como prova, nem confirmação de hotspot/rota ausentes',()=>{
  const base={source:'manual_device_stream',transport:'wifi',ip,scope:{channels:[1],aux:[],master:false},appVersion:'0.7.0',audioDisconnected:true};
  for(const extra of [{ethernetConfirmed:true},{ipConfirmed:true,routeGuard:()=>true},{ipConfirmed:true,hotspotConfirmed:true}]){
    expect(()=>new Ui16ReadOnlyObserver({...base,...extra} as unknown as ObserverOptions)).toThrow('F0C_MANUAL_GATE_REQUIRED');
  }
});
it('evidências v1 são lidas/exportadas sem inventar transporte; v2 é estrito',async()=>{
  const fake=createFakeUi({autoOpen:false});
  const observer=new Ui16ReadOnlyObserver({source:'fake_websocket',transport:'wifi',webSocketCtor:fake.Ctor,ip:'f0d.invalid',scope:{channels:[1],aux:[],master:false},appVersion:'0.7.0'});sessions.push(observer);
  await observer.stop();const report=observer.report();
  const legacy=JSON.parse(JSON.stringify(report));legacy.schemaVersion=1;delete legacy.transport;delete legacy.routeCheck;
  expect(parseObserverReport(legacy).schemaVersion).toBe(1);
  expect(exportObserverReport(legacy,'markdown')).toContain('não registrado (formato legado v1)');
  expect(JSON.parse(exportObserverReport(legacy,'json'))).not.toHaveProperty('transport');
  const bad={...report,transport:'auto',ip:'SECRET'};expect(()=>parseObserverReport(bad)).toThrow('F0C_INVALID_REPORT');
  expect(()=>parseObserverReport({...report,source:'manual_device_stream',transport:'wifi',routeCheck:'legacy_ethernet_declaration'})).toThrow('F0C_INVALID_REPORT');
});
it('decisão sanitizada rejeita inconsistências e campos de rede privados',()=>{
  const valid={schemaVersion:1,transport:'wifi',expectedInterfaceIndex:7,selectedInterfaceIndex:7,passed:true,reason:'ok'};
  expect(RouteDecisionSchema.safeParse(valid).success).toBe(true);
  for(const bad of [{...valid,selectedInterfaceIndex:9},{...valid,reason:'route_via_usb_tether'},{...valid,ip:'SECRET'},{...valid,ssid:'SECRET'}]){
    expect(RouteDecisionSchema.safeParse(bad).success).toBe(false);
  }
});
