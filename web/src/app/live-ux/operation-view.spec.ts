import { operationView } from './operation-view';
import type { Result } from '../core/protocol';
const result = (outcomes: string[], extra: Partial<Result> = {}): Result => ({ok:true,code:'OK',message:'Retorno do servidor',data:{changes:outcomes.map(outcome=>({outcome}))},...extra});
it('HTTP/business success without outcome never proves execution', () => {
  expect(operationView(undefined,'lab').state).toBe('reported');
  expect(operationView(result([]),'real').label).toContain('confirmação final não disponível');
});
it('distinguishes simulated application from a physical send and uncertain/partial results', () => {
  expect(operationView(result(['applied_simulated']),'lab').state).toBe('simulated');
  expect(operationView(result(['applied_simulated']),'real').state).toBe('reported');
  expect(operationView(result(['sent']),'real').label).toContain('sem confirmação física');
  expect(operationView(result(['sent','not_sent']),'real').state).toBe('uncertain');
  expect(operationView(result([], {code:'INDETERMINATE',ok:false})).state).toBe('uncertain');
  expect(operationView(result([], {code:'DENIED',ok:false})).state).toBe('refused');
  expect(operationView(result([], {code:'NEEDS_CONFIRMATION',ok:false})).state).toBe('pending');
});
