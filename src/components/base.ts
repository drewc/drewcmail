import { LitElement, unsafeCSS, type CSSResultGroup } from 'lit'
import tailwind from './tailwind.css?inline'
import fontawesome from '@fortawesome/fontawesome-free/css/all.min.css?inline'

/**
 * Every component extends BaseElement: its shadow root adopts Tailwind and Font
 * Awesome. @spinal/shadow-css (vite.config.js) has already removed what a shadow
 * root cannot use — @font-face and @property — and lifted it into the document
 * (src/main.ts imports it). Subclasses add their own styles with
 * `static styles = [...BaseElement.styles, css`…`]`.
 */

const sheets = [unsafeCSS(tailwind), unsafeCSS(fontawesome)]
const dark = window.matchMedia('(prefers-color-scheme: dark)')

export class BaseElement extends LitElement {
  static styles: CSSResultGroup = sheets

  private _theme = () => { this.dataset.theme = dark.matches ? 'dark' : 'light' }

  connectedCallback() {
    super.connectedCallback()
    this._theme()
    dark.addEventListener('change', this._theme)
  }

  disconnectedCallback() {
    dark.removeEventListener('change', this._theme)
    super.disconnectedCallback()
  }

  /** a bubbling, composed event — crosses shadow roots up to <mail-app> */
  emit<T>(name: string, detail?: T) {
    this.dispatchEvent(new CustomEvent(name, { detail, bubbles: true, composed: true }))
  }
}

/** Font Awesome icon */
export const fa = (name: string, style = 'solid') => `fa-${style} fa-${name}`
