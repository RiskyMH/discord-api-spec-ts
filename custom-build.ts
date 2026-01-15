// Custom TypeScript generator for discord-api-spec
import * as fs from "node:fs";

interface BuildOptions {
  srcFile: string;
  outFile: string;
  outFileJs: string;
  outFileZod: string;
}

export async function build({ srcFile, outFile, outFileJs, outFileZod }: BuildOptions) {
  const openapi = await Bun.file(srcFile).json();

  // --- helpers ---
  const toTypeName = (n: string) => n.replace(/[^\w]+/g, "_").replace(/^([0-9])/, "_$1");
  const toPascal = (n: string) => {
    const t = toTypeName(n);
    return t
      .split(/_+/)
      .filter(Boolean)
      .map((part) => part[0]!.toUpperCase() + part.slice(1))
      .join("");
  };
  const isObject = (v: any) => v && typeof v === "object" && !Array.isArray(v);
  const safeKey = (name: string) => (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? name : JSON.stringify(name));
  const zPrimitive = (t: string) => {
    switch (t) {
      case "string":
        return ("/* @__PURE__ */ z.string()");
      case "number":
      case "integer":
        return ("/* @__PURE__ */ z.number()");
      case "boolean":
        return ("/* @__PURE__ */ z.boolean()");
      case "null":
        return ("/* @__PURE__ */ z.null()");
      default:
        return ("/* @__PURE__ */ z.unknown()");
    }
  };

  const applyChecks = (expr: string, checks: string[]) => (checks.length ? `${expr}.check(${checks.join(", ")})` : expr);

  const applyStringConstraints = (expr: string, schema: any) => {
    const checks: string[] = [];
    if (typeof schema.minLength === "number") checks.push(`/* @__PURE__ */ z.minLength(${schema.minLength})`);
    if (typeof schema.maxLength === "number") checks.push(`/* @__PURE__ */ z.maxLength(${schema.maxLength})`);
    if (typeof schema.pattern === "string") checks.push(`/* @__PURE__ */ z.regex(/* @__PURE__ */ new RegExp(${JSON.stringify(schema.pattern)}))`);
    return applyChecks(expr, checks);
  };

  const applyNumberConstraints = (expr: string, schema: any) => {
    const checks: string[] = [];
    if (typeof schema.multipleOf === "number") checks.push(`/* @__PURE__ */ z.multipleOf(${schema.multipleOf})`);
    if (typeof schema.minimum === "number") checks.push(`/* @__PURE__ */ z.minimum(${schema.minimum})`);
    if (typeof schema.maximum === "number") checks.push(`/* @__PURE__ */ z.maximum(${schema.maximum})`);
    if (typeof schema.exclusiveMinimum === "number") checks.push(`/* @__PURE__ */ z.gt(${schema.exclusiveMinimum})`);
    if (typeof schema.exclusiveMaximum === "number") checks.push(`/* @__PURE__ */ z.lt(${schema.exclusiveMaximum})`);
    return applyChecks(expr, checks);
  };

  const buildNumberBase = (schema: any) => {
    if (schema.format === "int32") return "/* @__PURE__ */ z.int32()";
    if (schema.format === "uint32") return "/* @__PURE__ */ z.uint32()";
    return "/* @__PURE__ */ z.number()";
  };

  const applyArrayConstraints = (expr: string, schema: any) => {
    const checks: string[] = [];
    if (typeof schema.minItems === "number") checks.push(`/* @__PURE__ */ z.minLength(${schema.minItems})`);
    if (typeof schema.maxItems === "number") checks.push(`/* @__PURE__ */ z.maxLength(${schema.maxItems})`);
    return applyChecks(expr, checks);
  };
  const zEnumSchema = (values: any[]) => {
    if (values.every((v) => typeof v === "string")) {
      return (`/* @__PURE__ */ z.enum([${values.map((v) => JSON.stringify(v)).join(", ")}])`);
    }
    return (`/* @__PURE__ */ z.union([${values.map((v) => `/* @__PURE__ */ z.literal(${JSON.stringify(v)})`).join(", ")}])`);
  };

  // --- collect enums ---
  const enums: Record<string, { values: any[]; varnames: string[]; descriptions: string[]; type?: string; doc?: string }> = {};
  for (const [key, def] of Object.entries<any>(openapi.components?.schemas ?? {})) {
    if (def.enum && Array.isArray(def.enum) && def.enum.length) {
      enums[key] = {
        values: def.enum,
        varnames: def["x-enum-varnames"] || def.enum.map((v: any) => (typeof v === "string" ? v.toUpperCase() : String(v))),
        descriptions: def["x-enum-descriptions"] || [],
        type: def.type,
        doc: def.description || def.title,
      };
      continue;
    }
    if (def.oneOf && Array.isArray(def.oneOf) && def.oneOf.length && def.oneOf.every((ent: any) => ent.hasOwnProperty("const"))) {
      enums[key] = {
        values: def.oneOf.map((e: any) => e.const),
        varnames: def.oneOf.map((e: any) => e.title || (typeof e.const === "string" ? e.const.toUpperCase() : String(e.const))),
        descriptions: def.oneOf.map((e: any) => e.description || ""),
        type: def.type,
        doc: def.description || def.title,
      };
      continue;
    }
  }

  function enumKey(name: string): string {
    return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? name : JSON.stringify(name);
  }

  function printEnum(key: string, e: { values: any[]; varnames: string[]; descriptions: string[]; doc?: string }) {
    let out = "/**\n";
    if (e.doc) out += ` * ${e.doc}\n`;
    else out += ` * ${key}\n`;
    out += " */\n";
    out += `export const enum ${toTypeName(key)} {\n`;
    for (let i = 0; i < e.values.length; ++i) {
      if (e.descriptions && e.descriptions[i]) out += `  /** ${e.descriptions[i]} */\n`;
      out += `  ${enumKey(e.varnames[i]!)} = ${JSON.stringify(e.values[i])},\n`;
    }
    out += "}\n";
    return out;
  }

  // Usage tracking
  type SchemaLike = any;
  const usedComponents = new Set<string>();
  const usedEnums = new Set<string>();
  const visited = new Set<SchemaLike>();

  function markEnumUse(name: string) {
    if (enums[name]) usedEnums.add(name);
  }

  function markComponent(name: string) {
    usedComponents.add(name);
    markEnumUse(name);
  }

  function resolveRef(ref: string): string {
    // assumes #/components/schemas/Name
    const parts = ref.split("/");
    return toTypeName(parts[parts.length - 1]!);
  }

  function resolveParameterRef(ref: string): any | null {
    // assumes #/components/parameters/Name
    const parts = ref.split("/");
    const name = parts[parts.length - 1];
    return openapi.components?.parameters?.[name!] ?? null;
  }

  function mapEnumForEnum(values: any[]): string | null {
    // Exact match of enum array
    for (const [name, e] of Object.entries(enums)) {
      if (e.values.length === values.length && e.values.every((v, i) => v === values[i])) {
        markEnumUse(name);
        return toTypeName(name);
      }
    }
    // Single literal that exists in a larger enum
    if (values.length === 1) {
      const val = values[0];
      for (const [name, e] of Object.entries(enums)) {
        const idx = e.values.findIndex((v) => v === val);
        if (idx >= 0) {
          // skip inappropriate enums like command option types; prefer component/message enums by prefix
          if (/CommandOptionType/i.test(name)) continue;
          markEnumUse(name);
          return `${toTypeName(name)}.${toTypeName(e.varnames[idx]!)}`;
        }
      }
    }
    return null;
  }

  function mapEnumForConst(value: any): string | null {
    for (const [name, e] of Object.entries(enums)) {
      const idx = e.values.findIndex((v) => v === value);
      if (idx >= 0) {
        markEnumUse(name);
        return `${toTypeName(name)}.${toTypeName(e.varnames[idx]!)}`;
      }
    }
    return null;
  }

  function mapEnumFromAllOf(values: any[], allOf: any[]): string | null {
    if (!Array.isArray(allOf)) return null;
    for (const entry of allOf) {
      if (!entry || typeof entry !== "object" || !entry.$ref) continue;
      const refName = resolveRef(entry.$ref);
      const target = openapi.components?.schemas?.[refName];
      // Handle inline enum arrays or enums captured from oneOf+const
      const inlineEnum = Array.isArray(target?.enum) ? target!.enum : undefined;
      const mappedEnum = enums[refName];
      const candidateValues = inlineEnum ?? mappedEnum?.values;
      if (!candidateValues) continue;

      const allFound = values.every((v) => candidateValues.includes(v));
      if (!allFound) continue;

      markEnumUse(refName);
      if (values.length === 1 && mappedEnum) {
        const idx = mappedEnum.values.findIndex((v) => v === values[0]);
        if (idx >= 0) return `${toTypeName(refName)}.${toTypeName(mappedEnum.varnames[idx]!)}`;
      }
      return toTypeName(refName);
    }
    return null;
  }

  function mapEnumFromRefs(allOf: any[] | undefined, value: any | undefined): string | null {
    if (!Array.isArray(allOf)) return null;
    for (const entry of allOf) {
      if (!entry || typeof entry !== "object" || !entry.$ref) continue;
      const refName = resolveRef(entry.$ref);
      const e = enums[refName];
      if (!e) continue;
      markEnumUse(refName);
      if (value !== undefined) {
        const idx = e.values.findIndex((v) => v === value);
        if (idx >= 0) return `${toTypeName(refName)}.${toTypeName(e.varnames[idx]!)}`;
      }
      return toTypeName(refName);
    }
    return null;
  }

  function markSchema(schema: any) {
    if (!schema || typeof schema !== "object") return;
    if (visited.has(schema)) return;
    visited.add(schema);

    if (schema.$ref) {
      const refName = resolveRef(schema.$ref);
      markComponent(refName);
      const target = openapi.components?.schemas?.[refName];
      if (target) markSchema(target);
      return;
    }

    if (schema.oneOf) schema.oneOf.forEach(markSchema);
    if (schema.anyOf) schema.anyOf.forEach(markSchema);
    if (schema.allOf) schema.allOf.forEach(markSchema);
    if (schema.items) markSchema(schema.items);

    if (schema.properties) {
      for (const prop of Object.values<any>(schema.properties)) markSchema(prop);
    }
    if (schema.additionalProperties && isObject(schema.additionalProperties)) markSchema(schema.additionalProperties);
    if (schema.not) markSchema(schema.not);
    if (schema.then) markSchema(schema.then);
    if (schema.else) markSchema(schema.else);
  }

  // --- schema -> TS type conversion ---
  const schemaCache = new Map<any, string>();

  function zodFromSchema(schema: any): string {
    if (!schema || typeof schema !== "object") return "/* @__PURE__ */ z.unknown()";

    if (schema.$ref) {
      const t = resolveRef(schema.$ref);
      markComponent(t);
      return (`/* @__PURE__ */ z.lazy(() => ${t}Schema)`);
    }

    if (Array.isArray(schema.enum)) {
      return schema.enum.length ? zEnumSchema(schema.enum) : ("/* @__PURE__ */ z.unknown()");
    }
    if (schema.const !== undefined) {
      return (`/* @__PURE__ */ z.literal(${JSON.stringify(schema.const)})`);
    }

    if (Array.isArray(schema.oneOf)) {
      if (!schema.oneOf.length) return schema.type ? zPrimitive(schema.type) : ("/* @__PURE__ */ z.undefined()");
      return (`/* @__PURE__ */ z.union([${schema.oneOf.map((s: any) => zodFromSchema(s)).join(", ")}])`);
    }
    if (Array.isArray(schema.anyOf)) {
      if (!schema.anyOf.length) return schema.type ? zPrimitive(schema.type) : ("/* @__PURE__ */ z.undefined()");
      return (`/* @__PURE__ */ z.union([${schema.anyOf.map((s: any) => zodFromSchema(s)).join(", ")}])`);
    }
    if (Array.isArray(schema.allOf)) {
      if (!schema.allOf.length) return schema.type ? zPrimitive(schema.type) : ("/* @__PURE__ */ z.undefined()");
      return (`/* @__PURE__ */ z.intersection(${schema.allOf.map((s: any) => zodFromSchema(s)).join(", ")})`);
    }

    if (Array.isArray(schema.type)) {
      const variants = schema.type.map((t: string) => {
        if (t === "null") return "/* @__PURE__ */ z.null()";
        return zodFromSchema({ ...schema, type: t });
      });
      return `/* @__PURE__ */ z.union([${variants.join(", ")}])`;
    }

    if (schema.type === "array") {
      const item = zodFromSchema(schema.items || {});
      const arrayBase = applyArrayConstraints(`/* @__PURE__ */ z.array(${item})`, schema);
      // zod/mini lacks a built-in uniqueItems helper; skip enforcement here.
      return arrayBase;
    }

    if (schema.type === "object" || schema.properties) {
      const props = schema.properties || {};
      const entries = Object.entries<any>(props).map(([k, v]) => {
        const base = `${JSON.stringify(k)}: ${zodFromSchema(v)}`;
        return v && v.nullable ? `${base}.nullable()` : base;
      });
      const additional = schema.additionalProperties;
      let ap: string | null = null;
      if (additional === true) {
        ap = "/* @__PURE__ */ z.record(/* @__PURE__ */ z.unknown())";
      } else if (isObject(additional)) {
        ap = `/* @__PURE__ */ z.record(/* @__PURE__ */ z.string(), ${zodFromSchema(additional)})`;
      }

      const body = entries.length ? `{ ${entries.join(", ")} }` : "{}";
      let baseObj = schema.required ? `/* @__PURE__ */ z.strictObject(${body})` : `/* @__PURE__ */ z.object(${body})`;

      const objChecks: string[] = [];
      if (typeof schema.minProperties === "number") objChecks.push(`/* @__PURE__ */ z.minLength(${schema.minProperties})`);
      if (typeof schema.maxProperties === "number") objChecks.push(`/* @__PURE__ */ z.maxLength(${schema.maxProperties})`);
      if (objChecks.length) baseObj = applyChecks(baseObj, objChecks);

      if (ap && !entries.length) return ap;
      if (ap && entries.length) return `/* @__PURE__ */ z.intersection(${baseObj}, ${ap})`;

      return baseObj;
    }

    if (schema.type === "string") {
      let str = applyStringConstraints("/* @__PURE__ */ z.string()", schema);
      if (schema.format === "email") str = `${str}.check(/* @__PURE__ */ z.email())`;
      else if (schema.format === "uri" || schema.format === "url") str = `${str}.check(/* @__PURE__ */ z.url())`;
      else if (schema.format === "uuid") str = `${str}.check(/* @__PURE__ */ z.uuid())`;
      else if (schema.format === "date-time") str = `${str}.check(/* @__PURE__ */ z.iso.datetime())`;
      return str;
    }

    if (schema.type === "number" || schema.type === "integer") {
      const numBase = buildNumberBase(schema);
      return applyNumberConstraints(numBase, schema);
    }
    if (schema.type) return zPrimitive(schema.type);
    return "/* @__PURE__ */ z.unknown()";
  }

  function typeFromSchema(schema: any): string {
    if (!schema || typeof schema !== "object") return "any";
    if (schemaCache.has(schema)) return schemaCache.get(schema)!;

    // $ref
    if (schema.$ref) {
      const t = resolveRef(schema.$ref);
      markComponent(t);
      schemaCache.set(schema, t);
      return t;
    }

    // enum / const with enum mapping
    if (Array.isArray(schema.enum)) {
      // Try: direct match to declared enum
      const mapped = mapEnumForEnum(schema.enum);
      if (mapped) {
        schemaCache.set(schema, mapped);
        return mapped;
      }
      // Try: enum values with allOf reference to an enum schema
      const mappedAllOf = schema.allOf ? mapEnumFromAllOf(schema.enum, schema.allOf) : null;
      if (mappedAllOf) {
        schemaCache.set(schema, mappedAllOf);
        return mappedAllOf;
      }
      const literals = schema.enum.map((v: any) => JSON.stringify(v)).join(" | ");
      schemaCache.set(schema, literals);
      return literals;
    }
    if (schema.const !== undefined) {
      const mapped = mapEnumForConst(schema.const);
      if (mapped) {
        schemaCache.set(schema, mapped);
        return mapped;
      }
      const mappedAllOf = schema.allOf ? mapEnumFromAllOf([schema.const], schema.allOf) : null;
      if (mappedAllOf) {
        schemaCache.set(schema, mappedAllOf);
        return mappedAllOf;
      }
      const lit = JSON.stringify(schema.const);
      schemaCache.set(schema, lit);
      return lit;
    }

    // oneOf / anyOf / allOf with discriminator fallback
    if (Array.isArray(schema.oneOf)) {
      if (!schema.oneOf.length) {
        const t = schema.type ? typeFromSchema({ type: schema.type }) : "unknown";
        schemaCache.set(schema, t);
        return t;
      }
      const t = schema.oneOf.map((s: any) => typeFromSchema(s)).join(" | ");
      schemaCache.set(schema, t);
      return t;
    }
    if (Array.isArray(schema.anyOf)) {
      if (!schema.anyOf.length) {
        const t = schema.type ? typeFromSchema({ type: schema.type }) : "unknown";
        schemaCache.set(schema, t);
        return t;
      }
      const t = schema.anyOf.map((s: any) => typeFromSchema(s)).join(" | ");
      schemaCache.set(schema, t);
      return t;
    }
    if (Array.isArray(schema.allOf)) {
      // If allOf contains a $ref to an enum schema and this schema has enum/const handled earlier, that branch returns there.
      if (!schema.allOf.length) {
        const t = schema.type ? typeFromSchema({ type: schema.type }) : "unknown";
        schemaCache.set(schema, t);
        return t;
      }
      const t = schema.allOf.map((s: any) => typeFromSchema(s)).join(" & ");
      schemaCache.set(schema, t);
      return t;
    }

    // arrays
    if (schema.type === "array") {
      const itemType = typeFromSchema(schema.items || {});
      const wrapped = itemType.includes("|") ? `(${itemType})[]` : `${itemType}[]`;
      schemaCache.set(schema, wrapped);
      return wrapped;
    }

    // object
    if (schema.type === "object" || schema.properties) {
      const props = schema.properties || {};
      const required: string[] = schema.required || [];
      let out = "{\n";
      for (const [propName, propSchema] of Object.entries<any>(props)) {
        let tsType: string;
        const isTypeLike = propName === "type" || propName === "component_type" || propName === "trigger_type";
        // Prefer enum-member mapping when single-value enum/const with allOf ref to enum schema
        if (propSchema && Array.isArray(propSchema.enum) && propSchema.enum.length === 1 && propSchema.allOf) {
          const mappedAllOf = mapEnumFromAllOf(propSchema.enum, propSchema.allOf);
          if (mappedAllOf) tsType = mappedAllOf; else tsType = typeFromSchema(propSchema);
        } else if (propSchema && propSchema.const !== undefined && propSchema.allOf) {
          const mappedAllOf = mapEnumFromAllOf([propSchema.const], propSchema.allOf);
          if (mappedAllOf) tsType = mappedAllOf; else tsType = typeFromSchema(propSchema);
        } else if (isTypeLike && Array.isArray(propSchema?.enum) && propSchema.enum.length === 1) {
          // If it has allOf with a ref to an enum, map to member/type
          const mappedAll = mapEnumFromAllOf(propSchema.enum, propSchema.allOf || []);
          const mappedRefOnly = mapEnumFromRefs(propSchema.allOf || [], propSchema.enum[0]);
          const mapped = mappedAll || mappedRefOnly || mapEnumForConst(propSchema.enum[0]) || mapEnumForEnum(propSchema.enum);
          if (mapped) tsType = mapped; else tsType = typeFromSchema(propSchema);
        } else if (isTypeLike && propSchema?.const !== undefined) {
          const mappedAll = mapEnumFromAllOf([propSchema.const], propSchema.allOf || []);
          const mappedRefOnly = mapEnumFromRefs(propSchema.allOf || [], propSchema.const);
          const mapped = mappedAll || mappedRefOnly || mapEnumForConst(propSchema.const);
          if (mapped) tsType = mapped; else tsType = typeFromSchema(propSchema);
        } else {
          tsType = typeFromSchema(propSchema);
        }
        const optional = required.includes(propName) ? "" : "?";
        const nullable = propSchema.nullable ? " | null" : "";
        if (propSchema && (propSchema.description || propSchema.title)) {
          out += `  /** ${(propSchema.description || propSchema.title).replace(/\n/g, ' ')} */\n`;
        }
        out += `  ${propName}${optional}: ${tsType}${nullable};\n`;
      }
      if (schema.additionalProperties) {
        if (schema.additionalProperties === true) {
          out += "  [key: string]: unknown;\n";
        } else if (isObject(schema.additionalProperties)) {
          const apType = typeFromSchema(schema.additionalProperties);
          out += `  [key: string]: ${apType};\n`;
        }
      }
      out += "}";
      schemaCache.set(schema, out);
      return out;
    }

    // unioned primitive/array types like ["integer","null"] or ["array","null"]
    if (Array.isArray(schema.type)) {
      const mapped = schema.type.map((t: string) => {
        switch (t) {
          case "string":
            return "string";
          case "integer":
          case "number":
            return "number";
          case "boolean":
            return "boolean";
          case "null":
            return "null";
          case "array": {
            const itemType = typeFromSchema(schema.items || {});
            return itemType.includes("|") ? `(${itemType})[]` : `${itemType}[]`;
          }
          case "object": {
            // rare: object|null as union type array; fall back to object handler
            return typeFromSchema({ ...schema, type: "object" });
          }
          default:
            return "unknown";
        }
      });
      const t = mapped.join(" | ");
      schemaCache.set(schema, t);
      return t;
    }

    // primitives
    switch (schema.type) {
      case "string":
        schemaCache.set(schema, "string");
        return "string";
      case "integer":
      case "number":
        schemaCache.set(schema, "number");
        return "number";
      case "boolean":
        schemaCache.set(schema, "boolean");
        return "boolean";
      case "null":
        schemaCache.set(schema, "null");
        return "null";
      case "object": {
        // Empty object schema: model as open record
        const t = "Record<string, unknown>";
        schemaCache.set(schema, t);
        return t;
      }
    }

    schemaCache.set(schema, "unknown");
    return "unknown";
  }

  // --- mark reachability from paths ---
  function markContent(content: any) {
    if (!content || !isObject(content)) return;
    const json = content["application/json"] || content["application/merge-patch+json"];
    if (json && json.schema) markSchema(json.schema);
    else {
      for (const v of Object.values<any>(content)) if (v && v.schema) markSchema(v.schema);
    }
  }

  for (const methods of Object.values<any>(openapi.paths || {})) {
    const pathParams = Array.isArray((methods as any)?.parameters) ? (methods as any).parameters : [];
    for (const op of Object.values<any>(methods || {})) {
      if (!op || typeof op !== "object") continue;
      if (Array.isArray(pathParams)) {
        for (const p of pathParams) {
          if (p?.schema) markSchema(p.schema);
        }
      }
      if (Array.isArray(op.parameters)) {
        for (const p of op.parameters) {
          if (p.schema) markSchema(p.schema);
        }
      }
      if (op.requestBody && op.requestBody.content) markContent(op.requestBody.content);
      if (op.responses && isObject(op.responses)) {
        for (const resp of Object.values<any>(op.responses)) {
          if (resp && resp.content) markContent(resp.content);
        }
      }
    }
  }

  // --- generate component types (only used) ---
  let componentsOut = "";
  let componentsZodOut = "";
  for (const [name, schema] of Object.entries<any>(openapi.components?.schemas ?? {})) {
    if (!usedComponents.has(toTypeName(name)) && !usedComponents.has(name)) continue;
    if (enums[name]) {
      const e = enums[name];
      const doc = schema.description || schema.title || e.doc;
      if (doc) componentsOut += `/** ${doc.replace(/\n/g, ' ')} */\n`;
      // Enum types are already declared above; still emit Zod schema for refs.
      componentsZodOut += `export const ${toTypeName(name)}Schema = /* @__PURE__ */ ${zEnumSchema(e.values)};\n\n`;
      continue;
    }
    const tsType = typeFromSchema(schema);
    const zodType = zodFromSchema(schema);
    const doc = schema.description || schema.title;
    if (doc) componentsOut += `/** ${doc.replace(/\n/g, ' ')} */\n`;
    componentsOut += `export type ${toTypeName(name)} = ${tsType};\n\n`;
    componentsZodOut += `export const ${toTypeName(name)}Schema = /* @__PURE__ */ ${zodType};\n\n`;
  }

  // --- generate paths (simplified) ---
  const httpMethods = ["get", "put", "post", "delete", "patch", "options", "head", "trace"] as const;
  type HttpMethod = (typeof httpMethods)[number];
  function pickContentType(content: any): { type: string; contentType: string } {
    if (!content || !isObject(content)) return { type: "unknown", contentType: "unknown" };
    const order = ["application/json", "application/merge-patch+json", "multipart/form-data", "application/x-www-form-urlencoded", "image/png"];
    for (const ct of order) {
      const entry = (content as any)[ct];
      if (entry && entry.schema) return { type: typeFromSchema(entry.schema), contentType: ct };
    }
    for (const [ct, entry] of Object.entries<any>(content)) {
      if (entry && entry.schema) return { type: typeFromSchema(entry.schema), contentType: ct };
    }
    return { type: "unknown", contentType: "unknown" };
  }

  const pathsListMap = Object.fromEntries(httpMethods.map((m) => [m, []])) as any as Record<HttpMethod, string[]>;
  let pathsOut = "export interface Paths {\n";
  let operationAliasesOut = "";
  for (const [route, methods] of Object.entries<any>(openapi.paths || {})) {
    pathsOut += `  ${JSON.stringify(route)}: {\n`;
    for (const [method, op] of Object.entries<any>(methods)) {
      if (!op || typeof op !== "object") continue;
      const m = method.toLowerCase();
      if (!httpMethods.includes(m as any)) continue;
      if (!pathsListMap[m as HttpMethod].includes(route)) pathsListMap[m as HttpMethod].push(route);

      const paramGroups: Record<string, any[]> = { path: [], query: [], header: [], cookie: [] };
      const collectParam = (p: any) => {
        if (!p) return;
        const schema = p.schema || (p.content && Object.values<any>(p.content)[0]?.schema);
        const t = schema ? typeFromSchema(schema) : "unknown";
        paramGroups[p.in || "path"]?.push({ name: p.name, type: t, required: p.required });
      };

      const inheritedParams = Array.isArray((methods as any)?.parameters) ? (methods as any).parameters : [];
      const mergedParams = [...inheritedParams, ...(Array.isArray(op.parameters) ? op.parameters : [])];
      if (mergedParams.length) {
        for (const p of mergedParams) {
          if (p?.$ref) {
            const resolved = resolveParameterRef(p.$ref);
            if (resolved) collectParam(resolved);
          } else {
            collectParam(p);
          }
        }
      }

      const paramType = (group: string) => {
        const arr = paramGroups[group];
        if (!arr || !arr.length) return "never";
        let s = "{\n";
        for (const p of arr) {
          const optional = p.required ? "" : "?";
          s += `    ${p.name}${optional}: ${p.type};\n`;
        }
        s += "  }";
        return s;
      };

      const hasRequestBody = !!op.requestBody;
      const { type: requestType } = hasRequestBody ? pickContentType(op.requestBody.content) : { type: "undefined" };
      let responses = "{\n";
      if (op.responses && isObject(op.responses)) {
        for (const [code, resp] of Object.entries<any>(op.responses)) {
          const { type: rType } = resp.content ? pickContentType(resp.content) : { type: "unknown" };
          const doc = resp.description ? `/** ${String(resp.description).replace(/\n/g, ' ')} */\n    ` : "";
          responses += `    ${doc}${JSON.stringify(code)}: ${rType};\n`;
        }
      }
      responses += "  }";

      const opId = op.operationId;
      if (opId) {
        const opTypeName = toPascal(opId);
        const paramsAlias = `${opTypeName}Params`;
        const requestAlias = `${opTypeName}RequestBody`;
        const responsesAlias = `${opTypeName}Responses`;
        const pathAccessor = `Paths[${JSON.stringify(route)}][${JSON.stringify(m)}]`;

        operationAliasesOut += `export type ${paramsAlias} = ${pathAccessor}["parameters"];
export type ${requestAlias} = ${pathAccessor}["requestBody"];
export type ${responsesAlias} = ${pathAccessor}["responses"];

`;
      }

      pathsOut += `    ${m}: {\n`;
      if (op.summary || op.description) {
        const doc = (op.summary || op.description).replace(/\n/g, ' ');
        pathsOut += `      /** ${doc} */\n`;
      }
      pathsOut += `      parameters: {\n        path?: ${paramType("path")};\n        query?: ${paramType("query")};\n        header?: ${paramType("header")};\n        cookie?: ${paramType("cookie")};\n      };\n`;
      pathsOut += `      requestBody?: ${requestType};\n`;
      pathsOut += `      responses: ${responses};\n`;
      pathsOut += "    };\n";
    }
    pathsOut += "  };\n";
  }
  pathsOut += "}\n";

  let pathsListOut = "export const pathsList = {\n";
  for (const m of httpMethods) {
    const routes = pathsListMap[m];
    if (!routes.length) continue;
    const entries = routes.map((r) => JSON.stringify(r)).join(", ");
    pathsListOut += `  ${m}: [${entries}],\n`;
  }
  pathsListOut += "} as const;\n\n";

  // --- assemble output ---
  let output = "/* AUTO-GENERATED. DO NOT EDIT. */\n\n";
  let outputJs = "/* AUTO-GENERATED. DO NOT EDIT. */\n\n";
  for (const [k, v] of Object.entries(enums)) {
    if (!usedEnums.size || usedEnums.has(k)) output += printEnum(k, v) + "\n";
    outputJs += `export const ${toTypeName(k)} = {\n`;
    v.values.forEach((val, i) => {
      const prop = safeKey(v.varnames[i]!);
      outputJs += `  ${prop}: ${JSON.stringify(val)},\n`;
    });
    outputJs += "};\n\n";
  }
  output += "\n// Components\n" + componentsOut + "\n";
  output += "// Paths\n" + pathsOut + "\n";
  output += "// Paths list\n" + pathsListOut;
  output += operationAliasesOut;

  outputJs += "export const pathsList = {\n";
  for (const m of httpMethods) {
    const routes = pathsListMap[m];
    if (!routes.length) continue;
    const entries = routes.map((r) => JSON.stringify(r)).join(", ");
    outputJs += `  ${m}: /* @__PURE__ */ Object.freeze([${entries}]),\n`;
  }
  outputJs += "};\n\n";

  fs.mkdirSync("./build", { recursive: true });
  await Bun.write(outFile, output);
  await Bun.write(outFileJs, outputJs);
  await Bun.write(outFileZod, "/* AUTO-GENERATED. DO NOT EDIT. */\n\nimport * as z from 'zod/mini';\n\n" + componentsZodOut.replaceAll("/* @__PURE__ */ /* @__PURE__ */", "/* @__PURE__ */"));
  console.log(`✅ Wrote ${outFile} (TS) and ${outFileJs} (JS) with enums, components, and paths.`);

  await Bun.$`bunx oxfmt ${outFile}`.quiet();
  await Bun.$`bunx oxfmt ${outFileZod}`.quiet();
}


