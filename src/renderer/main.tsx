import { createRoot } from 'react-dom/client'
import './styles.css'
import { App } from './App'
import { ErrorBoundary } from './panels/ErrorBoundary'

createRoot(document.getElementById('root')!).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>
)
