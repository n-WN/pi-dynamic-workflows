/**
 * JSON Schema helpers for structured agent output.
 *
 * - findSchemaContradiction(): detect schemas that no value can match, before an agent starts.
 * - toToolParameters(): providers want an object schema for tool input; wrap other schemas.
 * - validate(): check a value and return readable errors.
 */

import { Value } from "typebox/value";

type Schema = Record<string, unknown>;

const isObj = (v: unknown): v is Schema => typeof v === "object" && v !== null && !Array.isArray(v);

function typeList(s: Schema): string[] | undefined {
	if (typeof s.type === "string") return [s.type];
	if (Array.isArray(s.type)) return s.type.filter((t): t is string => typeof t === "string");
	return undefined;
}

function jsonType(v: unknown): string {
	if (v === null) return "null";
	if (Array.isArray(v)) return "array";
	if (typeof v === "number") return Number.isInteger(v) ? "integer" : "number";
	return typeof v;
}

function matchesType(v: unknown, types: string[]): boolean {
	const t = jsonType(v);
	return types.includes(t) || (t === "integer" && types.includes("number"));
}

/** Returns a message naming the first contradiction, or undefined. */
export function findSchemaContradiction(schema: unknown, path = "schema"): string | undefined {
	if (schema === false) return `${path} is false, so no value can match it`;
	if (schema === true || schema === undefined) return undefined;
	if (!isObj(schema)) return `${path} must be a JSON Schema object`;
	const s = schema;
	const types = typeList(s);
	const known = ["string", "number", "integer", "boolean", "object", "array", "null"];
	if (types) {
		if (types.length === 0) return `${path}.type is an empty list, so no value can match it`;
		const bad = types.find((t) => !known.includes(t));
		if (bad) return `${path}.type "${bad}" is not a JSON Schema type (use one of ${known.join(", ")})`;
	}
	if (Array.isArray(s.enum)) {
		if (s.enum.length === 0) return `${path}.enum is empty, so no value can match it`;
		if (types && !s.enum.some((v) => matchesType(v, types))) {
			return `${path}.enum has no value of type ${types.join("|")}`;
		}
	}
	if ("const" in s && types && !matchesType(s.const, types)) {
		return `${path}.const does not have type ${types.join("|")}`;
	}
	const pairs: Array<[string, string]> = [
		["minimum", "maximum"],
		["exclusiveMinimum", "exclusiveMaximum"],
		["minLength", "maxLength"],
		["minItems", "maxItems"],
		["minProperties", "maxProperties"],
	];
	for (const [lo, hi] of pairs) {
		if (typeof s[lo] === "number" && typeof s[hi] === "number" && (s[lo] as number) > (s[hi] as number)) {
			return `${path}.${lo} (${s[lo]}) is greater than ${path}.${hi} (${s[hi]})`;
		}
	}
	const props = isObj(s.properties) ? s.properties : {};
	if (Array.isArray(s.required)) {
		for (const key of s.required) {
			if (typeof key !== "string") return `${path}.required must contain only strings`;
			if (!(key in props)) {
				if (s.additionalProperties === false) {
					return `${path}.required lists "${key}", but additionalProperties is false and "${key}" is not in ${path}.properties`;
				}
				if (isObj(s.additionalProperties)) {
					const inner = findSchemaContradiction(s.additionalProperties, `${path}.additionalProperties`);
					if (inner) return `${path}.required lists "${key}", but ${inner}`;
				}
			} else if (props[key] === false) {
				return `${path}.required lists "${key}", but ${path}.properties.${key} is false`;
			}
		}
		if (typeof s.maxProperties === "number" && s.required.length > s.maxProperties) {
			return `${path}.required lists ${s.required.length} keys, but maxProperties is ${s.maxProperties}`;
		}
	}
	// A required property that no value can match makes the object impossible.
	// An impossible optional property only means that the key cannot appear.
	if (Array.isArray(s.required)) {
		for (const key of s.required) {
			if (typeof key !== "string" || !(key in props)) continue;
			const inner = findSchemaContradiction(props[key], `${path}.properties.${key}`);
			if (inner) return inner;
		}
	}
	if (s.items !== undefined && !Array.isArray(s.items)) {
		const inner = findSchemaContradiction(s.items, `${path}.items`);
		if (inner && typeof s.minItems === "number" && s.minItems > 0) return inner;
	}
	for (const comb of ["allOf"] as const) {
		if (Array.isArray(s[comb])) {
			for (let i = 0; i < (s[comb] as unknown[]).length; i++) {
				const inner = findSchemaContradiction((s[comb] as unknown[])[i], `${path}.${comb}[${i}]`);
				if (inner) return inner;
			}
		}
	}
	for (const comb of ["anyOf", "oneOf"] as const) {
		if (Array.isArray(s[comb])) {
			const list = s[comb] as unknown[];
			if (list.length === 0) return `${path}.${comb} is empty, so no value can match it`;
			const problems = list.map((sub, i) => findSchemaContradiction(sub, `${path}.${comb}[${i}]`));
			if (problems.every(Boolean)) return problems[0];
		}
	}
	return undefined;
}

export interface ToolParameters {
	parameters: Schema;
	/** True when the schema is wrapped as { value: <schema> }. */
	wrapped: boolean;
}

/** Providers expect an object schema for tool input. Wrap other schemas under "value". */
export function toToolParameters(schema: Schema): ToolParameters {
	const types = typeList(schema);
	const isObject = types ? types.length === 1 && types[0] === "object" : isObj(schema.properties);
	if (isObject && !schema.anyOf && !schema.oneOf) {
		return { parameters: { ...schema, type: "object" }, wrapped: false };
	}
	return {
		parameters: {
			type: "object",
			properties: { value: schema },
			required: ["value"],
			additionalProperties: false,
		},
		wrapped: true,
	};
}

export function validate(schema: Schema, value: unknown): { ok: true } | { ok: false; errors: string[] } {
	try {
		if (Value.Check(schema as never, value)) return { ok: true };
		const errors = [...Value.Errors(schema as never, value)]
			.slice(0, 8)
			.map((e) => {
				const err = e as unknown as { instancePath?: string; message?: string };
				return `${err.instancePath || "/"}: ${err.message ?? "invalid"}`;
			});
		return { ok: false, errors: errors.length ? errors : ["value does not match the schema"] };
	} catch (err) {
		return { ok: false, errors: [`schema check failed: ${(err as Error).message}`] };
	}
}

/** Short human text of a schema, for prompts and the agent detail view. */
export function describeSchema(schema: Schema, depth = 0): string {
	if (depth > 3) return "…";
	const types = typeList(schema);
	if (types?.includes("object") || isObj(schema.properties)) {
		const props = isObj(schema.properties) ? schema.properties : {};
		const req = new Set(Array.isArray(schema.required) ? (schema.required as string[]) : []);
		const inner = Object.entries(props)
			.map(([k, v]) => `${k}${req.has(k) ? "" : "?"}: ${isObj(v) ? describeSchema(v, depth + 1) : "any"}`)
			.join(", ");
		return `{ ${inner} }`;
	}
	if (types?.includes("array")) return `${isObj(schema.items) ? describeSchema(schema.items, depth + 1) : "any"}[]`;
	if (Array.isArray(schema.enum)) return schema.enum.map((v) => JSON.stringify(v)).join(" | ");
	return types?.join(" | ") ?? "any";
}

/** True when the schema allows a string value (directly or in anyOf/oneOf). */
export function acceptsString(schema: Record<string, unknown> | undefined): boolean {
	if (!schema) return true;
	if (schema.type === "string" || (Array.isArray(schema.type) && schema.type.includes("string"))) return true;
	const alts = [...((schema.anyOf as Record<string, unknown>[] | undefined) ?? []), ...((schema.oneOf as Record<string, unknown>[] | undefined) ?? [])];
	return alts.some((a) => acceptsString(a));
}
