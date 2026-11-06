import { readFile } from 'node:fs/promises'
import tailwindcss from '@tailwindcss/postcss'
import react from '@vitejs/plugin-react'
import { defineConfig, transformWithOxc, type Plugin } from 'vite'
import { networkOrigins } from './scripts/lib/csp.ts'

// What a production build may load, and from where. Everything a store,
// driver or customer publishes is shown in this app -- names, photos,
// notes -- so the browser itself refuses anything but this app's own code,
// inline images, the conductor's local websocket, and the outside services the
// network's own settings name. Even if a
// published entry ever slipped past validation, it couldn't load a tracking
// pixel or a script. Build-only: Vite's dev server needs inline scripts.
//
// The one exception is paying by card: each payee's processor's own card
// form (src/lib/payments/cardForm.ts), in its own frames, from its own
// domains -- Stripe's, Square's or Clover's, and the bank checks (3-D
// Secure) they run, and Google Pay's own sheet for Square. Card details
// go only there, never to this app.
const CARD_FORMS = {
  script: ["https://js.stripe.com", "https://web.squarecdn.com", "https://sandbox.web.squarecdn.com", "https://checkout.clover.com", "https://checkout.sandbox.dev.clover.com", "https://pay.google.com"],
  frame: ["https://js.stripe.com", "https://hooks.stripe.com", "https://web.squarecdn.com", "https://sandbox.web.squarecdn.com", "https://*.cardinalcommerce.com", "https://checkout.clover.com", "https://checkout.sandbox.dev.clover.com", "https://pay.google.com"],
  connect: ["https://api.stripe.com", "https://pci-connect.squareup.com", "https://pci-connect.squareupsandbox.com", "https://token.clover.com", "https://token-sandbox.dev.clover.com", "https://pay.google.com"],
  font: ["https://*.squarecdn.com"],
}
// The servers this network's own settings name: its map tiles, address search,
// routing, push relay and time relays (scripts/lib/csp.ts). `npm run package`
// passes the properties it's packaging; otherwise, the network's defaults.
const NETWORK = networkOrigins(JSON.parse(process.env.HANDSHAKE_NETWORK_PROPERTIES ?? '{}'))

const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  `script-src 'self' ${CARD_FORMS.script.join(' ')}`,
  `frame-src ${CARD_FORMS.frame.join(' ')}`,
  // Leaflet and the UI's animations set inline style attributes.
  "style-src 'self' 'unsafe-inline'",
  `img-src 'self' data: blob: ${NETWORK.img.join(' ')} https://*.stripe.com`,
  `connect-src 'self' ws://localhost:* ws://127.0.0.1:* ${NETWORK.connect.join(' ')} ${CARD_FORMS.connect.join(' ')}`,
  `font-src 'self' ${CARD_FORMS.font.join(' ')}`,
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ')

function contentSecurityPolicy(): Plugin {
  return {
    name: 'handshake-content-security-policy',
    apply: 'build',
    transformIndexHtml: (html) => html.replace('<head>', `<head>\n    <meta http-equiv="Content-Security-Policy" content="${CONTENT_SECURITY_POLICY}" />`),
  }
}

// The service worker (src/sw.ts), compiled on its own to /sw.js: the browser
// registers it by that URL (src/main.tsx), and it runs as a classic script,
// outside the app's bundle. Build-only, like its registration.
function serviceWorker(): Plugin {
  return {
    name: 'handshake-service-worker',
    apply: 'build',
    async generateBundle() {
      const source = await readFile(new URL('./src/sw.ts', import.meta.url), 'utf8')
      const { code } = await transformWithOxc(source, 'sw.ts', { lang: 'ts' })
      this.emitFile({ type: 'asset', fileName: 'sw.js', source: code })
    },
  }
}

// https://vite.dev/config/
export default defineConfig(({ mode }) => ({
  plugins: [react(), contentSecurityPolicy(), serviceWorker()],
  css: { postcss: { plugins: [tailwindcss()] } },
  // Relative asset paths, so a runtime can serve the build from wherever it
  // unpacks it (a `.webhapp` -- see docs/DEPLOYMENT.md).
  base: './',
  define: {
    // Whether this build carries the dev host's identity code (Admin API,
    // passkeys) -- see src/holochain/host.ts. A literal, so production
    // builds drop that code entirely.
    __DEV_HOST__: JSON.stringify(mode === 'development' || process.env.VITE_HANDSHAKE_DEV_HOST === 'true'),
  },
}))
