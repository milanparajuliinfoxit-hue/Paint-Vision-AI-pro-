// Project timestamps render in the viewer's own locale; compact where space
// is tight (cards, tables), with the year where the list spans older work.
export function formatShortDate(iso) {
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function formatShortDateWithYear(iso) {
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}
