export function alreadyIndexed(items: string[], index: Set<string>): boolean {
  return items.every((item) => index.has(item));
}
