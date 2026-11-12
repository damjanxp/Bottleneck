declare module "virtual:scenario-validator" {
  import type { SchemaError } from "../library/validate.ts";
  interface StandaloneValidate {
    (data: unknown): boolean;
    errors?: SchemaError[] | null;
  }
  export const validateScenario: StandaloneValidate;
}
