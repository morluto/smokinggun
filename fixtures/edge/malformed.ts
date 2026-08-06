export function malformed(items: number[]) {
  for (const item of items) {
    if (items.includes(item)) {
      return item;
