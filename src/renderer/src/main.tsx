import './assets/main.css'
import './assets/telopFonts.css'
import './assets/uiFonts.css'
import './assets/graphite3.css'
import './assets/timelineG3.css'
import './assets/autoEditG3.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { ErrorBoundary } from './components/ErrorBoundary'
import { installRendererErrorLogging } from './lib/errorReporting'

installRendererErrorLogging()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>
)
