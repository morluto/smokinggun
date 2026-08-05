int lookup(int *items, int count, int wanted) {
  for (int i = 0; i < count; i++) {
    for (int j = 0; j < count; j++) {
      if (items[j] == wanted) return j;
    }
  }
  return -1;
}
