// The search and sort last used in Resumen, so "← Resumen" from another
// screen goes back to the same list. It lasts until the page reloads.

let lastSearch = ''

export function rememberResumenSearch(search: string): void {
  lastSearch = search
}

/** The path back to Resumen, with its last search and sort. */
export function resumenPath(): string {
  return lastSearch === '' ? '/' : `/?${lastSearch}`
}
