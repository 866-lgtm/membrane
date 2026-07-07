/**
 * Anthropic tool-schema normalization
 *
 * MCP permits a tool's input JSON Schema to have a root-level `oneOf` /
 * `anyOf` / `allOf` (a union of alternative argument shapes). The Anthropic
 * API does not: `input_schema` must be a single object-type schema, and a
 * root-level combinator is rejected with 400
 * ("input_schema does not support oneOf, allOf, or anyOf at the top level").
 * One such tool 400s the entire inference — same philosophy as
 * `normalize-tool-pairs`: repair at the wire boundary instead of letting a
 * producer-side quirk kill the turn.
 *
 * `flattenRootSchemaUnion` rewrites the common case — every union variant is
 * itself an object schema — into a single object schema:
 *
 *   - `properties` is the merge of all variants' properties (first wins on
 *     key collision).
 *   - `required`: for `allOf` (intersective — every variant applies) the
 *     union of the variants' required lists; for `oneOf`/`anyOf`
 *     (alternatives) only keys required by *every* variant stay required.
 *   - A short note enumerating the alternative argument groups is appended
 *     to the description so the model still sees the union intent.
 *   - Variant-level `additionalProperties: false` is dropped: the merged
 *     object is a permissive superset of the alternatives, and `false`
 *     could reject payloads valid under one of the original variants.
 *
 * If any variant is not object-shaped (e.g. a root `oneOf` of a string and
 * an object), the union cannot be merged into properties; we fall back to a
 * permissive object schema carrying the serialized union in the description.
 * Degenerate, but it does not 400 — the tool stays callable and the model
 * sees the accepted shapes.
 *
 * Nested combinators (inside `properties`, array `items`, etc.) are legal
 * for Anthropic and are left untouched; only the root is rewritten.
 */

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isMergeableObjectVariant(variant: Record<string, unknown>): boolean {
  return (
    variant.type === 'object' ||
    (variant.type === undefined && isPlainObject(variant.properties))
  );
}

function stringRequired(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : [];
}

const ROOT_UNION_KEYS = ['oneOf', 'anyOf', 'allOf'] as const;

/** Max length of the description we synthesize on the fallback path. */
const MAX_FALLBACK_DESCRIPTION = 4000;

/**
 * Rewrite a root-level `oneOf`/`anyOf`/`allOf` in a tool input schema into a
 * single Anthropic-acceptable object schema. Returns the input unchanged
 * (same reference) when there is nothing to repair, so callers can cheaply
 * detect whether a rewrite happened.
 */
export function flattenRootSchemaUnion(schema: unknown): unknown {
  if (!isPlainObject(schema)) return schema;

  const unionKey = ROOT_UNION_KEYS.find(
    (key) => Array.isArray(schema[key]) && (schema[key] as unknown[]).length > 0,
  );
  if (unionKey === undefined) return schema;

  const rawVariants = schema[unionKey] as unknown[];
  const variants = rawVariants.filter(isPlainObject);

  // Keep every root key except the combinators themselves.
  const { oneOf: _oneOf, anyOf: _anyOf, allOf: _allOf, ...rest } = schema;

  if (variants.length === rawVariants.length && variants.every(isMergeableObjectVariant)) {
    // Common case: all variants are object schemas — merge them.
    const properties: Record<string, unknown> = isPlainObject(rest.properties)
      ? { ...rest.properties }
      : {};
    for (const variant of variants) {
      if (isPlainObject(variant.properties)) {
        for (const [key, propSchema] of Object.entries(variant.properties)) {
          if (!(key in properties)) properties[key] = propSchema;
        }
      }
    }

    const variantRequired = variants.map((variant) => stringRequired(variant.required));
    const mergedRequired =
      unionKey === 'allOf'
        ? [...new Set(variantRequired.flat())]
        : variantRequired.reduce(
            (acc, req) => acc.filter((key) => req.includes(key)),
            variantRequired[0] ?? [],
          );
    const required = [
      ...new Set([...stringRequired(rest.required), ...mergedRequired]),
    ].filter((key) => key in properties);

    const {
      properties: _properties,
      required: _required,
      additionalProperties: _additionalProperties,
      ...restSansObjectKeys
    } = rest;

    const result: Record<string, unknown> = {
      ...restSansObjectKeys,
      type: 'object',
      properties,
    };
    if (required.length > 0) result.required = required;

    // For alternatives, preserve the union intent in prose so the model
    // still knows the arguments come in groups.
    if (unionKey !== 'allOf' && variants.length > 1) {
      const groups = variants
        .map((_, i) => {
          const req = variantRequired[i] ?? [];
          return req.length > 0 ? `(${req.join(', ')})` : '(no required fields)';
        })
        .join(' | ');
      const note = `Provide one of the following argument groups: ${groups}.`;
      result.description =
        typeof result.description === 'string' && result.description.length > 0
          ? `${result.description}\n${note}`
          : note;
    }

    return result;
  }

  // Fallback: at least one variant is not an object schema (or not a schema
  // at all). Emit a permissive object schema and carry the union into the
  // description so the intent survives.
  let note: string;
  try {
    note = `Accepts one of the following input shapes (flattened from a root-level ${unionKey}): ${JSON.stringify(rawVariants)}`;
  } catch {
    note = `Accepts one of ${rawVariants.length} alternative input shapes (root-level ${unionKey} flattened).`;
  }
  const baseDescription =
    typeof rest.description === 'string' && rest.description.length > 0
      ? `${rest.description}\n${note}`
      : note;

  return {
    type: 'object',
    properties: isPlainObject(rest.properties) ? rest.properties : {},
    additionalProperties: true,
    description:
      baseDescription.length > MAX_FALLBACK_DESCRIPTION
        ? baseDescription.slice(0, MAX_FALLBACK_DESCRIPTION)
        : baseDescription,
  };
}
