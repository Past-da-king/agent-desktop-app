import type { ReactNode } from 'react'

import { ONBOARDING_STEPS, type OnboardingStep } from '../state/route'
import { useSettings } from '../state/useSettings'
import { Icon } from '../ui/Icon'
import { Mascot } from '../ui/Mascot'

function Hero(): JSX.Element {
  const settings = useSettings((state) => state.settings)
  return (
    <section className="ob-hero">
      <div style={{ position: 'relative' }}>
        <div className="eyebrow">MEET YOUR AGENT, ON YOUR COMPUTER</div>
        <h1 className="h1" style={{ marginTop: 14 }}>
          The same agent.
          <br />
          Now with a bigger desk.
        </h1>
      </div>
      <div className="big-mascot">
        <Mascot id={settings?.mascot ?? 'scout'} size={300} busy />
      </div>
      <div style={{ position: 'relative' }}>
        <p>
          Everything your phone agent knows comes with you: memory, to-dos, routines and your chats. Start something
          on the couch, finish it here.
        </p>
        <div className="pair" aria-hidden="true">
          <div className="dev phone">
            <div className="eyebrow" style={{ fontSize: 11, lineHeight: '14px' }}>
              PHONE
            </div>
            <div className="bub">Hold the 06:05</div>
            <div className="agt">On it, Sam.</div>
            <div className="ln" />
          </div>
          <div className="sync">
            <Icon name="sync" size={26} />
          </div>
          <div className="dev desk">
            <div className="eyebrow" style={{ fontSize: 11, lineHeight: '14px' }}>
              THIS COMPUTER
            </div>
            <div className="bub">Hold the 06:05</div>
            <div className="agt">On it, Sam. Booking is waiting for your OK.</div>
            <div className="ln" style={{ width: '70%' }} />
          </div>
        </div>
      </div>
    </section>
  )
}

function Dots({ step }: { step: OnboardingStep }): JSX.Element {
  const index = ONBOARDING_STEPS.indexOf(step)
  return (
    <div className="dots" aria-label={`Step ${index + 1} of 4`}>
      {ONBOARDING_STEPS.map((item, position) => (
        <i key={item} className={position < index ? 'done' : position === index ? 'cur' : ''} />
      ))}
    </div>
  )
}

export function OnboardingLayout({
  step,
  children,
}: {
  step: OnboardingStep
  children: ReactNode
}): JSX.Element {
  return (
    <div className="ob">
      <Hero />
      <main className="ob-main">
        <Dots step={step} />
        {children}
      </main>
    </div>
  )
}
