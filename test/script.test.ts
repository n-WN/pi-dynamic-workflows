import assert from "node:assert/strict";
import { test } from "node:test";
import { findSchemaContradiction, toToolParameters, validate } from "../extensions/workflows/schema.ts";
import { peekMetaName, prepareScript, renameScript, ScriptError } from "../extensions/workflows/script.ts";

const ok = (body: string) => prepareScript(`export const meta = { name: "x", description: "d" }\n${body}`, "s.js");
const fails = (src: string, re: RegExp) => {
	assert.throws(
		() => prepareScript(src, "s.js"),
		(e: unknown) => e instanceof ScriptError && re.test(e.format("s.js")),
	);
};

test("meta literal: values, comments, trailing commas, quotes", () => {
	const p = prepareScript(
		`// leading comment\nexport const meta = {\n  name: 'a-b', // x\n  "description": \`multi word\`,\n  phases: ["One", 'Two',],\n  args: { type: "string", minLength: -1 },\n  argsHint: "<q>",\n}\nreturn 1`,
		"s.js",
	);
	assert.equal(p.meta.name, "a-b");
	assert.equal(p.meta.description, "multi word");
	assert.deepEqual(p.meta.phases, ["One", "Two"]);
	assert.deepEqual(p.meta.args, { type: "string", minLength: -1 });
	// Lines keep their numbers: export becomes spaces.
	assert.equal(p.body.split("\n").length, p.source.split("\n").length);
	assert.match(p.body, /^\/\/ leading comment\n {6} const meta/);
});

test("meta problems are reported with location", () => {
	fails("const x = 1", /must begin with `export const meta/);
	fails(`export const meta = { name: "X Y", description: "d" }`, /meta.name "X Y" is not valid/);
	fails(`export const meta = { name: "x" }`, /meta.description is required/);
	fails(`export const meta = { name: "x", description: d }`, /a variable \(d\) at meta.description/);
	fails(`export const meta = { name: "x", description: f() }`, /function call/);
	fails(`export const meta = { name: "x", description: \`a \${b}\` }`, /template literal/);
	fails(`export const meta = { name, description: "d" }`, /shorthand property/);
	fails(`export const meta = { name: "x", description: "d", phases: "one" }`, /meta.phases must be an array/);
});

test("forbidden constructs outside strings and comments", () => {
	fails(`export const meta = { name: "x", description: "d" }\nconst fs = await import("node:fs")`, /s.js:2:\d+ import\(\) is not allowed/);
	fails(`export const meta = { name: "x", description: "d" }\nimport fs from "fs"`, /import declarations are not allowed/);
	fails(`export const meta = { name: "x", description: "d" }\nconst fs = require("fs")`, /require\(\) is not allowed/);
	fails(`export const meta = { name: "x", description: "d" }\nconst t = Date.now()`, /Date.now\(\) is disabled/);
	fails(`export const meta = { name: "x", description: "d" }\nconst t = new Date()`, /new Date\(\) without arguments/);
	fails(`export const meta = { name: "x", description: "d" }\nconst r = Math.random()`, /Math.random\(\) is disabled/);
	fails(`export const meta = { name: "x", description: "d" }\nexport const y = 1`, /Only `export const meta` may use export/);
	// Fine: inside strings, templates, comments, regex literals, or as member names.
	ok(`const a = "import('x') require('y') Date.now()"\nconst b = \`call import(\${1}) here\`\n// Math.random()\n/* new Date() */\nconst re = /import\\(/g\nconst o = { import: 1 }; o.require = 2\nreturn new Date(0)`);
});

test("syntax errors carry the original line and a caret", () => {
	try {
		prepareScript(`export const meta = { name: "x", description: "d" }\nconst a = 1\nconst b = (a +\nreturn b`, "s.js");
		assert.fail("expected a syntax error");
	} catch (e) {
		assert.ok(e instanceof ScriptError);
		assert.equal(e.kind, "syntax");
		assert.ok(e.line === 3 || e.line === 4, `line ${e.line}`);
		assert.match(e.format("s.js"), /SyntaxError/);
	}
});

test("rename and peek", () => {
	const p = ok("return 1");
	const renamed = renameScript(p, "other-name");
	assert.equal(prepareScript(renamed, "s.js").meta.name, "other-name");
	assert.equal(peekMetaName(renamed), "other-name");
});

test("schema contradictions", () => {
	assert.match(
		findSchemaContradiction({ type: "object", required: ["a"], properties: {}, additionalProperties: false }) ?? "",
		/required lists "a", but additionalProperties is false/,
	);
	assert.match(findSchemaContradiction({ enum: [] }) ?? "", /enum is empty/);
	assert.match(findSchemaContradiction({ type: "array", minItems: 3, maxItems: 1 }) ?? "", /minItems \(3\) is greater than/);
	assert.match(findSchemaContradiction({ type: "string", enum: [1, 2] }) ?? "", /enum has no value of type string/);
	assert.match(
		findSchemaContradiction({ type: "object", required: ["x"], properties: { x: { type: "integer", minimum: 5, maximum: 1 } } }) ?? "",
		/properties.x.minimum/,
	);
	assert.equal(findSchemaContradiction({ type: "object", properties: { x: { enum: [] } } }), undefined, "optional impossible key is fine");
	assert.equal(findSchemaContradiction({ type: "object", required: ["files"], properties: { files: { type: "array", items: { type: "string" } } } }), undefined);
});

test("tool parameters wrap non-object schemas", () => {
	assert.deepEqual(toToolParameters({ type: "object", properties: { a: { type: "string" } } }).wrapped, false);
	const w = toToolParameters({ type: "array", items: { type: "string" } });
	assert.equal(w.wrapped, true);
	assert.deepEqual(w.parameters.required, ["value"]);
});

test("validation errors are readable", () => {
	const r = validate({ type: "object", required: ["n"], properties: { n: { type: "number" } } }, { n: "x" });
	assert.equal(r.ok, false);
	if (!r.ok) assert.match(r.errors.join(" "), /\/n: must be number/);
	assert.equal(validate({ type: "string" }, "a").ok, true);
});
