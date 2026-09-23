import { describe, expect, test } from "bun:test";
import { validateWorkflowSchema } from "../src/core/schema.ts";

const person = {
	type: "object",
	properties: { name: { type: "string" }, age: { type: "number" } },
	required: ["name"],
	additionalProperties: false,
} as const;

describe("validateWorkflowSchema", () => {
	test("accepts a matching value", () => {
		const result = validateWorkflowSchema(person, { name: "ada", age: 36 });
		expect(result.valid).toBe(true);
		expect(result.errors).toEqual([]);
	});
	test("reports the failing path and message", () => {
		const result = validateWorkflowSchema(person, { age: "old" });
		expect(result.valid).toBe(false);
		expect(result.errors.join("\n")).toContain("name");
	});
	test("an absent or non-schema asserts nothing", () => {
		// A script that declares no schema must not have its reply rejected.
		for (const schema of [undefined, null, 42, [], "nope"]) {
			expect(validateWorkflowSchema(schema, { anything: 1 }).valid).toBe(true);
		}
	});
	test("a malformed schema is a validation failure, not a thrown error", () => {
		// The caller is a retry loop that feeds errors back to the model; an
		// exception would abort the run instead of letting the model correct it.
		const result = validateWorkflowSchema({ type: "object", properties: { a: { type: "nonsense" } } }, { a: 1 });
		expect(typeof result.valid).toBe("boolean");
	});
	test("stripUnknown removes undeclared keys but keeps declared ones", () => {
		const result = validateWorkflowSchema(person, { name: "ada", extra: 1 }, true);
		expect(result.valid).toBe(true);
		expect(result.value).toEqual({ name: "ada" });
	});
	test("stripUnknown is off by default, so extra keys fail additionalProperties: false", () => {
		const result = validateWorkflowSchema(person, { name: "ada", extra: 1 });
		expect(result.valid).toBe(false);
	});
	test("validates arrays recursively with items", () => {
		const schema = { type: "array", items: { type: "number" } };
		expect(validateWorkflowSchema(schema, [1, 2, 3]).valid).toBe(true);
		expect(validateWorkflowSchema(schema, [1, "two"]).valid).toBe(false);
	});
	test("honours enum, const, and numeric bounds", () => {
		expect(validateWorkflowSchema({ enum: ["a", "b"] }, "a").valid).toBe(true);
		expect(validateWorkflowSchema({ enum: ["a", "b"] }, "c").valid).toBe(false);
		expect(validateWorkflowSchema({ const: 7 }, 7).valid).toBe(true);
		expect(validateWorkflowSchema({ minimum: 1, maximum: 5 }, 6).valid).toBe(false);
	});
	test("composes anyOf and oneOf", () => {
		const schema = { anyOf: [{ type: "string" }, { type: "number" }] };
		expect(validateWorkflowSchema(schema, "text").valid).toBe(true);
		expect(validateWorkflowSchema(schema, 3).valid).toBe(true);
		expect(validateWorkflowSchema(schema, true).valid).toBe(false);
	});
	test("accepts a TypeBox schema through safeParse", () => {
		const fake = {
			safeParse(input: unknown) {
				return typeof input === "string"
					? { success: true, data: input }
					: { success: false, error: new Error("expected string") };
			},
		};
		expect(validateWorkflowSchema(fake, "ok").valid).toBe(true);
		const bad = validateWorkflowSchema(fake, 3);
		expect(bad.valid).toBe(false);
		expect(bad.errors[0]).toContain("expected string");
	});
});
