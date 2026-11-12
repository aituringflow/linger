/** Neutral group avatar used when a group has no uploaded image. */
export function GroupAvatarIcon() {
  return <svg className="group-avatar-icon" viewBox="0 0 32 32" fill="currentColor" aria-hidden="true">
    <circle cx="13" cy="11" r="4" />
    <path d="M5 24c0-4.1 3.2-7 8-7s8 2.9 8 7v1H5z" />
    <circle cx="23" cy="12" r="3" />
    <path d="M21 18c3.8-.4 6 2.1 6 5.5V25h-4v-1c0-2.2-.7-4.2-2-6z" />
  </svg>;
}
