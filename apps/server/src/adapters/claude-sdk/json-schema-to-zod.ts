import { z, type ZodRawShape, type ZodTypeAny } from 'zod';

/**
 * The brains' tools are declared with JSON Schema (`ToolDefinition.inputSchema`, runtime
 * agnostic); the Claude Agent SDK wants a zod raw shape. This covers the subset brain tools use:
 * string (with enum), number/integer, boolean, array, nested object, `description`, `required`.
 * Anything else becomes `unknown`, which the model still sees with its description.
 */
export function jsonSchemaToZodShape(schema: Record<string, unknown>): ZodRawShape {
  const properties = (schema['properties'] ?? {}) as Record<string, Record<string, unknown>>;
  const required = new Set((schema['required'] as string[] | undefined) ?? []);
  const shape: Record<string, ZodTypeAny> = {};
  for (const [name, prop] of Object.entries(properties)) {
    let type = toZod(prop);
    if (!required.has(name)) type = type.optional();
    shape[name] = type;
  }
  return shape as ZodRawShape;
}

function toZod(prop: Record<string, unknown>): ZodTypeAny {
  const description = typeof prop['description'] === 'string' ? prop['description'] : undefined;
  let type: ZodTypeAny;
  const kind = Array.isArray(prop['type']) ? (prop['type'] as string[])[0] : prop['type'];
  switch (kind) {
    case 'string':
      type = Array.isArray(prop['enum'])
        ? z.enum((prop['enum'] as string[]).map(String) as [string, ...string[]])
        : z.string();
      break;
    case 'number':
      type = z.number();
      break;
    case 'integer':
      type = z.number().int();
      break;
    case 'boolean':
      type = z.boolean();
      break;
    case 'array': {
      const items = prop['items'];
      type = z.array(
        items && typeof items === 'object' ? toZod(items as Record<string, unknown>) : z.unknown(),
      );
      break;
    }
    case 'object':
      type = prop['properties']
        ? z.object(jsonSchemaToZodShape(prop))
        : z.record(z.string(), z.unknown());
      break;
    default:
      type = z.unknown();
  }
  if (prop['nullable'] === true) type = type.nullable();
  return description ? type.describe(description) : type;
}
