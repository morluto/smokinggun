int Lookup(List<int> items, int wanted) {
  foreach (var value in items) {
    if (items.Contains(wanted)) return value;
  }
  return -1;
}
