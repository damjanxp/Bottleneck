/**
 * Shared Tailwind class strings (redesign 1). Colours come from the semantic tokens in index.css
 * (surface, line, muted, accent…), so light and dark mode and later restyles change in one place.
 */

const focus = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";
const base = `inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md font-medium transition-colors disabled:pointer-events-none disabled:opacity-45 ${focus}`;

/** Secondary button: quiet, bordered. */
export const btn = `${base} h-8 border border-line bg-surface px-3 text-sm text-fg hover:border-line-strong hover:bg-sunken`;
/** The one main action in a group. */
export const btnPrimary = `${base} h-8 bg-accent px-3.5 text-sm font-semibold text-accent-fg shadow-sm hover:brightness-105`;
/** Small secondary button (tables, inline actions). */
export const btnSmall = `${base} h-6 border border-line bg-surface px-2 text-xs text-fg hover:border-line-strong hover:bg-sunken`;
/** Borderless button for toolbars and overlays. */
export const btnGhost = `${base} h-8 px-2.5 text-sm text-muted hover:bg-sunken hover:text-fg`;
/** Square icon button (give it an aria-label). */
export const btnIcon = `${base} size-8 text-muted hover:bg-sunken hover:text-fg`;

export const card = "rounded-xl border border-line bg-surface p-4";
/** A card's heading row. */
export const cardTitle = "text-sm font-semibold text-fg";
export const cardHint = "mt-1 text-xs leading-relaxed text-muted";

export const input = `h-8 rounded-md border border-line bg-surface px-2.5 text-sm text-fg placeholder:text-subtle hover:border-line-strong ${focus}`;
export const select = input;
export const labelText = "flex flex-col gap-1 text-xs font-medium text-muted";

/** Small rounded label: status, phase, counts. */
export const chip = "inline-flex items-center gap-1 rounded-full border border-line bg-sunken px-2 py-0.5 text-[11px] font-medium text-muted";

/**
 * Floating panels over the map. Nearly opaque and without backdrop blur: a blur over the animating
 * WebGL canvas would be recomposited every frame (expensive, especially without a GPU).
 */
export const overlay = "rounded-xl border border-line bg-surface/95 shadow-lg shadow-black/10 dark:shadow-black/40";

/** A page section (everything except the simulation's full-screen map). */
export const page = "mx-auto flex w-full max-w-6xl flex-col gap-5 px-6 py-6";
export const pageTitle = "text-xl font-semibold tracking-tight text-fg";
export const pageIntro = "mt-1 max-w-3xl text-sm leading-relaxed text-muted";

/** Notices. */
export const notice = "rounded-lg border px-3 py-2 text-sm";
export const noticeInfo = `${notice} border-info/30 bg-info-soft text-fg`;
export const noticeWarn = `${notice} border-warn/40 bg-warn-soft text-fg`;
export const noticeOk = `${notice} border-ok/30 bg-ok-soft text-fg`;

/** Tables. */
export const table = "w-full text-sm tabular";
export const th = "py-1.5 pr-2 text-left text-[11px] font-medium uppercase tracking-wide text-subtle";
export const td = "border-t border-line py-1.5 pr-2";

/** Better/worse marking: colour plus a symbol and a word, never colour alone. */
export const verdictClass: Record<string, string> = {
  better: "text-ok",
  worse: "text-bad",
  same: "text-subtle",
  unclear: "text-subtle",
};
export const verdictSymbol: Record<string, string> = { better: "✓", worse: "✗", same: "=", unclear: "≈" };
