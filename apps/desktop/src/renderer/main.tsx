import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import { App } from './App'
import { agent } from './bridge'
import './styles/fonts.css'
import './styles/index.css'

// In the real app the window itself is the frame: no desk, no inner window. The browser preview keeps the frame.
document.documentElement.classList.toggle('native', agent.platform !== 'web')
document.documentElement.dataset['platform'] = agent.platform

const container = document.getElementById('root')
if (!container) throw new Error('Missing root element')

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
