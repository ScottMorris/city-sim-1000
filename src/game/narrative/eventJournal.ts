import type { SimEvent } from './types';

export class EventJournal {
  private readonly capacity: number;
  private events: SimEvent[] = [];
  private nextIndex = 0;

  constructor(capacity = 200) {
    this.capacity = Math.max(1, capacity);
  }

  push(event: SimEvent) {
    if (this.events.length < this.capacity) {
      this.events.push(event);
      return;
    }
    this.events[this.nextIndex] = event;
    this.nextIndex = (this.nextIndex + 1) % this.capacity;
  }

  latest(count: number): SimEvent[] {
    const ordered = this.getOrderedEvents();
    if (count <= 0) return [];
    return ordered.slice(Math.max(0, ordered.length - count));
  }

  since(minTimestamp: number): SimEvent[] {
    const ordered = this.getOrderedEvents();
    return ordered.filter((event) => event.timestamp >= minTimestamp);
  }

  clear() {
    this.events = [];
    this.nextIndex = 0;
  }

  private getOrderedEvents(): SimEvent[] {
    if (this.events.length < this.capacity || this.nextIndex === 0) {
      return [...this.events];
    }
    return [...this.events.slice(this.nextIndex), ...this.events.slice(0, this.nextIndex)];
  }
}
