/**
 * Builds src/data/emoji-ja-names.json from yagays/emoji-ja (MIT).
 * https://github.com/yagays/emoji-ja
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SOURCE_URL = "https://raw.githubusercontent.com/yagays/emoji-ja/master/data/emoji_ja.json";
const __dirname = dirname(fileURLToPath(import.meta.url));
const outputPath = join(__dirname, "..", "src", "data", "emoji-ja-names.json");

const response = await fetch(SOURCE_URL);
if (!response.ok) {
  throw new Error(`Failed to fetch emoji_ja.json: ${response.status} ${response.statusText}`);
}

/** @type {Record<string, { short_name?: string; group?: string }>} */
const source = await response.json();
/** @type {Record<string, string>} */
const map = {};

for (const [emoji, meta] of Object.entries(source)) {
  const shortName = meta?.short_name?.trim();
  if (!shortName) {
    continue;
  }
  // Unicode 絵文字グループに属するエントリのみ（記号・括弧などを除外）
  if (!meta.group) {
    continue;
  }
  map[emoji] = shortName;
}

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(map, null, 0)}\n`, "utf8");
console.log(`Wrote ${Object.keys(map).length} entries to ${outputPath}`);
