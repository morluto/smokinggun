func lookup(_ items: [Int], _ wanted: Int) -> Int {
    for value in items {
        if items.contains(wanted) { return value }
    }
    return -1
}
