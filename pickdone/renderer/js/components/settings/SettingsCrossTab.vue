<template>
  <div class="tab-panel">
    <!-- Mobile / Web sync bridge tab (Lane A, 2026-11-07). Single root element (same
         Fragment-v-show constraint as SettingsSyncTab). Disabled by default; LAN exposure
         is a SECOND explicit opt-in and only selectable once the bridge itself is on. -->
    <div class="form">
      <div class="form-label">{{ $t('crossPlatform.section') }}</div>
      <div class="form-item"><span class="form-item__label">{{ $t('crossPlatform.enableLabel') }}</span>
        <div class="form-item__control">
          <el-switch :model-value="status.enabled" :disabled="busy" @change="onToggleEnabled"/>
          <span class="tip">{{ $t('crossPlatform.enableTip') }}</span>
        </div></div>
      <div class="form-item" v-if="status.enabled"><span class="form-item__label">{{ $t('crossPlatform.lanLabel') }}</span>
        <div class="form-item__control">
          <el-switch :model-value="status.lanEnabled" :disabled="busy" @change="onToggleLan"/>
          <span class="tip">{{ $t('crossPlatform.lanTip') }}</span>
        </div></div>
      <div class="form-item form-item--bare">
        <div class="form-item__control">
          <span class="tip" v-if="status.running">{{ $t('crossPlatform.statusRunning', { port: status.port, bind: status.lanReachable ? 'LAN' : 'localhost' }) }}</span>
          <span class="tip" v-else>{{ $t('crossPlatform.statusStopped') }}</span>
        </div></div>
      <div class="form-item form-item--bare" v-if="status.lastError">
        <div class="form-item__control"><span class="sync-device-error">{{ $t('crossPlatform.lastErrorLabel') }}: {{ status.lastError }}</span></div></div>
    </div>

    <!-- Pairing: mint a one-time code, show it with its countdown; token never reaches the UI -->
    <div class="form" v-if="status.enabled">
      <div class="form-label">{{ $t('crossPlatform.pairSection') }}</div>
      <div class="form-item"><span class="form-item__label">{{ $t('crossPlatform.pairDeviceIdLabel') }}</span>
        <div class="form-item__control">
          <el-input size="small" class="ctl-md" maxlength="64" v-model="pairDeviceId" :aria-label="$t('crossPlatform.pairDeviceIdLabel')"
                    @keydown.enter="e => { if (e.isComposing || e.keyCode === 229) return; issuePairing() }"/>
        </div></div>
      <div class="form-item"><span class="form-item__label">{{ $t('crossPlatform.pairScopeLabel') }}</span>
        <div class="form-item__control">
          <el-select size="small" class="ctl-md" v-model="pairScope" :aria-label="$t('crossPlatform.pairScopeLabel')">
            <el-option value="READ" :label="$t('crossPlatform.pairScopeRead')"/>
            <el-option value="WRITE" :label="$t('crossPlatform.pairScopeWrite')"/>
          </el-select>
        </div></div>
      <div class="form-item"><span class="form-item__label">{{ $t('crossPlatform.pairCodeLabel') }}</span>
        <div class="form-item__control">
          <button class="mini" :disabled="busy || !pairDeviceId" @click="issuePairing">{{ $t('crossPlatform.pairIssueBtn') }}</button>
          <span class="cross-pair-code" v-if="pairing">{{ pairing.code }}</span>
          <span class="tip" v-if="pairing">{{ $t('crossPlatform.pairExpiresIn', { n: pairSecondsLeft }) }}</span>
          <div><span class="tip" v-if="pairing">{{ $t('crossPlatform.pairCodeTip') }}</span></div>
        </div></div>
    </div>

    <!-- Paired devices + revoke -->
    <div class="form" v-if="status.enabled">
      <div class="form-label">{{ $t('crossPlatform.devicesSection') }}</div>
      <span class="tip" v-if="liveDevices.length === 0">{{ $t('crossPlatform.noDevices') }}</span>
      <div class="sync-devices">
        <div v-for="d in liveDevices" :key="d.deviceId" class="sync-device-card" :data-device-id="d.deviceId">
          <span class="sync-dot sync-dot--ok"></span>
          <span class="sync-device-name">{{ d.deviceId }}</span>
          <span class="tip sync-device-meta">{{ $t('crossPlatform.deviceScope', { scope: d.scope === 'WRITE' ? $t('crossPlatform.pairScopeWrite') : $t('crossPlatform.pairScopeRead') }) }}</span>
          <span class="tip sync-device-meta">{{ $t('crossPlatform.devicePairedAt', { time: fmtTime(d.pairedAt) }) }}</span>
          <button class="mini sync-unpair-btn" :disabled="busy" @click="revoke(d.deviceId)">{{ $t('crossPlatform.revokeBtn') }}</button>
        </div>
      </div>
      <div class="form-item form-item--bare">
        <div class="form-item__control"><span class="tip">{{ $t('crossPlatform.securityNote') }}</span></div></div>
    </div>
  </div>
</template>

<script lang="ts">
/** Mobile / Web sync bridge tab. Talks ONLY through window.crossPlatformAPI (main-gated,
 * sanitized IPC); no direct db access, no secrets rendered beyond the ephemeral pairing code. */
export default {
  name: 'SettingsCrossTab',
  data () {
    return {
      status: { running: false, enabled: false, lanEnabled: false, lanReachable: false, port: null, devices: [], lastError: null },
      busy: false,
      pairDeviceId: '',
      pairScope: 'READ',
      pairing: null,
      pairSecondsLeft: 0,
      countdownTimer: null,
      refreshTimer: null
    }
  },
  computed: {
    liveDevices () { return (this.status.devices || []).filter(d => !d.revokedAt) }
  },
  mounted () { this.refresh() },
  beforeUnmount () {
    if (this.countdownTimer) clearInterval(this.countdownTimer)
    if (this.refreshTimer) clearInterval(this.refreshTimer)
  },
  methods: {
    async refresh () {
      try { this.status = await window.crossPlatformAPI.status() } catch { /* main not ready */ }
      // poll lightly while the tab is open so port/state changes surface without a modal re-open
      if (!this.refreshTimer) this.refreshTimer = setInterval(() => this.refresh(), 5000)
    },
    startCountdown (expiresAt) {
      if (this.countdownTimer) clearInterval(this.countdownTimer)
      const tick = () => {
        this.pairSecondsLeft = Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000))
        if (this.pairSecondsLeft <= 0) { clearInterval(this.countdownTimer); this.pairing = null }
      }
      tick()
      this.countdownTimer = setInterval(tick, 1000)
    },
    async onToggleEnabled (v) {
      this.busy = true
      try {
        this.status = await window.crossPlatformAPI.setEnabled(!!v)
        if (!v) this.pairing = null
      } catch (e) { this.$message && this.$message.error(String(e && e.message || e).slice(0, 120)) }
      this.busy = false
    },
    async onToggleLan (v) {
      this.busy = true
      try { this.status = await window.crossPlatformAPI.setLan(!!v) } catch (e) { this.$message && this.$message.error(String(e && e.message || e).slice(0, 120)) }
      this.busy = false
    },
    async issuePairing () {
      const id = (this.pairDeviceId || '').trim()
      if (!id || this.busy) return
      this.busy = true
      try {
        this.pairing = await window.crossPlatformAPI.issuePairing(id, this.pairScope)
        this.startCountdown(this.pairing.expiresAt)
        this.status = await window.crossPlatformAPI.status()
      } catch (e) { this.$message && this.$message.error(String(e && e.message || e).slice(0, 120)) }
      this.busy = false
    },
    async revoke (deviceId) {
      if (this.busy) return
      this.busy = true
      try { this.status = await window.crossPlatformAPI.revoke(deviceId) } catch (e) { this.$message && this.$message.error(String(e && e.message || e).slice(0, 120)) }
      this.busy = false
    },
    fmtTime (ms) {
      if (!ms) return ''
      try { return new Date(ms).toLocaleString() } catch { return String(ms) }
    }
  }
}
</script>

<style>
.cross-pair-code { font-size: 22px; letter-spacing: 4px; font-weight: 600; margin-left: 10px; user-select: text; }
</style>
