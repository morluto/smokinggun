class Positive {
  int lookup(java.util.List<Integer> items, int wanted) {
    for (Integer value : items) {
      if (items.contains(wanted)) return value;
    }
    return -1;
  }
}
