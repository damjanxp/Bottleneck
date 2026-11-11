/** Messages between the main thread and the engine worker. */

export type WorkerRequest = { type: "selfCheck" };

export type WorkerResponse =
  | {
      type: "selfCheckResult";
      hash: string;
      expected: string;
      matches: boolean;
      numbers: number;
      durationMs: number;
      engineVersion: string;
    }
  | { type: "error"; message: string };
