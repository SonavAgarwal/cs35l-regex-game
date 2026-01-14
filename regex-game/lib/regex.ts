export type MatchRange = { start: number; end: number };

export function parseRegex(raw: string) {
  let pattern = raw.trim();
  let flags = "";
  if (pattern.startsWith("/") && pattern.lastIndexOf("/") > 0) {
    const lastSlash = pattern.lastIndexOf("/");
    flags = pattern.slice(lastSlash + 1);
    pattern = pattern.slice(1, lastSlash);
  }
  if (!flags.includes("g")) {
    flags += "g";
  }
  return new RegExp(pattern, flags);
}

export function buildMatchRanges(text: string, regex: RegExp) {
  const ranges: MatchRange[] = [];
  regex.lastIndex = 0;
  while (true) {
    const match = regex.exec(text);
    if (!match) {
      break;
    }
    const value = match[0] ?? "";
    if (value.length === 0) {
      if (regex.lastIndex < text.length) {
        regex.lastIndex += 1;
        continue;
      }
      break;
    }
    const start = match.index;
    const end = Math.min(text.length, start + value.length);
    if (end > start) {
      ranges.push({ start, end });
    }
  }
  return ranges;
}

export function safeRangesFromRegex(text: string, raw: string) {
  try {
    const regex = parseRegex(raw);
    return buildMatchRanges(text, regex);
  } catch (error) {
    return [];
  }
}
