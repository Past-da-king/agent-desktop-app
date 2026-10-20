import { useState } from 'react'

import { AboutDialog } from './ui/AboutDialog'

export function App(): JSX.Element {
  const [aboutOpen, setAboutOpen] = useState(false)

  return (
    <main className="boot">
      <h1 className="boot-wordmark">Agent</h1>
      <button type="button" className="about-link" onClick={() => setAboutOpen(true)}>
        About Agent
      </button>
      <AboutDialog open={aboutOpen} onClose={() => setAboutOpen(false)} />
    </main>
  )
}
