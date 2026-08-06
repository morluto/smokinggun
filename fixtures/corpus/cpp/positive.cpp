int lookup(const std::vector<int>& items, int wanted) {
  for (int value : items) {
    if (items.find(wanted) != items.end()) return value;
  }
  return -1;
}
