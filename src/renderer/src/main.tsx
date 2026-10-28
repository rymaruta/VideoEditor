import './assets/main.css'
import './assets/tokens.css'
import './assets/telopFonts.css'
import './assets/uiFonts.css'
import './assets/graphite3.css'
import './assets/timelineG3.css'
import './assets/autoEditG3.css'
import './assets/dialogsG3.css'
import './assets/windowsG3.css'
import './assets/shellG4.css'
import './assets/featuresG5.css'
import './assets/screensG6.css'

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
