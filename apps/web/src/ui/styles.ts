/** Shared Tailwind class strings, so the later redesign changes them in one place. */

export const btn =
  "rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium shadow-sm hover:bg-slate-50 disabled:opacity-50 dark:border-slate-700 dark:bg-slate-900 dark:hover:bg-slate-800";
export const btnPrimary = "rounded-md bg-amber-500 px-4 py-1.5 text-sm font-semibold text-slate-950 shadow-sm hover:bg-amber-400 disabled:opacity-50";
export const btnSmall =
  "rounded-md border border-slate-300 bg-white px-2 py-0.5 text-xs font-semibold shadow-sm hover:bg-slate-50 disabled:opacity-50 dark:border-slate-700 dark:bg-slate-900 dark:hover:bg-slate-800";
export const card = "rounded-xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900";
export const input =
  "rounded-md border border-slate-300 bg-white px-2 py-1 text-sm text-slate-900 placeholder:text-slate-400 placeholder:italic dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100 dark:placeholder:text-slate-500";
export const labelText = "flex flex-col gap-1 text-xs text-slate-600 dark:text-slate-400";
/** Better/worse marking: colour plus a symbol and a word, never colour alone. */
export const verdictClass: Record<string, string> = {
  better: "text-emerald-700 dark:text-emerald-400",
  worse: "text-orange-700 dark:text-orange-400",
  same: "text-slate-500",
  unclear: "text-slate-500",
};
export const verdictSymbol: Record<string, string> = { better: "✓", worse: "✗", same: "=", unclear: "≈" };
