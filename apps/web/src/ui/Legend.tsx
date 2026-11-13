import { CAR_STYLES, LANE_COLORS, ROAD_COLORS, STATE_STYLES, type Shape } from "../render/palette.ts";
import { CarIcon } from "./ParkingPanels.tsx";
import { strings } from "../strings.ts";

function hex(n: number): string {
  return `#${n.toString(16).padStart(6, "0")}`;
}

/** Small SVG of an agent marker, matching the renderer's shapes. */
export function ShapeIcon({ shape, color, size = 12 }: { shape: Shape; color: string; size?: number }) {
  const r = 5;
  let el;
  switch (shape) {
    case "circle":
      el = <circle cx="6" cy="6" r={r} fill={color} />;
      break;
    case "square":
      el = <rect x="1.5" y="1.5" width="9" height="9" fill={color} />;
      break;
    case "diamond":
      el = <polygon points="6,0.5 11.5,6 6,11.5 0.5,6" fill={color} />;
      break;
    case "triangle":
      el = <polygon points="6,1 11,10.5 1,10.5" fill={color} />;
      break;
    case "cross":
      el = <path d="M2 2 L10 10 M10 2 L2 10" stroke={color} strokeWidth="2.5" />;
      break;
  }
  return (
    <svg aria-hidden="true" width={size} height={size} viewBox="0 0 12 12" className="inline-block shrink-0">
      {el}
    </svg>
  );
}

export function stateShape(state: number): { shape: Shape; css: string } | null {
  const s = STATE_STYLES.find((x) => x.state === state);
  return s ? { shape: s.shape, css: s.css } : null;
}

export function Legend({ heatmap, cars = false }: { heatmap: boolean; cars?: boolean }) {
  const L = strings.legend;
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-600 dark:text-slate-400" aria-label={L.heading}>
      {STATE_STYLES.map((s) => (
        <span key={s.state} className="inline-flex items-center gap-1">
          <ShapeIcon shape={s.shape} color={s.css} />
          {strings.states[s.key]}
          {s.key === "Inside" && ` ${L.insideFades}`}
        </span>
      ))}
      <span className="inline-flex items-center gap-1">
        <svg aria-hidden="true" width="12" height="12" viewBox="0 0 12 12">
          <rect x="2" y="2" width="8" height="8" fill={hex(LANE_COLORS.open)} />
        </svg>
        {L.laneOpen}
      </span>
      <span className="inline-flex items-center gap-1">
        <svg aria-hidden="true" width="12" height="12" viewBox="0 0 12 12">
          <rect x="2" y="2" width="8" height="8" fill="none" stroke={hex(LANE_COLORS.closed)} strokeWidth="1.5" />
        </svg>
        {L.laneClosed}
      </span>
      <span className="inline-flex items-center gap-1">
        <svg aria-hidden="true" width="12" height="12" viewBox="0 0 12 12">
          <path d="M2 2 L10 10 M10 2 L2 10" stroke={hex(LANE_COLORS.failed)} strokeWidth="2.5" />
        </svg>
        {L.laneFailed}
      </span>
      {cars &&
        CAR_STYLES.map((s) => (
          <span key={s.key} className="inline-flex items-center gap-1">
            <CarIcon shape={s.shape} color={s.css} />
            {L[s.key]}
          </span>
        ))}
      {cars && (
        <>
          <span className="inline-flex items-center gap-1">
            <svg aria-hidden="true" width="12" height="12" viewBox="0 0 12 12">
              <path d="M1 6 L11 6" stroke={hex(ROAD_COLORS.barrierBusy)} strokeWidth="3" />
              <circle cx="6" cy="6" r="2.5" fill={hex(ROAD_COLORS.barrierBusy)} />
            </svg>
            {L.barrierBusy}
          </span>
          <span className="inline-flex items-center gap-1">
            <svg aria-hidden="true" width="12" height="12" viewBox="0 0 12 12">
              <path d="M6 0 L6 12" stroke={hex(ROAD_COLORS.boundary)} strokeWidth="3" />
            </svg>
            {L.boundary}
          </span>
        </>
      )}
      {heatmap && (
        <span className="inline-flex items-center gap-1">
          <span aria-hidden="true" className="inline-block h-2.5 w-16 rounded-sm bg-linear-to-r from-[#ffffb2] via-[#fd8d3c] to-[#bd0026]" />
          {L.heatmap} 0.3–4+
        </span>
      )}
    </div>
  );
}
