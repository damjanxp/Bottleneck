import { useState, type ReactNode } from "react";
import { CAR_SHARE_DEFAULTS } from "@bottleneck/engine";
import type { Scenario, TimedEvent, Venue } from "@bottleneck/schema";
import {
  ARRIVAL_PRESETS,
  BAG_POLICIES,
  BARRIER_SERVICE_TYPES,
  DEPARTURE_PRESETS,
  EVENT_TYPES,
  OVERFLOW_RULES,
  PAYMENT_MODES,
  STALL_CHOICES,
  editTime,
  formToScenario,
  newEventForm,
  scenarioToForm,
  venueHasParking,
  type BarrierForm,
  type ElementForm,
  type EventForm,
  type LotForm,
  type Problem,
  type ScenarioForm,
  type ServiceMode,
  type TimeField,
} from "../library/form.ts";
import { venueElements } from "../library/scenarios.ts";
import { checkScenario } from "../library/validate.ts";
import { formatDistribution } from "../sim/format.ts";
import { strings } from "../strings.ts";
import { loadScenarioValidator } from "../validation/loadValidator.ts";
import { btn, btnPrimary, btnSmall, card, input, labelText } from "./styles.ts";

const E = strings.editor;

function Field({ label, children, wide }: { label: string; children: ReactNode; wide?: boolean }) {
  return (
    <label className={`${labelText} ${wide ? "sm:col-span-2" : ""}`}>
      {label}
      {children}
    </label>
  );
}

/** The scenario editor (spec 6.3). Works on a text form; validates against the JSON Schema before saving. */
export function ScenarioEditor({ venue, base: initialBase, isNew, onSave, onCancel }: { venue: Venue; base: Scenario; isNew: boolean; onSave: (s: Scenario) => void; onCancel: () => void }) {
  const [base, setBase] = useState(initialBase);
  const [form, setForm] = useState<ScenarioForm>(() => scenarioToForm(initialBase, venue));
  const [problems, setProblems] = useState<Problem[]>([]);
  const [checking, setChecking] = useState(false);
  const [json, setJson] = useState("");
  const [jsonError, setJsonError] = useState<string | null>(null);

  const set = <K extends keyof ScenarioForm>(key: K, value: ScenarioForm[K]) => setForm((f) => ({ ...f, [key]: value }));
  const setTime = (key: "gatesOpen" | "eventStart" | "eventEnd" | "horizon", text: string) => setForm((f) => ({ ...f, [key]: editTime(f[key], text) }));
  const setElement = (id: string, patch: Partial<ElementForm>) => setForm((f) => ({ ...f, elements: f.elements.map((e) => (e.id === id ? { ...e, ...patch } : e)) }));
  const setBarrier = (id: string, patch: Partial<BarrierForm>) => setForm((f) => ({ ...f, barriers: f.barriers.map((b) => (b.id === id ? { ...b, ...patch } : b)) }));
  const setLot = (id: string, patch: Partial<LotForm>) => setForm((f) => ({ ...f, lots: f.lots.map((l) => (l.id === id ? { ...l, ...patch } : l)) }));
  const setEvent = (key: number, patch: Partial<EventForm>) => setForm((f) => ({ ...f, events: f.events.map((e) => (e.key === key ? { ...e, ...patch } : e)) }));
  const bad = (field: string) => problems.some((p) => p.field === field || p.field.startsWith(`${field}.`));
  const cls = (field: string) => `${input} ${bad(field) ? "border-orange-500 ring-1 ring-orange-500" : ""}`;

  const save = async () => {
    const r = formToScenario(form, base, venue);
    if (!r.scenario) {
      setProblems(r.problems);
      return;
    }
    setChecking(true);
    try {
      const validate = await loadScenarioValidator();
      const found = checkScenario(r.scenario, venue, validate);
      setProblems(found);
      if (found.length === 0) onSave(r.scenario);
    } finally {
      setChecking(false);
    }
  };

  const applyJson = () => {
    try {
      const parsed = JSON.parse(json) as Scenario;
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed) || typeof parsed.timeline !== "object") throw new Error("not a scenario object");
      const next = { ...parsed, id: base.id, venueId: venue.id ?? parsed.venueId };
      setBase(next);
      setForm(scenarioToForm(next, venue));
      setJsonError(null);
      setProblems([]);
    } catch (e) {
      setJsonError(`${E.jsonInvalid} ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const groups = venueElements(venue);
  const parking = venueHasParking(venue);
  const lotsOfVenue = venue.parkingLots ?? [];
  const timeInput = (key: "gatesOpen" | "eventStart" | "eventEnd" | "horizon", label: string, f: TimeField, disabled = false) => (
    <Field label={label}>
      <input className={cls(key)} inputMode="decimal" value={f.text} disabled={disabled} onChange={(e) => setTime(key, e.target.value)} />
    </Field>
  );

  return (
    <section className={`${card} flex flex-col gap-4`} aria-labelledby="editor-heading">
      <h2 id="editor-heading" className="text-lg font-semibold">
        {isNew ? E.headingNew : E.headingEdit}: {form.name || "…"}
      </h2>

      <fieldset className="grid gap-3 sm:grid-cols-4">
        <legend className="mb-1 text-sm font-semibold">{E.general}</legend>
        <Field label={E.name} wide>
          <input className={cls("name")} value={form.name} maxLength={120} onChange={(e) => set("name", e.target.value)} />
        </Field>
        <Field label={E.eventType}>
          <select
            className={cls("eventType")}
            value={form.eventType}
            onChange={(e) => {
              const t = e.target.value as ScenarioForm["eventType"];
              // A fair is open-door; the others have a fixed start.
              setForm((f) => ({ ...f, eventType: t, fixedStart: t !== "fair" }));
            }}
          >
            {EVENT_TYPES.map((t) => (
              <option key={t} value={t}>
                {E.eventTypes[t]}
              </option>
            ))}
          </select>
        </Field>
        <Field label={E.attendance}>
          <input className={cls("attendance")} inputMode="numeric" value={form.attendance} onChange={(e) => set("attendance", e.target.value)} />
        </Field>
        <Field label={E.arrivals}>
          <select className={cls("arrivalPreset")} value={form.arrivalPreset} onChange={(e) => set("arrivalPreset", e.target.value as ScenarioForm["arrivalPreset"])}>
            {ARRIVAL_PRESETS.map((p) => (
              <option key={p} value={p}>
                {E.presets[p]}
              </option>
            ))}
          </select>
        </Field>
        {form.customPoints > 0 && form.keepCustomPoints && (
          <p className="text-xs text-slate-600 sm:col-span-2 dark:text-slate-400">
            {E.customPoints(form.customPoints)}{" "}
            <button type="button" className="underline" onClick={() => setForm((f) => ({ ...f, keepCustomPoints: false, arrivalPreset: f.arrivalPreset === "custom" ? (f.eventType === "fair" ? "fair" : f.eventType) : f.arrivalPreset }))}>
              {E.removePoints}
            </button>
          </p>
        )}
        <Field label={E.seed}>
          <input className={cls("seed")} inputMode="numeric" value={form.seed} onChange={(e) => set("seed", e.target.value)} />
        </Field>
        <Field label={E.carShare}>
          <input className={cls("carSharePercent")} inputMode="decimal" value={form.carSharePercent} onChange={(e) => set("carSharePercent", e.target.value)} />
        </Field>
        <p className="self-end text-xs text-slate-600 sm:col-span-2 dark:text-slate-400">
          {parking ? (
            <>
              {E.carShareHint(E.eventTypes[form.eventType].toLowerCase(), Math.round(CAR_SHARE_DEFAULTS[form.eventType] * 100))}{" "}
              <button type="button" className="underline" onClick={() => set("carSharePercent", String(Math.round(CAR_SHARE_DEFAULTS[form.eventType] * 100)))}>
                {E.carShareUse}
              </button>
            </>
          ) : (
            E.carShareNoParking
          )}
        </p>
        <Field label={E.departures}>
          <select className={cls("departurePreset")} value={form.departurePreset} onChange={(e) => set("departurePreset", e.target.value as ScenarioForm["departurePreset"])}>
            <option value="">{E.departuresNone}</option>
            {DEPARTURE_PRESETS.filter((p) => p !== "custom" || (form.departureCustomPoints > 0 && form.keepDeparturePoints)).map((p) => (
              <option key={p} value={p}>
                {E.departurePresets[p]}
              </option>
            ))}
          </select>
        </Field>
      </fieldset>

      {parking && (
        <fieldset className="grid gap-3 sm:grid-cols-4">
          <legend className="mb-1 text-sm font-semibold">{E.vehicles}</legend>
          <Field label={E.occupancy} wide>
            <input className={cls("occupancy")} placeholder="0.35, 0.35, 0.18, 0.12" value={form.occupancy} onChange={(e) => set("occupancy", e.target.value)} />
          </Field>
          {(
            [
              ["cardSharePercent", E.cardShare, "70"],
              ["carExitDelay", E.carExitDelay, "20"],
              ["carBoardDelay", E.carBoardDelay, "20"],
              ["carLength", E.carLength, "4.5"],
              ["carGap", E.carGap, "2.5"],
              ["aisleSpeed", E.aisleSpeed, "8"],
              ["parkManoeuvre", E.parkManoeuvre, "6"],
            ] as const
          ).map(([key, label, placeholder]) => (
            <Field key={key} label={label}>
              <input className={cls(key)} inputMode="decimal" placeholder={placeholder} value={form[key]} onChange={(e) => set(key, e.target.value)} />
            </Field>
          ))}
        </fieldset>
      )}

      {form.barriers.length > 0 && (
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-sm font-semibold">{E.barriers}</legend>
          <p className="text-xs text-slate-500">{E.barriersIntro}</p>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-xs text-slate-500">
                <tr>
                  <th className="py-1 pr-2 font-normal">{E.barrier}</th>
                  <th className="py-1 pr-2 font-normal">{E.laneCount}</th>
                  <th className="py-1 pr-2 font-normal">{E.serviceType}</th>
                  <th className="py-1 font-normal">{E.misread}</th>
                </tr>
              </thead>
              <tbody>
                {form.barriers.map((b) => {
                  const vb = venue.vehicleBarriers?.find((x) => x.id === b.id);
                  const f = `barriers.${b.id}`;
                  return (
                    <tr key={b.id} className="border-t border-slate-100 dark:border-slate-800">
                      <td className="py-1 pr-2">
                        {b.name} <span className="text-xs text-slate-500">({b.kind === "entry" ? strings.barriers.entry : strings.barriers.exit})</span>
                      </td>
                      <td className="py-1 pr-2">
                        <input className={`${cls(`${f}.laneCount`)} w-16`} inputMode="numeric" placeholder={String(vb?.laneCount ?? "")} aria-label={`${b.name}: ${E.laneCount}`} value={b.laneCount} onChange={(e) => setBarrier(b.id, { laneCount: e.target.value })} />
                      </td>
                      <td className="py-1 pr-2">
                        <select className={input} aria-label={`${b.name}: ${E.serviceType}`} value={b.serviceType} onChange={(e) => setBarrier(b.id, { serviceType: e.target.value as BarrierForm["serviceType"] })}>
                          <option value="">
                            {E.venueValue} ({vb ? strings.parameters.serviceTypes[vb.serviceType] : "–"})
                          </option>
                          {BARRIER_SERVICE_TYPES.map((t) => (
                            <option key={t} value={t}>
                              {strings.parameters.serviceTypes[t]}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td className="py-1">
                        <input className={`${cls(`${f}.misreadPercent`)} w-16`} inputMode="decimal" placeholder={vb?.misread ? String(vb.misread.rate * 100) : "5"} aria-label={`${b.name}: ${E.misread}`} value={b.misreadPercent} onChange={(e) => setBarrier(b.id, { misreadPercent: e.target.value })} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </fieldset>
      )}

      {form.lots.length > 0 && (
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-sm font-semibold">{E.lots}</legend>
          <p className="text-xs text-slate-500">{E.lotsIntro}</p>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-xs text-slate-500">
                <tr>
                  <th className="py-1 pr-2 font-normal">{E.lot}</th>
                  <th className="py-1 pr-2 font-normal">{E.paymentMode}</th>
                  <th className="py-1 pr-2 font-normal">{E.stallChoice}</th>
                  <th className="py-1 font-normal">{E.overflow}</th>
                </tr>
              </thead>
              <tbody>
                {form.lots.map((l) => {
                  const vl = venue.parkingLots?.find((x) => x.id === l.id);
                  const venueText = (v: string | undefined) => `${E.venueValue}${v ? ` (${v})` : ""}`;
                  return (
                    <tr key={l.id} className="border-t border-slate-100 align-top dark:border-slate-800">
                      <td className="py-1 pr-2">{l.name}</td>
                      <td className="py-1 pr-2">
                        <select className={input} aria-label={`${l.name}: ${E.paymentMode}`} value={l.paymentMode} onChange={(e) => setLot(l.id, { paymentMode: e.target.value as LotForm["paymentMode"] })}>
                          <option value="">{venueText(vl?.paymentMode ? strings.parameters.paymentModes[vl.paymentMode] : undefined)}</option>
                          {PAYMENT_MODES.map((m) => (
                            <option key={m} value={m}>
                              {strings.parameters.paymentModes[m]}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td className="py-1 pr-2">
                        <select className={input} aria-label={`${l.name}: ${E.stallChoice}`} value={l.stallChoice} onChange={(e) => setLot(l.id, { stallChoice: e.target.value as LotForm["stallChoice"] })}>
                          <option value="">{venueText(vl?.stallChoice ? strings.parameters.stallChoices[vl.stallChoice] : undefined)}</option>
                          {STALL_CHOICES.map((m) => (
                            <option key={m} value={m}>
                              {strings.parameters.stallChoices[m]}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td className="py-1">
                        <div className="flex flex-wrap gap-1">
                          <select className={input} aria-label={`${l.name}: ${E.overflow}`} value={l.overflowRule} onChange={(e) => setLot(l.id, { overflowRule: e.target.value as LotForm["overflowRule"], divertTo: l.divertTo || (form.lots.find((x) => x.id !== l.id)?.id ?? "") })}>
                            <option value="">{venueText(vl?.overflow ? strings.parameters.overflowRules[vl.overflow.rule] : undefined)}</option>
                            {OVERFLOW_RULES.filter((r) => r !== "divert" || form.lots.length > 1).map((r) => (
                              <option key={r} value={r}>
                                {strings.parameters.overflowRules[r]}
                              </option>
                            ))}
                          </select>
                          {l.overflowRule === "divert" && (
                            <select className={cls(`lots.${l.id}.divertTo`)} aria-label={`${l.name}: ${E.divertTo}`} value={l.divertTo} onChange={(e) => setLot(l.id, { divertTo: e.target.value })}>
                              {form.lots
                                .filter((x) => x.id !== l.id)
                                .map((x) => (
                                  <option key={x.id} value={x.id}>
                                    {x.name}
                                  </option>
                                ))}
                            </select>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </fieldset>
      )}

      <fieldset className="grid gap-3 sm:grid-cols-4">
        <legend className="mb-1 text-sm font-semibold">{E.timeline}</legend>
        <p className="text-xs text-slate-500 sm:col-span-4">{E.timelineIntro}</p>
        <Field label={E.referenceClock}>
          <input className={cls("referenceClock")} value={form.referenceClock} onChange={(e) => set("referenceClock", e.target.value)} />
        </Field>
        <label className="flex items-center gap-2 self-end text-sm">
          <input type="checkbox" checked={form.fixedStart} onChange={(e) => set("fixedStart", e.target.checked)} />
          {E.fixedStart}
        </label>
        {timeInput("gatesOpen", E.gatesOpen, form.gatesOpen)}
        {timeInput("eventStart", E.eventStart, form.eventStart, !form.fixedStart)}
        {timeInput("eventEnd", E.eventEnd, form.eventEnd)}
        {timeInput("horizon", E.horizon, form.horizon)}
      </fieldset>

      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-sm font-semibold">{E.elements}</legend>
        <p className="text-xs text-slate-500">{E.elementsIntro}</p>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="text-xs text-slate-500">
              <tr>
                <th className="py-1 pr-2 font-normal">{E.element}</th>
                <th className="py-1 pr-2 font-normal">{E.laneCount}</th>
                <th className="py-1 pr-2 font-normal">{E.serviceTime}</th>
                <th className="py-1 font-normal">{E.scanFailure}</th>
              </tr>
            </thead>
            <tbody>
              {form.elements.map((el) => {
                const v = groups.find((g) => g.id === el.id);
                const f = `elements.${el.id}`;
                return (
                  <tr key={el.id} className="border-t border-slate-100 align-top dark:border-slate-800">
                    <td className="py-1 pr-2">{el.name}</td>
                    <td className="py-1 pr-2">
                      <input className={`${cls(`${f}.laneCount`)} w-16`} inputMode="numeric" placeholder={String(v?.laneCount ?? "")} aria-label={`${el.name}: ${E.laneCount}`} value={el.laneCount} onChange={(e) => setElement(el.id, { laneCount: e.target.value })} />
                    </td>
                    <td className="py-1 pr-2">
                      <div className="flex flex-wrap items-center gap-1">
                        <select className={input} aria-label={`${el.name}: ${E.serviceTime}`} value={el.serviceMode} onChange={(e) => setElement(el.id, { serviceMode: e.target.value as ServiceMode })}>
                          {(["default", "simple", "json"] as const).map((m) => (
                            <option key={m} value={m}>
                              {E.serviceModes[m]}
                            </option>
                          ))}
                        </select>
                        {el.serviceMode === "default" && v && <span className="text-xs text-slate-500">{formatDistribution(v.serviceTime, "s")}</span>}
                        {el.serviceMode === "simple" && (
                          <>
                            <input className={`${cls(`${f}.serviceMin`)} w-16`} inputMode="decimal" aria-label={`${el.name}: ${E.min}`} value={el.serviceMin} onChange={(e) => setElement(el.id, { serviceMin: e.target.value })} />
                            <span className="text-xs">{E.min} +</span>
                            <input className={`${cls(`${f}.serviceMean`)} w-16`} inputMode="decimal" aria-label={`${el.name}: ${E.mean}`} value={el.serviceMean} onChange={(e) => setElement(el.id, { serviceMean: e.target.value })} />
                            <span className="text-xs">{E.mean},</span>
                            <input className={`${cls(`${f}.serviceSigma`)} w-14`} inputMode="decimal" aria-label={`${el.name}: ${E.sigma}`} value={el.serviceSigma} onChange={(e) => setElement(el.id, { serviceSigma: e.target.value })} />
                            <span className="text-xs">{E.sigma}</span>
                          </>
                        )}
                        {el.serviceMode === "json" && (
                          <textarea className={`${cls(`${f}.serviceJson`)} w-full font-mono text-xs`} rows={2} aria-label={`${el.name}: ${E.serviceModes.json}`} value={el.serviceJson} onChange={(e) => setElement(el.id, { serviceJson: e.target.value })} />
                        )}
                      </div>
                    </td>
                    <td className="py-1">
                      {el.kind === "gate" ? (
                        <input
                          className={`${cls(`${f}.scanFailurePercent`)} w-16`}
                          inputMode="decimal"
                          placeholder={v?.scanFailureRate !== null && v?.scanFailureRate !== undefined ? String(v.scanFailureRate * 100) : ""}
                          aria-label={`${el.name}: ${E.scanFailure}`}
                          value={el.scanFailurePercent}
                          onChange={(e) => setElement(el.id, { scanFailurePercent: e.target.value })}
                        />
                      ) : (
                        <span className="text-xs text-slate-400">–</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </fieldset>

      <fieldset className="grid gap-3 sm:grid-cols-4">
        <legend className="mb-1 text-sm font-semibold">{E.parameters}</legend>
        {form.walking ? (
          <>
            <Field label={E.walkingMean}>
              <input className={cls("walking.mean")} inputMode="decimal" placeholder="1.3" value={form.walking.mean} onChange={(e) => set("walking", { mean: e.target.value, sd: form.walking?.sd ?? "" })} />
            </Field>
            <Field label={E.walkingSd}>
              <input className={cls("walking.sd")} inputMode="decimal" placeholder="0.25" value={form.walking.sd} onChange={(e) => set("walking", { mean: form.walking?.mean ?? "", sd: e.target.value })} />
            </Field>
          </>
        ) : (
          <p className="text-xs text-slate-500 sm:col-span-2">{E.walkingAdvanced}</p>
        )}
        <Field label={E.nearestShare}>
          <input className={cls("nearestLaneSharePercent")} inputMode="decimal" placeholder="30" value={form.nearestLaneSharePercent} onChange={(e) => set("nearestLaneSharePercent", e.target.value)} />
        </Field>
        <Field label={E.groupSizes}>
          <input className={cls("groupSizes")} placeholder="0.3, 0.4, 0.15, 0.1, 0.05" value={form.groupSizes} onChange={(e) => set("groupSizes", e.target.value)} />
        </Field>
        <Field label={E.bagPolicy}>
          <select className={input} value={form.bagPolicy} onChange={(e) => set("bagPolicy", e.target.value as ScenarioForm["bagPolicy"])}>
            <option value="">{E.bagPolicyDefault}</option>
            {BAG_POLICIES.map((b) => (
              <option key={b} value={b}>
                {strings.parameters.bagPolicies[b]}
              </option>
            ))}
          </select>
        </Field>
        <Field label={E.decisionDistance}>
          <input className={cls("decisionDistance")} inputMode="decimal" placeholder="20" value={form.decisionDistance} onChange={(e) => set("decisionDistance", e.target.value)} />
        </Field>
        <Field label={E.logitScale}>
          <input className={cls("logitScale")} inputMode="decimal" placeholder="15" value={form.logitScale} onChange={(e) => set("logitScale", e.target.value)} />
        </Field>
        <Field label={E.jockeyThreshold}>
          <input className={cls("jockeyThreshold")} inputMode="numeric" placeholder="3" value={form.jockeyThreshold} onChange={(e) => set("jockeyThreshold", e.target.value)} />
        </Field>
      </fieldset>

      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-sm font-semibold">{E.events}</legend>
        <p className="text-xs text-slate-500">{E.eventsIntro}</p>
        {form.events.length === 0 && <p className="text-sm text-slate-500">{E.noEvents}</p>}
        {form.events.map((ev) => (
          <div key={ev.key} className="flex flex-wrap items-end gap-2 border-t border-slate-100 pt-2 dark:border-slate-800">
            <Field label={strings.editor.eventType}>
              <select className={input} value={ev.kind} onChange={(e) => setEvent(ev.key, { kind: e.target.value as TimedEvent["kind"] })}>
                {(lotsOfVenue.length > 0 ? (["laneFail", "laneReopen", "busBurst", "lotClose"] as const) : (["laneFail", "laneReopen", "busBurst"] as const)).map((k) => (
                  <option key={k} value={k}>
                    {E.eventKinds[k]}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={E.at}>
              <input className={`${cls(`events.${ev.key}.at`)} w-24`} inputMode="decimal" value={ev.at.text} onChange={(e) => setEvent(ev.key, { at: editTime(ev.at, e.target.value) })} />
            </Field>
            {ev.kind === "busBurst" ? (
              <>
                <Field label={E.source}>
                  <select className={cls(`events.${ev.key}.sourceId`)} value={ev.sourceId} onChange={(e) => setEvent(ev.key, { sourceId: e.target.value })}>
                    {venue.sources.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label={E.count}>
                  <input className={`${cls(`events.${ev.key}.count`)} w-20`} inputMode="numeric" value={ev.count} onChange={(e) => setEvent(ev.key, { count: e.target.value })} />
                </Field>
              </>
            ) : ev.kind === "lotClose" ? (
              <Field label={E.lotChoice}>
                <select className={cls(`events.${ev.key}.groupId`)} value={ev.groupId} onChange={(e) => setEvent(ev.key, { groupId: e.target.value })}>
                  {lotsOfVenue.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.name}
                    </option>
                  ))}
                </select>
              </Field>
            ) : (
              <>
                <Field label={E.group}>
                  <select className={cls(`events.${ev.key}.groupId`)} value={ev.groupId} onChange={(e) => setEvent(ev.key, { groupId: e.target.value })}>
                    {groups.map((g) => (
                      <option key={g.id} value={g.id}>
                        {g.name}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label={E.lane}>
                  <input className={`${cls(`events.${ev.key}.laneNumber`)} w-16`} inputMode="numeric" value={ev.laneNumber} onChange={(e) => setEvent(ev.key, { laneNumber: e.target.value })} />
                </Field>
              </>
            )}
            <button type="button" className={btnSmall} onClick={() => setForm((f) => ({ ...f, events: f.events.filter((x) => x.key !== ev.key) }))}>
              {E.remove}
            </button>
          </div>
        ))}
        <div className="flex flex-wrap gap-2">
          {(
            [
              ["laneFail", E.addFail],
              ["laneReopen", E.addReopen],
              ["busBurst", E.addBurst],
              ...(lotsOfVenue.length > 0 ? ([["lotClose", E.addLotClose]] as const) : []),
            ] as const
          ).map(([kind, text]) => (
            <button key={kind} type="button" className={btnSmall} onClick={() => setForm((f) => ({ ...f, events: [...f.events, newEventForm(kind, venue, f.fixedStart ? (f.gatesOpen.seconds ?? 0) + 1800 : 1800)] }))}>
              {text}
            </button>
          ))}
        </div>
      </fieldset>

      <details
        className="text-sm"
        onToggle={(e) => {
          if ((e.target as HTMLDetailsElement).open) {
            const r = formToScenario(form, base, venue);
            setJson(JSON.stringify(r.scenario ?? base, null, 2));
          }
        }}
      >
        <summary className="cursor-pointer text-slate-600 dark:text-slate-400">{E.json}</summary>
        <textarea className={`${input} mt-2 h-64 w-full font-mono text-xs`} value={json} onChange={(e) => setJson(e.target.value)} aria-label={E.json} />
        <button type="button" className={`${btnSmall} mt-1`} onClick={applyJson}>
          {E.applyJson}
        </button>
        {jsonError && <p className="mt-1 text-xs text-orange-700 dark:text-orange-400">{jsonError}</p>}
      </details>

      {problems.length > 0 && (
        <div className="rounded-lg border border-orange-300 bg-orange-50 p-3 text-sm dark:border-orange-500/40 dark:bg-orange-500/10" role="alert">
          <p className="font-medium">{E.problems}</p>
          <ul className="ml-5 list-disc">
            {problems.map((p, k) => (
              <li key={k}>{p.message}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="flex gap-2">
        <button type="button" className={btnPrimary} onClick={() => void save()} disabled={checking}>
          {checking ? E.validating : E.save}
        </button>
        <button type="button" className={btn} onClick={onCancel}>
          {E.cancel}
        </button>
      </div>
    </section>
  );
}
