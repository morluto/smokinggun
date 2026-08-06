def lookup(items, wanted)
  items.each do |value|
    items.find(wanted)
    return value if value == wanted
  end
  nil
end
