// Smart rule names are unique, and saving collapses runs of whitespace before
// storing them. A save with no id and a name that already exists updates that
// rule rather than inserting, so anything making a copy has to pick a name
// that is free once stored, not just free as typed.
export function storedSmartRuleName(name: string): string {
  return name.replace(/\s+/g, ' ').trim();
}

// "Late Night" next to an existing "Late Night" becomes "Late Night 2".
export function uniqueSmartRuleName(base: string, rules: Array<{ name: string }>): string {
  const taken = new Set(rules.map((rule) => storedSmartRuleName(rule.name)));
  const stem = storedSmartRuleName(base);
  if (!taken.has(stem)) return stem;
  for (let n = 2; ; n += 1) {
    const candidate = `${stem} ${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}
