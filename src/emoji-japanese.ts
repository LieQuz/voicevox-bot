import emojiJapaneseNames from "./data/emoji-ja-names.json";

const sortedEmojiEntries = Object.entries(emojiJapaneseNames).sort((a, b) => b[0].length - a[0].length);

const unknownEmojiPattern =
  /(?:\p{Extended_Pictographic}(?:\uFE0F|\u{1F3FB}|\u{1F3FC}|\u{1F3FD}|\u{1F3FE}|\u{1F3FF})?)(?:\u200D\p{Extended_Pictographic}(?:\uFE0F|\u{1F3FB}|\u{1F3FC}|\u{1F3FD}|\u{1F3FE}|\u{1F3FF})?)*/gu;

export function replaceUnicodeEmojiWithJapanese(text: string): string {
  let output = text;
  for (const [emoji, name] of sortedEmojiEntries) {
    if (output.includes(emoji)) {
      output = output.split(emoji).join(` ${name} `);
    }
  }
  output = output.replace(/([\u{1F3FB}-\u{1F3FF}])/gu, "");
  return output;
}

export function replaceUnknownEmojiWithFallback(text: string): string {
  return text.replace(unknownEmojiPattern, (match) => {
    if (/^[\s\S]*[ぁ-んァ-ヶ一-龯ー][\s\S]*$/.test(match)) {
      return match;
    }
    return " 絵文字 ";
  });
}
