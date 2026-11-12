/**
 * React state for the user's scenario library (see library/storage.ts for the format). Loads once
 * on mount; once the schema validator chunk has loaded, entries that no longer match the schema are
 * dropped with a notice.
 */

import { useCallback, useEffect, useState } from "react";
import type { Scenario } from "@bottleneck/schema";
import { browserStorage, dropInvalid, loadLibrary, removeEntry, saveLibrary, upsertEntry, type DroppedEntry, type LibraryEntry } from "../library/storage.ts";
import { schemaMessages } from "../library/validate.ts";
import { loadScenarioValidator } from "../validation/loadValidator.ts";

export interface Library {
  entries: LibraryEntry[];
  dropped: DroppedEntry[];
  /** Storage unavailable or the last save failed. */
  error: string | null;
  save(scenario: Scenario): void;
  remove(id: string): void;
  dismissNotices(): void;
}

export function useLibrary(): Library {
  const [state, setState] = useState(() => {
    const r = loadLibrary(browserStorage());
    return { entries: r.entries, dropped: r.dropped, error: r.error };
  });

  // Full schema check of what was stored, once the validator chunk is there (only if anything is stored).
  const hasEntries = state.entries.length > 0;
  useEffect(() => {
    if (!hasEntries) return;
    let cancelled = false;
    loadScenarioValidator()
      .then((validate) => {
        if (cancelled) return;
        setState((s) => {
          const r = dropInvalid(browserStorage(), s.entries, (sc) => {
            const v = validate(sc);
            return v.ok ? null : `it no longer matches the scenario schema (${schemaMessages(v.errors)[0] ?? "invalid"})`;
          });
          return r.dropped.length === 0 ? s : { ...s, entries: r.entries, dropped: [...s.dropped, ...r.dropped] };
        });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [hasEntries]);

  const save = useCallback((scenario: Scenario) => {
    setState((s) => {
      const entries = upsertEntry(s.entries, scenario, new Date());
      return { ...s, entries, error: saveLibrary(browserStorage(), entries) };
    });
  }, []);

  const remove = useCallback((id: string) => {
    setState((s) => {
      const entries = removeEntry(s.entries, id);
      return { ...s, entries, error: saveLibrary(browserStorage(), entries) };
    });
  }, []);

  const dismissNotices = useCallback(() => setState((s) => ({ ...s, dropped: [], error: null })), []);

  return { ...state, save, remove, dismissNotices };
}
