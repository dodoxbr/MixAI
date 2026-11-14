import { Injectable, signal } from '@angular/core';

/** Estado de UI compartilhado entre a barra de estado e a área de ferramentas da mesa. Não fala com o servidor. */
@Injectable({ providedIn: 'root' })
export class ToolsService {
  /** Diálogo de configurações (IA, cadastro de canais/AUX). */
  readonly settingsOpen = signal(false);
}
