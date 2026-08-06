export function lookup(items: number[], wanted: number): number | undefined {
  for (const value of items) {
    if (items.includes(wanted)) return value;
  }
  return undefined;
}
