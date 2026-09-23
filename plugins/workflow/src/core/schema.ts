/**
 * Validate a value against a declared JSON Schema.
 *
 * A structured agent reply is only useful if something enforces the shape, so
 * this is the enforcement point. TypeBox schemas are accepted directly through
 * their own `safeParse`, which is what a script writing `Type.Object(...)` gets;
 * plain JSON Schema goes through TypeBox's `Check`/`Errors`.
 *
 * Validation never throws for bad input. A schema that is itself malformed is
 * reported as a validation failure rather than an exception, because the caller
 * is a retry loop that wants to feed the reason back to the model — an exception
 * would abort the run instead of letting the model correct itself.
 */

// `typebox/value`, not `typebox/schema`: pi hands jiti an alias table where
// `typebox` is an entry *file* and only `typebox/compile` and `typebox/value`
// exist as subpaths, so `typebox/schema` is prefix-rewritten to
// `<entry>/schema` and the extension fails to load under pi. Both packages
// export `Check`/`Errors` over the same JSON Schema semantics, but
// `typebox/value` types them against TypeBox schemas, and `Errors` returns the
// error list alone rather than the leading boolean `typebox/schema` returned —
// hence the retyping and the non-destructuring call below.
import { Check, Errors } from "typebox/value";
import type { WorkflowJsonSchema } from "./types.ts";

const checkJsonSchema = Check as unknown as (schema: unknown, value: unknown) => boolean;
const jsonSchemaErrors = Errors as unknown as (
  schema: unknown,
  value: unknown,
) => ReadonlyArray<{ instancePath?: string; message: string }>;

export interface WorkflowSchemaResult {
  valid: boolean;
  errors: string[];
  /** The validated value; with `stripUnknown`, unknown object keys are removed. */
  value: unknown;
}

/**
 * Validate `value` against `schema`.
 *
 * `stripUnknown` removes object properties the schema does not declare. It is
 * off by default and on for agent replies, where a model that adds a stray key
 * should not fail a call whose declared fields are all correct.
 */
export function validateWorkflowSchema(schema: unknown, value: unknown, stripUnknown = false): WorkflowSchemaResult {
  if (isSafeParseSchema(schema)) {
    try {
      const parsed = schema.safeParse(value);
      return parsed.success
        ? { valid: true, errors: [], value: parsed.data }
        : { valid: false, errors: [formatUnknownError(parsed.error)], value };
    } catch (error: unknown) {
      return { valid: false, errors: [formatUnknownError(error)], value };
    }
  }
  // An absent schema, or one that is not a schema, asserts nothing and accepts
  // everything. `true` is valid JSON Schema for the same reason; `false` is the
  // schema that rejects everything and is handled by the checker below.
  if (typeof schema !== "boolean" && (!schema || typeof schema !== "object" || Array.isArray(schema))) {
    return { valid: true, errors: [], value };
  }
  try {
    const normalized = stripUnknown ? cleanUnknownProperties(schema as WorkflowJsonSchema, value) : value;
    if (checkJsonSchema(schema, normalized)) return { valid: true, errors: [], value: normalized };
    return {
      valid: false,
      errors: jsonSchemaErrors(schema, normalized).map((error) => `${error.instancePath || "$"} ${error.message}`),
      value: normalized,
    };
  } catch (error: unknown) {
    return { valid: false, errors: [formatUnknownError(error)], value };
  }
}

interface SafeParseSchema {
  safeParse(input: unknown): { success: boolean; data?: unknown; error?: unknown };
}

function isSafeParseSchema(value: unknown): value is SafeParseSchema {
  return !!value && typeof value === "object" && typeof (value as { safeParse?: unknown }).safeParse === "function";
}

/**
 * Recursively drop properties the schema does not declare.
 *
 * `additionalProperties` decides the default: `false` drops them, an object
 * schema validates them against that schema, and absent/`true` keeps them.
 * Only declared properties are recursed into, so an undeclared key that survives
 * is passed through untouched rather than validated against nothing.
 */
function cleanUnknownProperties(schema: WorkflowJsonSchema, value: unknown): unknown {
  if (Array.isArray(value)) {
    return schema.items ? value.map((item) => cleanUnknownProperties(schema.items!, item)) : value;
  }
  if (!value || typeof value !== "object") return value;
  const properties = schema.properties ?? {};
  const output = Object.create(null) as Record<string, unknown>;
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    const childSchema = properties[key];
    if (childSchema) output[key] = cleanUnknownProperties(childSchema, item);
    else if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
      output[key] = cleanUnknownProperties(schema.additionalProperties, item);
    } else if (schema.additionalProperties !== false) output[key] = item;
  }
  return output;
}

function formatUnknownError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return "Schema validation failed";
  }
}
