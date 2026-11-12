/**
 * Loads the build-time scenario validator (its own lazy chunk, see buildValidator.ts). Kept apart
 * from the pure validation code so Vitest never has to resolve the virtual module.
 */

import type { SchemaValidator } from "../library/validate.ts";

let pending: Promise<SchemaValidator> | null = null;

export function loadScenarioValidator(): Promise<SchemaValidator> {
  pending ??= import("virtual:scenario-validator").then((m) => (data: unknown) => {
    const ok = m.validateScenario(data);
    return { ok, errors: ok ? [] : (m.validateScenario.errors ?? []) };
  });
  return pending;
}
