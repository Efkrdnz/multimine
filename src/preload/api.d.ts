import type { Bridge } from '../shared/api'

declare global {
  interface Window {
    mm: Bridge
  }
}
export {}
