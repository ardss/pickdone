<template>
  <div class="tab-panel">
    <!-- The root must stay a single element (no comment before the root div): a comment sibling
         before the root makes the component root a Fragment and Vue cannot apply the parent's
         v-show directive in dev builds (dev compiler keeps comments; prod strips them). -->
    <!-- Capture endpoint tab (S4 browser-extension track, P0). DEFAULT OFF: the switch below
         starts at false and nothing in the app exposes the endpoint until the user turns it on. -->
    <div class="form">
      <div class="form-label">Browser capture</div>
      <div class="form-item">
        <span class="form-item__label">Local capture endpoint</span>
        <div class="form-item__control">
          <el-switch :model-value="captureEnabled" :disabled="!loaded" @change="toggleCapture"/>
        </div>
      </div>
      <!-- Key visible only while it exists in plaintext (just minted, or plaintext fallback).
           Once the main process has encrypted it at rest (safeStorage), the raw meta value is
           the 'enc1:' blob — shown as "stored encrypted" instead of garbage. -->
      <div class="form-item" v-if="captureEnabled && captureKey">
        <span class="form-item__label">Access key</span>
        <div class="form-item__control">
          <span class="tip capture-key-text">{{ captureKey }}</span>
          <button class="mini capture-copy-btn" @click="copyKey">Copy</button>
          <button class="mini capture-regen-btn" @click="regenKey">Regenerate</button>
        </div>
      </div>
      <div class="form-item" v-if="captureEnabled && storedEncrypted">
        <span class="form-item__label">Access key</span>
        <div class="form-item__control">
          <span class="tip capture-key-text">Stored encrypted (OS keyring). Regenerate to set a new visible key.</span>
          <button class="mini capture-regen-btn" @click="regenKey">Regenerate</button>
        </div>
      </div>
      <!-- Plaintext fallback warning: main-process safeStorage unavailable → the key sits in
           meta unencrypted. Machine-local ('_' keys never sync), but readable in the db file. -->
      <div class="form-item form-item--bare" v-if="captureEnabled && plaintextFallback">
        <div class="form-item__control">
          <span class="tip capture-plaintext-warning">⚠ Plaintext fallback: the OS keyring is unavailable, so the access key is stored unencrypted. It never leaves this machine ('_' meta keys are excluded from sync), but it is readable in the database file.</span>
        </div>
      </div>
      <div class="form-item" v-if="captureEnabled">
        <span class="form-item__label">Endpoint URL</span>
        <div class="form-item__control">
          <span class="tip capture-endpoint-text">{{ captureEndpoint }}</span>
          <button class="mini capture-copy-btn" @click="copyEndpoint">Copy</button>
        </div>
      </div>
      <div class="form-item form-item--bare" v-if="captureEnabled">
        <div class="form-item__control">
          <span class="tip">The browser extension (popup) posts to the endpoint URL above with the X-PickDone-Key header set to the key. Regenerating invalidates the old key immediately. The endpoint stays fully OFF (every request rejected) until this switch is on.</span>
        </div>
      </div>
    </div>
  </div>
</template>

<script lang="ts">
/** Capture-endpoint settings tab (S4 browser-extension track). Talks to the machine-local meta
 *  rows directly: '_captureEndpointEnabled' / '_captureEndpointSecret' — both '_'-prefixed, so
 *  the shared machine-local-keys filter keeps them OFF every sync egress (a captured secret or
 *  endpoint toggle can never ride the LAN/cloud sync to a peer). Writes go through the SAME
 *  command-bus facade every other settings surface uses (commit('meta','put',…)); reads go
 *  through the whitelisted getMetaMany batch read. No i18n keys exist for this tab yet and the
 *  i18n lexicon is outside this slice's allowed paths — the labels are literal strings.
 *
 *  Secret-at-rest: the main process encrypts the meta row with safeStorage when the OS keyring
 *  is available ('enc1:'-prefixed blob). This tab detects that state — showing a placeholder
 *  instead of the blob — and shows a PLAINTEXT FALLBACK warning when the key is stored in the
 *  clear (no keyring). The extension default endpoint literal must match
 *  src/main/capture-endpoint/contract.cjs (asserted by the contract test). */
import { commit } from '../../utils/commandBus.js'

const META_ENABLED_KEY = '_captureEndpointEnabled'
const META_SECRET_KEY = '_captureEndpointSecret'
// MUST equal src/main/capture-endpoint/contract.cjs DEFAULT_CAPTURE_ENDPOINT — the
// contract test (tests/unit/main/capture-endpoint/contract.test.mjs) asserts this literal.
const CAPTURE_ENDPOINT_URL = 'http://127.0.0.1:7789/capture'
const SECRET_ENC_PREFIX = 'enc1:' // mirrors capture-endpoint/index.js

/** 48-hex-char key (24 random bytes) — same shape/entropy as the main-process secret.js. */
function randomKey () {
  const bytes = new Uint8Array(24)
  const c = (typeof crypto !== 'undefined' && crypto.getRandomValues) ? crypto : window.crypto
  c.getRandomValues(bytes)
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')
}

export default {
  name: 'SettingsCaptureTab',
  data () {
    return {
      loaded: false, // the switch stays disabled until the meta read lands (no boot flicker)
      captureEnabled: false, // DEFAULT OFF — absent meta rows mean OFF, never ON
      captureKey: '', // visible only while stored in plaintext ('' when encrypted at rest)
      storedEncrypted: false, // meta row is an 'enc1:' safeStorage blob
      captureEndpoint: CAPTURE_ENDPOINT_URL,
      copied: false
    }
  },
  computed: {
    plaintextFallback () {
      return this.captureEnabled && !this.storedEncrypted && !!this.captureKey
    }
  },
  mounted () { this.refresh() },
  beforeUnmount () { if (this._copiedTimer) clearTimeout(this._copiedTimer) },
  methods: {
    async refresh () {
      try {
        const rows = await window.todoAPI.getMetaMany([META_ENABLED_KEY, META_SECRET_KEY])
        const map = {}
        for (const r of (rows || [])) map[r.key] = r.value
        this.captureEnabled = map[META_ENABLED_KEY] === '1'
        const raw = map[META_SECRET_KEY] || ''
        this.storedEncrypted = raw.startsWith(SECRET_ENC_PREFIX)
        this.captureKey = this.storedEncrypted ? '' : raw
        // fail-closed: an enabled endpoint without a stored key mints one on open
        if (this.captureEnabled && !raw) {
          this.captureKey = randomKey()
          this.storedEncrypted = false
          await commit('meta', 'put', [META_SECRET_KEY, this.captureKey])
        }
      } finally {
        this.loaded = true
      }
    },
    async toggleCapture (v) {
      this.captureEnabled = !!v
      await commit('meta', 'put', [META_ENABLED_KEY, v ? '1' : '0'])
      if (v && !this.captureKey && !this.storedEncrypted) {
        this.captureKey = randomKey()
        await commit('meta', 'put', [META_SECRET_KEY, this.captureKey])
      }
    },
    async regenKey () {
      const fresh = randomKey()
      this.captureKey = fresh
      this.storedEncrypted = false
      await commit('meta', 'put', [META_SECRET_KEY, fresh])
    },
    async copyKey () {
      if (!this.captureKey) return
      await navigator.clipboard.writeText(this.captureKey)
      this.copied = true
      if (this._copiedTimer) clearTimeout(this._copiedTimer)
      this._copiedTimer = setTimeout(() => { this.copied = false }, 1500)
    },
    async copyEndpoint () {
      await navigator.clipboard.writeText(this.captureEndpoint)
    }
  }
}
</script>
