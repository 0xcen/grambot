// The emoji Telegram accepts in ReactionTypeEmoji, copied from the Bot API reference.
// Telegram spells them without the U+FE0F variation selector, so input is compared
// and sent with it stripped.
export const REACTION_EMOJI: ReadonlySet<string> = new Set([
  "❤", "👍", "👎", "🔥", "🥰", "👏", "😁", "🤔", "🤯", "😱", "🤬", "😢", "🎉", "🤩", "🤮", "💩",
  "🙏", "👌", "🕊", "🤡", "🥱", "🥴", "😍", "🐳", "❤‍🔥", "🌚", "🌭", "💯", "🤣", "⚡", "🍌", "🏆",
  "💔", "🤨", "😐", "🍓", "🍾", "💋", "🖕", "😈", "😴", "😭", "🤓", "👻", "👨‍💻", "👀", "🎃", "🙈",
  "😇", "😨", "🤝", "✍", "🤗", "🫡", "🎅", "🎄", "☃", "💅", "🤪", "🗿", "🆒", "💘", "🙉", "🦄",
  "😘", "💊", "🙊", "😎", "👾", "🤷‍♂", "🤷", "🤷‍♀", "😡",
]);

/** Returns Telegram's spelling of a single allowed reaction emoji, or null. */
export function toReactionEmoji(input: string): string | null {
  const emoji = input.trim().replace(/\uFE0F/g, "");
  return REACTION_EMOJI.has(emoji) ? emoji : null;
}
