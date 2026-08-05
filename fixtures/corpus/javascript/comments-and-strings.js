// for (const item of items) { items.includes(item); }
const message = "sort(items) inside a loop is only documentation";
export function safe(items) {
  return items.map((item) => item.trim());
}
