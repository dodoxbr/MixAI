import { Component, ElementRef, afterRenderEffect, computed, effect, inject, signal, viewChild } from '@angular/core';
import { LiveService } from '../core/live.service';
import { SessionService } from '../core/session.service';
import { InstructorComponent } from './instructor.component';
/** A small entry point; UI, adapter and technical fixtures load only on demand. */
@Component({
 selector: 'mx-instructor-launcher',
 imports: [InstructorComponent],
 host: { style:'display:contents' },
 template: `@if (available()) {
   <button #trigger type="button" class="btn btn-ghost" aria-label="Instrutor Ui16 · LAB" [attr.aria-expanded]="open()" (click)="open.set(true)">Instrutor Ui16</button>
   @if (open()) { @defer (on immediate) { <mx-ui16-instructor [autostart]="true" (closed)="open.set(false)" /> } @placeholder { <span role="status">Abrindo instrutor…</span> } }
 }`,
})
export class InstructorLauncherComponent {
 private readonly live = inject(LiveService);
 private readonly session = inject(SessionService);
 readonly available = computed(() => !!this.session.token() && this.live.hello()?.mode === 'lab' && ['operator','musician'].includes(this.live.hello()?.role ?? ''));
 readonly open = signal(false);
 private readonly trigger = viewChild<ElementRef<HTMLButtonElement>>('trigger');
 constructor() {
   let opened = false, identity = '';
   effect(() => { const h = this.live.hello(); const next = JSON.stringify([this.session.token(),h?.serverId,h?.mode,h?.role]); if (next !== identity) { identity = next; this.open.set(false); } });
   afterRenderEffect(() => { const now = this.open(); if (opened && !now) this.trigger()?.nativeElement.focus(); opened = now; });
 }
}
