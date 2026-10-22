/** A small chip naming the device a chat, helper or desk runs on, when that is not the computer in front of you. */
export function PlaceChip({ name }: { name: string }): JSX.Element | null {
  if (name === '') return null
  return (
    <span className="place-chip" title={`Runs on ${name}. You can message it from here.`}>
      {name}
    </span>
  )
}
