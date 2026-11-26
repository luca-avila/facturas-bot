import type { ErrorDocumentRow } from '../accounts-api'

export interface SupplierTermGroup {
  supplier: { id: string; name: string }
  documents: ErrorDocumentRow[]
  suggestedTermDays: number | null
}

export interface ResolverLayout {
  termGroups: SupplierTermGroup[]
  ungrouped: ErrorDocumentRow[]
}

function commonSuggestedTerm(documents: readonly ErrorDocumentRow[]): number | null {
  const suggestions = documents.map((doc) => doc.suggestedTermDays).filter((days): days is number => days !== null)
  if (suggestions.length === 0) return null
  const first = suggestions[0]
  return suggestions.every((days) => days === first) ? first : null
}

/**
 * Groups suppliers with 2 or more `supplier_term_missing` documents into banner
 * cards at the top of *A resolver* (6a), keeping all other rows in order.
 */
export function groupResolverDocuments(documents: readonly ErrorDocumentRow[]): ResolverLayout {
  const bySupplier = new Map<string, { supplier: { id: string; name: string }; documents: ErrorDocumentRow[] }>()

  for (const row of documents) {
    if (row.supplier === null || !row.issues.includes('supplier_term_missing')) continue
    const existing = bySupplier.get(row.supplier.id)
    if (existing !== undefined) {
      existing.documents.push(row)
    } else {
      bySupplier.set(row.supplier.id, { supplier: row.supplier, documents: [row] })
    }
  }

  const termGroups: SupplierTermGroup[] = []
  const groupedIds = new Set<string>()
  for (const group of bySupplier.values()) {
    if (group.documents.length < 2) continue
    for (const doc of group.documents) groupedIds.add(doc.id)
    termGroups.push({
      supplier: group.supplier,
      documents: group.documents,
      suggestedTermDays: commonSuggestedTerm(group.documents),
    })
  }

  return {
    termGroups,
    ungrouped: documents.filter((doc) => !groupedIds.has(doc.id)),
  }
}
