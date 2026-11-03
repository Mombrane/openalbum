import type { Clock } from "../../domain/identity/ports.js";

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}
