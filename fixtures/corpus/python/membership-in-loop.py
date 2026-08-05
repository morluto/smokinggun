def find_matches(items, allowed):
    matches = []
    for item in items:
        if item in allowed:
            matches.append(item)
    return matches
