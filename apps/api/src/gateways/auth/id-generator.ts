import { randomUUID } from "node:crypto";
import type { IdGenerator } from "../../domain/identity/ports.js";

export function createIdGenerator(): IdGenerator {
  return { nextId: () => randomUUID() };
}
