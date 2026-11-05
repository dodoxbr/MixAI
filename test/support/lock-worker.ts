/**
 * Processo separado que tenta pegar a trava de dono (usado pelos testes de concorrência).
 * Uso: lock-worker <arquivo|real> <segurarMs> <largarEm(epoch ms)> [instalação]
 * Imprime ACQUIRED, REFUSED ou ERROR.
 */
import { OwnerLock, OwnerLockError, ownerLockFile } from '../../src/core/owner-lock.js';

const [target, holdMs, startAt, install] = process.argv.slice(2);
const file = target === 'real' ? ownerLockFile('real', 'nao-usado.json')! : target!;
while (Date.now() < Number(startAt)) {
  /* espera ativa: todos os processos tentam no mesmo instante */
}
try {
  const lock = new OwnerLock(file, 'teste', { install, equipment: 'mesa ui16 em 10.10.1.1' }).acquire(5000);
  process.stdout.write('ACQUIRED\n');
  setTimeout(() => {
    lock.release();
    process.exit(0);
  }, Number(holdMs));
} catch (err) {
  process.stdout.write(err instanceof OwnerLockError ? 'REFUSED\n' : `ERROR ${(err as Error).message}\n`);
  process.exit(0);
}
