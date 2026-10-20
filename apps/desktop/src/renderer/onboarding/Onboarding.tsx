import type { OnboardingStep } from '../state/route'
import { Ai } from './Ai'
import { SignIn } from './SignIn'
import { Style } from './Style'
import { Sync } from './Sync'

export function Onboarding({ step }: { step: OnboardingStep }): JSX.Element {
  if (step === 'sync') return <Sync />
  if (step === 'ai') return <Ai />
  if (step === 'style') return <Style />
  return <SignIn />
}
