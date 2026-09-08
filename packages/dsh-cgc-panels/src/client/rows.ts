/**
 * Defensive projection of platform tool payloads into table rows. The data
 * plane relays MCP tool results whose exact shape is the platform's contract;
 * the panel family renders plain text only (RSK4: no markup, no markdown —
 * React text nodes escape by construction), so unknown payloads degrade to
 * the scalar fields they carry instead of breaking the surface.
 */

/** A row extracted from a payload: a plain record with scalar fields. */
export type PayloadRow = Record<string, unknown>

/**
 * Pull the row array out of a payload: a bare array wins; otherwise the
 * first named key holding an array, then the first array-valued property.
 */
export function rowsOf(value: unknown, keys: readonly string[] = []): PayloadRow[] {
  if (Array.isArray(value)) return value.filter(isRecord)
  if (!isRecord(value)) return []
  for (const key of keys) {
    const candidate = value[key]
    if (Array.isArray(candidate)) return candidate.filter(isRecord)
  }
  for (const candidate of Object.values(value)) {
    if (Array.isArray(candidate)) return candidate.filter(isRecord)
  }
  return []
}

/** The package's canonical plain-record guard (wire payloads). */
export function isRecord(value: unknown): value is PayloadRow {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The first string/number scalar among the named fields, as text. */
export function fieldText(row: PayloadRow, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = row[key]
    if (typeof value === 'string' && value !== '') return value
    if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  }
  return undefined
}

/** A row's identifier: the first named field that reads as an id. */
export function rowId(row: PayloadRow, keys: readonly string[] = ['id']): string | undefined {
  return fieldText(row, keys)
}

/**
 * A short plain-text label line for a row: the first present scalar among
 * the preferred title-ish fields, then the id. Never returns markup — the
 * value renders as a React text node downstream.
 */
export function rowLabel(row: PayloadRow, idKeys: readonly string[]): string {
  return fieldText(row, ['title', 'name', 'label', 'summary', 'status']) ?? rowId(row, idKeys) ?? '—'
}

/** A nested record field, when present (e.g. value.enrollment). */
export function nestedRecord(value: unknown, key: string): PayloadRow | undefined {
  if (!isRecord(value)) return undefined
  const inner = value[key]
  return isRecord(inner) ? inner : undefined
}
