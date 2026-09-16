<template>
  <!-- LAN sync tab (P3a, 2026-09-16). Rendered lazily: the parent gates this component with v-if on
       local tab state, so the default settings DOM (visual baseline) is pixel-identical. -->
  <div class="tab-panel">
    <div class="form">
      <div class="form-item"><span class="form-item__label"></span>
        <div class="form-item__control"><span class="tip sync-free-tip">{{ $t('sync.freeForever') }}</span></div></div>
    </div>
    <div class="form">
      <div class="form-label">{{ $t('sync.section') }}</div>
      <div class="form-item"><span class="form-item__label">{{ $t('sync.enableLabel') }}</span>
        <div class="form-item__control">
          <el-switch :model-value="enabled" :disabled="busy" @change="onToggle"/>
          <span class="tip">{{ $t('sync.enableTip') }}</span>
        </div></div>
      <div class="form-item"><span class="form-item__label">{{ $t('sync.deviceNameLabel') }}</span>
        <div class="form-item__control">
          <el-input size="small" class="ctl-md" maxlength="40" :aria-label="$t('sync.deviceNameLabel')"
                    v-model="nameDraft" @keyup.enter="saveName" @blur="saveName"/>
        </div></div>
      <div class="form-item"><span class="form-item__label">{{ $t('sync.statusLabel') }}</span>
        <div class="form-item__control">
          <span class="tip">{{ statusText }}</span>
        </div></div>
      <div class="form-item" v-if="enabled"><span class="form-item__label">{{ $t('sync.pairingLabel') }}</span>
        <div class="form-item__control">
          <button class="mini" :disabled="busy" @click="showPairing">{{ pairingCode || $t('sync.pairingBtn') }}</button>
          <span class="tip" v-if="pairingCode">{{ $t('sync.pairingExpiresIn', { n: pairingLeftSec }) }}</span>
        </div></div>
    </div>
  </div>
</template>

<script lang="ts">
/** LAN sync settings tab: master toggle (off by default), device name, status line, pairing code.
 *  All state lives in settings_rows (main-process DB authority) — no localStorage writes here. */
import { getSyncSettings, getSyncStatus, setSyncEnabled, getPairingCode, setSyncDeviceName } from '../../utils/lanSync.js'

export default {
  name: 'SettingsSyncTab',
  data () {
    return {
      enabled: false,
      deviceId: '',
      status: null,
      nameDraft: '',
      busy: false,
      pairingCode: '',
      pairingExpiresAt: 0,
      pairingLeftSec: 0,
      _pairTimer: null
    }
  },
  computed: {
    statusText () {
      if (!this.enabled) return this.$t('sync.statusDisabled')
      const s = this.status
      if (!s) return this.$t('sync.statusStarting')
      const parts = []
      parts.push(this.$t('sync.deviceIdShort', { id: String(s.deviceId || this.deviceId).slice(0, 8) }))
      parts.push(this.$t('sync.peersCount', { n: (s.peers || []).length }))
      parts.push(s.lastRoundAt ? this.$t('sync.lastRound', { time: this.fmt(s.lastRoundAt) }) : this.$t('sync.neverRan'))
      if (s.lastError) parts.push(this.$t('sync.errorPrefix', { msg: String(s.lastError).slice(0, 60) }))
      return parts.join(' · ')
    }
  },
  methods: {
    fmt (ts) {
      try { return window.dayjs ? window.dayjs(ts).format('HH:mm') : new Date(ts).toLocaleTimeString() } catch (e) { return '' }
    },
    async refresh () {
      try {
        const s = await getSyncSettings()
        this.enabled = !!s.enabled
        this.deviceId = s.deviceId || ''
        if (!this.nameDraft) this.nameDraft = s.deviceName || ''
        if (this.enabled) this.status = await getSyncStatus()
      } catch (e) { /* main process without LAN sync (CLI/test host) — leave defaults */ }
    },
    async onToggle (v) {
      this.busy = true
      try {
        const s = await setSyncEnabled(v)
        this.enabled = !!s.enabled
        this.status = this.enabled ? await getSyncStatus() : null
        this.$message.success(this.$t(this.enabled ? 'sync.enabledMsg' : 'sync.disabledMsg'))
      } catch (e) { this.$message.error(this.$t('sync.toggleFailed')) } finally { this.busy = false }
    },
    async saveName () {
      const name = String(this.nameDraft || '').trim()
      if (!name) { await this.refresh(); return } // empty input echoes the stored name back
      try {
        const s = await setSyncDeviceName(name)
        this.nameDraft = s.deviceName || name
        this.$message.success(this.$t('sync.nameSavedMsg'))
      } catch (e) { this.$message.error(this.$t('sync.nameSaveFailed')) }
    },
    async showPairing () {
      try {
        const r = await getPairingCode()
        if (!r || !r.code) { this.$message.error(this.$t('sync.pairingUnavailable')); return }
        this.pairingCode = r.code
        this.pairingExpiresAt = r.expiresAt || (Date.now() + 5 * 60 * 1000)
        this.tickPairing()
        if (!this._pairTimer) this._pairTimer = setInterval(() => this.tickPairing(), 1000)
      } catch (e) { this.$message.error(this.$t('sync.pairingUnavailable')) }
    },
    tickPairing () {
      this.pairingLeftSec = Math.max(0, Math.round((this.pairingExpiresAt - Date.now()) / 1000))
      if (this.pairingLeftSec === 0) { this.pairingCode = ''; clearInterval(this._pairTimer); this._pairTimer = null }
    }
  },
  beforeUnmount () {
    if (this._pairTimer) { clearInterval(this._pairTimer); this._pairTimer = null }
  },
  mounted () { this.refresh() }
}
</script>

<style>
.sync-free-tip { color: var(--brand, #008d8e); font-weight: 500; }
</style>
