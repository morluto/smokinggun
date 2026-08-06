export function lookup(items, wanted) {
  for (const value of items) {
    if (items.includes(wanted)) return value;
  }
  return undefined;
}
