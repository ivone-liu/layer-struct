export function parseJsonObject<T>(raw: string): T {
  const trimmed = raw.trim();
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    const match = trimmed.match(/\{[\s\S]*\}/);
    if (!match) {
      throw new Error("Model response did not contain a JSON object.");
    }
    return JSON.parse(match[0]) as T;
  }
}
