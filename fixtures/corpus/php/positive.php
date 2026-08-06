<?php
function lookup(array $items, int $wanted): int {
    foreach ($items as $value) {
        if (in_array($wanted, $items, true)) return $value;
    }
    return -1;
}
