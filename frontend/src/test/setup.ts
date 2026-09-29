import '@testing-library/jest-dom'
import { vi } from 'vitest'

// Mock global objects that might not be available in test environment
global.fetch = global.fetch || vi.fn()

// Mock ResizeObserver
global.ResizeObserver = global.ResizeObserver || class ResizeObserver {
  constructor(cb: any) {
    this.cb = cb
  }
  observe() {
    this.cb([{ borderBoxSize: { inlineSize: 0, blockSize: 0 } }], this)
  }
  unobserve() {}
  disconnect() {}
  cb: any
}

// Mock matchMedia
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: vi.fn().mockImplementation(query => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(), // deprecated
    removeListener: vi.fn(), // deprecated
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
})
// jsdom leaves `isSecureContext` undefined; tests run as a localhost origin
// (a secure context). Tests of the plain-HTTP clipboard fallback override it.
if (typeof window !== 'undefined' && window.isSecureContext === undefined) {
  Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true, writable: true })
}
