/** Interoperable group-chat palette inspired by common Feishu/DingTalk reactions (50 in total). */
export const GROUP_EMOJIS = ["👍", "👌", "🙏", "💪", "❤️", "💔", "👏", "🎉", "✅", "🔥", "⭐", "💯", "✨", "🌟", "💡", "🍻", "🎊", "🚀", "⚡", "☕", "👋", "🤝", "😊", "😄", "😂", "🤣", "😍", "😎", "😉", "🤔", "😮", "😭", "😢", "🌹", "😘", "🥰", "😁", "😆", "😅", "🤩", "😜", "🤗", "😴", "🤯", "😱", "🥺", "😏", "🙄", "😬", "👀"] as const;

export function isGroupEmoji(value: unknown): value is typeof GROUP_EMOJIS[number] {
  return typeof value === "string" && GROUP_EMOJIS.includes(value as typeof GROUP_EMOJIS[number]);
}
