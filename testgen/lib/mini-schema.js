// schema/*.schema.json の部分集合を確かめる、試験用の小さな検査器（core/validate.js とは別に、担当 E が自分で書いたもの）。
// type、properties、required、additionalProperties（真偽）、items、enum、const、pattern、
// minimum、maximum、minLength、maxLength、minItems、maxItems、oneOf。
/** @returns {string[]} 誤りの一覧（空なら適合） */
export function validateSchema(schema, value, path = '$') {
  const errs = [];
  const typeOk = (t, v) => {
    switch (t) {
      case 'object': return v !== null && typeof v === 'object' && !Array.isArray(v);
      case 'array': return Array.isArray(v);
      case 'string': return typeof v === 'string';
      case 'integer': return Number.isInteger(v);
      case 'number': return typeof v === 'number' && Number.isFinite(v);
      case 'boolean': return typeof v === 'boolean';
      case 'null': return v === null;
      default: return true;
    }
  };
  if (schema.oneOf) {
    const results = schema.oneOf.map((s) => validateSchema(s, value, path));
    const okCount = results.filter((r) => r.length === 0).length;
    if (okCount !== 1) errs.push(`${path}: oneOf matched ${okCount} branches`);
    return errs;
  }
  if (schema.const !== undefined && JSON.stringify(schema.const) !== JSON.stringify(value)) errs.push(`${path}: const ${JSON.stringify(schema.const)}`);
  if (schema.enum && !schema.enum.some((e) => JSON.stringify(e) === JSON.stringify(value))) errs.push(`${path}: not in enum`);
  if (schema.type && !typeOk(schema.type, value)) {
    errs.push(`${path}: expected ${schema.type}`);
    return errs;
  }
  if (typeof value === 'string') {
    if (schema.pattern && !new RegExp(schema.pattern, 'u').test(value)) errs.push(`${path}: pattern ${schema.pattern}`);
    if (schema.minLength !== undefined && [...value].length < schema.minLength) errs.push(`${path}: minLength`);
    if (schema.maxLength !== undefined && [...value].length > schema.maxLength) errs.push(`${path}: maxLength`);
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) errs.push(`${path}: minimum ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) errs.push(`${path}: maximum ${schema.maximum}`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) errs.push(`${path}: minItems`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errs.push(`${path}: maxItems`);
    if (schema.items) value.forEach((v, i) => errs.push(...validateSchema(schema.items, v, `${path}[${i}]`)));
  }
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    for (const k of schema.required ?? []) if (!(k in value)) errs.push(`${path}: missing ${k}`);
    const props = schema.properties ?? {};
    for (const [k, v] of Object.entries(value)) {
      if (props[k]) errs.push(...validateSchema(props[k], v, `${path}.${k}`));
      else if (schema.additionalProperties === false) errs.push(`${path}: unexpected ${k}`);
    }
  }
  return errs;
}
