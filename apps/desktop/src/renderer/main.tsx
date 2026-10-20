import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import { App } from './App'
import '@fontsource-variable/roboto-flex/full.css'
import './styles/index.css'

const container = document.getElementById('root')
if (!container) throw new Error('Missing root element')

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
