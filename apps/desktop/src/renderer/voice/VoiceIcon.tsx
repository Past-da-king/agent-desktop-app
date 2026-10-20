/** The few voice glyphs the shared icon set does not have, drawn in the same 2px stroke style. */
const PATHS = {
  handset: (
    <path d="M6.6 3.5h2.6l1.4 4-1.9 1.3a10.6 10.6 0 0 0 6.5 6.5l1.3-1.9 4 1.4v2.6a2 2 0 0 1-2.2 2A16 16 0 0 1 4.6 5.7a2 2 0 0 1 2-2.2Z" />
  ),
  hangup: (
    <path d="M3.2 14.6c-.5-.5-.5-1.3 0-1.8a12.5 12.5 0 0 1 17.6 0c.5.5.5 1.3 0 1.8l-1.6 1.6c-.4.4-1.1.5-1.6.2l-2-1.2c-.4-.3-.7-.7-.7-1.2v-1.6a9.6 9.6 0 0 0-5.8 0V14c0 .5-.3.9-.7 1.2l-2 1.2c-.5.3-1.2.2-1.6-.2Z" />
  ),
  micoff: (
    <>
      <path d="M15 10V6.5a3 3 0 0 0-5.6-1.5M9 9v1.5a3 3 0 0 0 4.6 2.5" />
      <path d="M18.5 11.5a6.5 6.5 0 0 1-1 3.4M5.5 11.5a6.5 6.5 0 0 0 10.4 5.2M12 18v3M4 4l16 16" />
    </>
  ),
  speaker: (
    <>
      <path d="M4 9.5v5h3.5L12 18.5v-13L7.5 9.5Z" />
      <path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11" />
    </>
  ),
  wave: <path d="M4 12h1.5M8 8v8M12 5v14M16 8v8M19.5 12H20" />,
}

export type VoiceIconName = keyof typeof PATHS

export function VoiceIcon({ name, size = 22 }: { name: VoiceIconName; size?: number }): JSX.Element {
  return (
    <svg
      className="ico"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {PATHS[name]}
    </svg>
  )
}
