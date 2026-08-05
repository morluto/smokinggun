package corpus

func lookup(items []int, wanted int) int {
	for _, value := range items {
		for _, candidate := range items {
			if candidate == wanted { return value }
		}
	}
	return -1
}
