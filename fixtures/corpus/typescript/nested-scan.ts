export function collect(items: string[], wanted: string): string[] {
  const result: string[] = [];
  for (const item of items) {
    if (items.includes(wanted)) result.push(item);
  }
  return result;
}
