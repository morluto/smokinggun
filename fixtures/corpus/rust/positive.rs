fn lookup(items: &[i32], wanted: i32) -> i32 {
    for value in items {
        if items.contains(&wanted) { return *value; }
    }
    -1
}
