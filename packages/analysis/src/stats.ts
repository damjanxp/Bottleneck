export interface Summary {
  n: number;
  mean: number;
  sd: number;
  /** Half-width of the two-sided 95% confidence interval of the mean (Student t); NaN for n < 2. */
  ci95HalfWidth: number;
}

/** Two-sided 95% Student t critical values for 1..30 degrees of freedom. */
const T95 = [
  12.7062, 4.3027, 3.1824, 2.7764, 2.5706, 2.4469, 2.3646, 2.306, 2.2622, 2.2281, 2.201, 2.1788, 2.1604, 2.1448, 2.1315, 2.1199, 2.1098, 2.1009, 2.093, 2.086,
  2.0796, 2.0739, 2.0687, 2.0639, 2.0595, 2.0555, 2.0518, 2.0484, 2.0452, 2.0423,
] as const;

/** Mean, sample standard deviation (n - 1) and 95% confidence half-width of the mean. */
export function summarise(values: readonly number[]): Summary {
  const n = values.length;
  if (n === 0) return { n, mean: NaN, sd: 0, ci95HalfWidth: NaN };
  let sum = 0;
  for (const v of values) sum += v;
  const mean = sum / n;
  if (n < 2) return { n, mean, sd: 0, ci95HalfWidth: NaN };
  let ss = 0;
  for (const v of values) ss += (v - mean) * (v - mean);
  const sd = Math.sqrt(ss / (n - 1));
  const t = n - 1 <= 30 ? (T95[n - 2] as number) : 1.96;
  return { n, mean, sd, ci95HalfWidth: (t * sd) / Math.sqrt(n) };
}
