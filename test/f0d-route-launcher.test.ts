import { spawnSync } from 'node:child_process';
import { expect, it, vi } from 'vitest';
import { confirmWindowsObserverRoute } from '../src/mixer/observer-network.js';
vi.mock('node:child_process',()=>({spawnSync:vi.fn()}));
const decision={schemaVersion:1,transport:'wifi',expectedInterfaceIndex:7,selectedInterfaceIndex:7,passed:true,reason:'ok'};
function inWindows(fn:()=>void){
  const original=Object.getOwnPropertyDescriptor(process,'platform')!;
  Object.defineProperty(process,'platform',{value:'win32',configurable:true});
  try{fn();}finally{Object.defineProperty(process,'platform',original);vi.resetAllMocks();}
}
function output(value:unknown,status=0){vi.mocked(spawnSync).mockReturnValue({status,stdout:JSON.stringify(value),stderr:'SECRET_STDERR',error:undefined} as ReturnType<typeof spawnSync>);}
it('invoca somente consulta por argumentos, sem shell/admin/ExecutionPolicy bypass',()=>inWindows(()=>{
  output(decision);
  expect(confirmWindowsObserverRoute('/fixture','10.10.1.1','wifi',7)).toBe(true);
  const [command,args,opts]=vi.mocked(spawnSync).mock.calls[0]!;
  expect(command).toBe('powershell.exe');expect(args).toContain('-NoProfile');expect(args).toContain('-NonInteractive');expect(args).toContain('-File');
  expect(args).not.toContain('-ExecutionPolicy');expect(args).not.toContain('Bypass');
  expect(opts).toMatchObject({timeout:15000,maxBuffer:16384,stdio:['ignore','pipe','pipe']});
  expect(opts).not.toHaveProperty('shell');
}));
it('não aceita rota de outro transporte/interface, dados extras ou falha do processo',()=>inWindows(()=>{
  for(const [value,status] of [[{...decision,transport:'ethernet'},0],[{...decision,expectedInterfaceIndex:8,selectedInterfaceIndex:8},0],[{...decision,ip:'SECRET_IP'},0],[decision,1]] as const){
    output(value,status);expect(()=>confirmWindowsObserverRoute('/fixture','10.10.1.1','wifi',7)).toThrow(/^F0D_ROUTE_PREFLIGHT_FAILED$/);
  }
}));
it('recusa endereço/índice inválidos sem invocar PowerShell',()=>inWindows(()=>{
  for(const [ip,index] of [['8.8.8.8',7],['localhost',7],['10.10.1.1',0]] as const){
    expect(()=>confirmWindowsObserverRoute('/fixture',ip,'wifi',index)).toThrow('F0D_WINDOWS_ROUTE_CHECK_REQUIRED');
  }
  expect(spawnSync).not.toHaveBeenCalled();
}));
