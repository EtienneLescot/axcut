import { EventEmitter } from 'node:events';

export type ProjectEvent = {
  type: string;
  projectId: string;
  payload: Record<string, unknown>;
  createdAt: string;
};

export class EventBus {
  private readonly emitter = new EventEmitter();

  subscribe(projectId: string, listener: (event: ProjectEvent) => void): () => void {
    const eventName = this.eventName(projectId);
    this.emitter.on(eventName, listener);
    return () => {
      this.emitter.off(eventName, listener);
    };
  }

  emit(projectId: string, type: string, payload: Record<string, unknown> = {}): void {
    this.emitter.emit(this.eventName(projectId), {
      type,
      projectId,
      payload,
      createdAt: new Date().toISOString(),
    } satisfies ProjectEvent);
  }

  private eventName(projectId: string): string {
    return `project:${projectId}`;
  }
}
