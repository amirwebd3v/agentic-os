export type DiffLine = { op: ' ' | '-' | '+'; text: string };

/** LCS diff of two token lists. ponytail: O(n·m) memory; fine for notes, switch to Myers if huge files show up. */
function diff(a: string[], b: string[]): DiffLine[] {
  const lcs = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      out.push({ op: ' ', text: a[i++]! });
      j++;
    } else if (j < b.length && (i === a.length || lcs[i]![j + 1]! >= lcs[i + 1]![j]!)) out.push({ op: '+', text: b[j++]! });
    else out.push({ op: '-', text: a[i++]! });
  }
  return out;
}

export const lineDiff = (before: string, after: string): DiffLine[] => diff(before.split(/\r?\n/), after.split(/\r?\n/));

/** Word diff of one line, each word keeping its trailing space; runs of the same op are merged. */
export function wordDiff(before: string, after: string): DiffLine[] {
  const words = (s: string) => s.match(/\S+\s*/g) ?? [];
  const out: DiffLine[] = [];
  for (const d of diff(words(before), words(after))) {
    const last = out.at(-1);
    if (last?.op === d.op) last.text += d.text;
    else out.push({ ...d });
  }
  return out;
}
