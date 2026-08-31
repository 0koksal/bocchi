import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { AuxWindow } from './components/AuxWindow'
import './assets/auxWindow.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AuxWindow />
  </StrictMode>
)
