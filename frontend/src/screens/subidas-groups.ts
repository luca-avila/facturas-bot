import type { UploadRow } from '../accounts-api'
import { formatDate } from '../format'

export interface DayGroup {
  label: string
  rows: UploadRow[]
}

function dayLabel(row: UploadRow): string {
  if (row.daysAgo === 0) return 'Hoy'
  if (row.daysAgo === 1) return 'Ayer'
  return formatDate(row.uploadedOn)
}

/** Consecutive rows of the same day, in the order received: *Hoy*, *Ayer*, then the date. */
export function groupByDay(rows: UploadRow[]): DayGroup[] {
  const groups: { daysAgo: number; group: DayGroup }[] = []
  for (const row of rows) {
    const last = groups.at(-1)
    if (last !== undefined && last.daysAgo === row.daysAgo) {
      last.group.rows.push(row)
    } else {
      groups.push({ daysAgo: row.daysAgo, group: { label: dayLabel(row), rows: [row] } })
    }
  }
  return groups.map(({ group }) => group)
}
