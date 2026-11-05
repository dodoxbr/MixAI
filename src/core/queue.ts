/**
 * Fila única: executa as tarefas uma de cada vez, na ordem de chegada.
 * Toda escrita na mesa passa por aqui, então "ler, calcular e escrever" fica atômico para o MixAI.
 * Um erro numa tarefa é devolvido a quem a pediu e não trava as próximas.
 */
export class CommandQueue {
  private tail: Promise<void> = Promise.resolve();
  private pending = 0;

  run<T>(task: () => Promise<T>): Promise<T> {
    this.pending += 1;
    const result = this.tail.then(task);
    this.tail = result.then(
      () => {
        this.pending -= 1;
      },
      () => {
        this.pending -= 1;
      },
    );
    return result;
  }

  /** Quantas tarefas estão na fila ou executando. */
  size(): number {
    return this.pending;
  }
}
