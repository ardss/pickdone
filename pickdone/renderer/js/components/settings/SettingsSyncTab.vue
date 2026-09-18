<template>
  <!-- LAN sync tab (P3a, 2026-09-16; Device Center rework 2026-09-17). Rendered lazily: the parent
       gates this component with v-if on local tab state, so the default settings DOM (visual
       baseline) is pixel-identical. -->
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
    </div>

    <!-- Device Center: this device + peers -->
    <div class="form" v-if="enabled">
      <div class="form-label">{{ $t('sync.devicesSection') }}</div>
      <div class="sync-devices">
        <div class="sync-device-card sync-device-card--self">
          <span class="sync-dot sync-dot--ok" :aria-label="$t('sync.onlineTip')"></span>
          <span class="sync-device-name">{{ selfName }}</span>
          <span class="tip sync-device-meta">{{ $t('sync.thisDevice') }}</span>
          <span class="tip sync-device-meta">{{ $t('sync.deviceIdShort', { id: shortId }) }} · {{ $t('sync.portLabel') }} {{ port }}</span>
        </div>
        <div v-for="p in peers" :key="p.deviceId" class="sync-device-card" :data-device-id="p.deviceId">
          <span class="sync-dot" :class="dotClass(p)" :title="dotTip(p)" :aria-label="dotTip(p)"></span>
          <span class="sync-device-name">{{ p.deviceName || p.deviceId }}</span>
          <span class="tip sync-device-meta">{{ p.host }}</span>
          <span class="tip sync-device-meta" v-if="p.lastRoundAt">{{ $t('sync.lastRound', { time: relTime(p.lastRoundAt) }) }}</span>
          <span class="tip sync-device-meta" v-else>{{ $t('sync.neverRan') }}</span>
          <span class="sync-pending" v-if="pendingBadge(p)">{{ pendingBadge(p) }}</span>
          <span class="tip sync-device-error" v-if="p.lastError">{{ $t('sync.errorPrefix', { msg: String(p.lastError).slice(0, 60) }) }}</span>
        </div>
      </div>
    </div>

    <!-- Security notices -->
    <div class="form" v-if="securityStripVisible">
      <div class="sync-security-strip" role="alert">
        <span>{{ $t('sync.securityWarn') }}</span>
        <button class="mini" @click="securityOpen = !securityOpen">{{ $t('sync.securityDetail') }}</button>
        <div class="sync-security-list" v-if="securityOpen">
          <div v-for="(s, i) in securityList" :key="i" class="sync-security-item">
            <span class="tip">{{ fmtFull(s.at) }} · {{ s.ip }} · {{ s.reason }}</span>
          </div>
        </div>
      </div>
    </div>

    <!-- Outbound pairing: add device by host -->
    <div class="form" v-if="enabled">
      <div class="form-label">{{ $t('sync.addDeviceLabel') }}</div>
      <div class="form-item"><span class="form-item__label">{{ $t('sync.addPeerLabel') }}</span>
        <div class="form-item__control">
          <el-input size="small" class="ctl-sm" :placeholder="$t('sync.addPeerHostPh')" :aria-label="$t('sync.addPeerLabel')" v-model="connectHost"/>
          <button class="mini" :disabled="busy || !connectHost" @click="connectPeer">{{ $t('sync.connectBtn') }}</button>
          <span class="tip">{{ $t('sync.addPeerTip') }}</span>
        </div></div>
      <div class="form-item"><span class="form-item__label"></span>
        <div class="form-item__control">
          <button class="mini sync-collapse-toggle" @click="manualOpen = !manualOpen">{{ manualOpen ? '▾' : '▸' }} {{ $t('sync.manualPairLabel') }}</button>
        </div></div>
      <div v-if="manualOpen">
        <div class="form-item"><span class="form-item__label">{{ $t('sync.pairingLabel') }}</span>
          <div class="form-item__control">
            <button class="mini" :disabled="busy" @click="showPairing">{{ pairingCode || $t('sync.pairingBtn') }}</button>
            <span class="tip" v-if="pairingCode">{{ $t('sync.pairingExpiresIn', { n: pairingLeftSec }) }}</span>
          </div></div>
        <div class="form-item"><span class="form-item__label">{{ $t('sync.pairInputLabel') }}</span>
          <div class="form-item__control">
            <select v-if="peers.length" class="ctl-sm" v-model="pairTarget" :aria-label="$t('sync.pairTargetLabel')">
              <option v-for="p in peers" :key="p.deviceId" :value="p.deviceId">{{ p.deviceName || p.deviceId }}</option>
            </select>
            <el-input size="small" class="ctl-sm" maxlength="6" :placeholder="$t('sync.pairInputPh')"
                      :aria-label="$t('sync.pairInputLabel')" v-model="pairDraft"/>
            <button class="mini" :disabled="busy || !pairDraftOk" @click="submitPairing">{{ $t('sync.pairSubmitBtn') }}</button>
          </div></div>
      </div>
    </div>

    <!-- Activity feed -->
    <div class="form" v-if="enabled">
      <div class="form-label">
        <button class="mini sync-collapse-toggle" @click="feedOpen = !feedOpen">{{ feedOpen ? '▾' : '▸' }} {{ $t('sync.activitySection') }}</button>
      </div>
      <div class="sync-feed" v-if="feedOpen">
        <div class="tip" v-if="!feedDisplay.length">{{ $t('sync.feedEmpty') }}</div>
        <div v-for="(it, i) in feedDisplay" :key="i" class="sync-feed-item" :data-feed-kind="it.kind">
          <span class="sync-feed-icon">{{ feedIcon(it.kind) }}</span>
          <span class="sync-feed-time tip">{{ relTime(it.at) }}</span>
          <span class="sync-feed-text">{{ feedLine(it) }}</span>
        </div>
      </div>
    </div>

    <!-- Inbound pair-request dialog (custom inline modal, not ElMessageBox — this Element build
         exposes service components awkwardly; codebase prefers parent-v-if custom modals) -->
    <div class="sync-pair-overlay" v-if="incomingPair">
      <div class="sync-pair-dialog" role="dialog" :aria-label="$t('sync.pairRequestTitle')">
        <div class="sync-pair-dialog__title">{{ $t('sync.pairRequestTitle') }}</div>
        <div class="sync-pair-dialog__body">{{ $t('sync.pairRequestFrom', { name: incomingPair.deviceName || incomingPair.deviceId || '?', host: incomingPair.host }) }}</div>
        <div class="tip">{{ $t('sync.pairCountdown', { n: incomingPair.leftSec }) }}</div>
        <div class="sync-pair-dialog__actions">
          <button class="mini" @click="respondPair(false)">{{ $t('sync.rejectBtn') }}</button>
          <button class="mini sync-pair-accept" @click="respondPair(true)">{{ $t('sync.acceptBtn') }}</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script lang="ts">
/** LAN sync settings tab: master toggle (off by default), device name, Device Center (peers,
 *  confirm-style pairing, activity feed, security notices). All state lives in the main-process
 *  DB (syncGetStatus / syncEvent channel) — no localStorage writes here. */
import { getSyncSettings, getSyncStatus, setSyncEnabled, getPairingCode, setSyncDeviceName, pairWithCode } from '../../utils/lanSync.js'

/** Device Center IPC ops (main-process agent's contract): answered pair-requests + outbound pairing.
 *  Kept inline (not in utils/lanSync.js) so the Device Center rework stays pathspec-scoped; the
 *  loose cast keeps vue-tsc green until contracts.d.ts grows the new op names. */
const dbCallLoose = (op: string, params?: unknown) => (window.todoAPI.dbCall as unknown as (o: string, p?: unknown) => Promise<unknown>)(op, params)
const syncPairRespond = (opts: { accept: boolean }) => dbCallLoose('syncPairRespond', opts)
const syncPairRequest = (host: string) => dbCallLoose('syncPairRequest', { host })

// [component-fixes] pure-start (extracted verbatim by tests/unit/components) — keep pure & framework-free
/** Online/offline/error dot class for a peer card: red when lastError is fresh (< 5min),
 *  green when online, gray otherwise. */
function peerDotClass (peer, now = null) {
  const nowMs = now || Date.now()
  if (peer && peer.lastError && peer.lastErrorAt && (nowMs - peer.lastErrorAt) < 5 * 60 * 1000) return 'sync-dot--err'
  return peer && peer.online ? 'sync-dot--ok' : 'sync-dot--off'
}
/** Pending badge text decision: 'behind' when pendingCount > 0, 'synced' when exactly 0,
 *  null when unknown (hide the badge entirely). */
function peerPendingKind (pendingCount) {
  if (pendingCount == null) return null
  return pendingCount > 0 ? 'behind' : 'synced'
}
/** Cap a status.recent list (already newest-first from main) for display. */
function capFeed (recent, cap) {
  return (Array.isArray(recent) ? recent : []).slice(0, cap || 20)
}
/** Map a feed kind to a display icon (plain symbols, no emoji, token-colorable). */
function feedIcon (kind) {
  return { push: '↑', pull: '↓', error: '!', pair: '∞' }[kind] || '·'
}
/** Relative-time bucketing shared by peer cards and the feed: {n, unit} with unit in
 *  'now'|'min'|'hour'|'day'. */
function relTimeParts (ts, now = null) {
  const nowMs = now || Date.now()
  const diff = Math.max(0, nowMs - ts)
  if (diff < 60 * 1000) return { n: 0, unit: 'now' }
  if (diff < 3600 * 1000) return { n: Math.floor(diff / 60000), unit: 'min' }
  if (diff < 86400 * 1000) return { n: Math.floor(diff / 3600000), unit: 'hour' }
  return { n: Math.floor(diff / 86400000), unit: 'day' }
}
/** Security strip visibility: shown when any blocked attempt or a live throttled event exists. */
function securityVisible (list, throttled) {
  return !!(throttled || (Array.isArray(list) && list.length > 0))
}
// [component-fixes] pure-end

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
      pairDraft: '',
      pairTarget: '',
      connectHost: '',
      pairingExpiresAt: 0,
      pairingLeftSec: 0,
      _pairTimer: null,
      // Device Center state
      incomingPair: null, // { deviceName, deviceId, host, expiresAt, leftSec }
      _pairReqTimer: null,
      feedLive: [], // live-appended items from round-done/round-error while tab is open
      throttledAlert: false,
      securityOpen: false,
      manualOpen: false,
      feedOpen: false
    }
  },
  computed: {
    peers () { return (this.status && this.status.peers) || [] },
    selfInfo () { return (this.status && this.status.self) || {} },
    selfName () { return this.selfInfo.deviceName || this.nameDraft || this.$t('sync.thisDevice') },
    shortId () { return String(this.selfInfo.deviceId || this.deviceId || '').slice(0, 8) },
    port () { return this.selfInfo.port || (this.status && this.status.port) || '' },
    securityList () { return (this.status && this.status.security) || [] },
    securityStripVisible () { return securityVisible(this.securityList, this.throttledAlert) },
    /** status.recent (newest first from main) merged with live-appended items, display-capped. */
    feedDisplay () {
      const stored = capFeed((this.status && this.status.recent) || [], 20)
      const live = capFeed(this.feedLive, 20)
      const merged = live.concat(stored)
        .sort((a, b) => (b.at || 0) - (a.at || 0))
      return capFeed(merged, 20)
    },
    pairDraftOk () { return /^\d{6}$/.test(String(this.pairDraft || '')) }
  },
  methods: {
    dotClass (p) { return peerDotClass(p) },
    feedIcon (k) { return feedIcon(k) },
    dotTip (p) {
      if (p && p.lastError && p.lastErrorAt && (Date.now() - p.lastErrorAt) < 5 * 60 * 1000) return this.$t('sync.errTip')
      return this.$t(p && p.online ? 'sync.onlineTip' : 'sync.offlineTip')
    },
    /** Rendered badge text: 落后 N 条 / 已同步; '' hides it. */
    pendingBadge (p) {
      const kind = peerPendingKind(p && p.pendingCount)
      if (!kind) return ''
      return kind === 'behind' ? this.$t('sync.behindN', { n: p.pendingCount }) : this.$t('sync.synced')
    },
    feedLine (it) {
      const kindKey = { push: 'sync.kindPush', pull: 'sync.kindPull', error: 'sync.kindError', pair: 'sync.kindPair' }[it.kind] || 'sync.kindPush'
      const who = it.peer ? `${it.peer} · ` : ''
      const detail = it.detail ? ` ${it.detail}` : ''
      return `${this.$t(kindKey)} · ${who}${detail}`.trim()
    },
    relTime (ts) {
      const { n, unit } = relTimeParts(ts)
      if (unit === 'now') return this.$t('sync.relJustNow')
      return this.$t(unit === 'min' ? 'sync.relMinutes' : unit === 'hour' ? 'sync.relHours' : 'sync.relDays', { n })
    },
    fmt (ts) {
      try { return window.dayjs ? window.dayjs(ts).format('HH:mm') : new Date(ts).toLocaleTimeString() } catch (e) { return '' }
    },
    fmtFull (ts) {
      try { return window.dayjs ? window.dayjs(ts).format('YYYY-MM-DD HH:mm') : new Date(ts).toLocaleString() } catch (e) { return '' }
    },
    async refresh () {
      try {
        const s = await getSyncSettings()
        this.enabled = !!s.enabled
        this.deviceId = s.deviceId || ''
        if (!this.nameDraft) this.nameDraft = s.deviceName || ''
        if (this.enabled) {
          this.status = await getSyncStatus()
          if (!this.connectHost && this.peers.length && this.peers[0].host) this.connectHost = this.peers[0].host
        }
      } catch (e) { /* main process without LAN sync (CLI/test host) — leave defaults */ }
    },
    /** syncEvent channel listener: refresh status (cheap re-render) + handle pairing UX. */
    onSyncEvent (evt) {
      if (!evt || !evt.type) return
      if (evt.type === 'pair-request') this.showIncomingPair(evt)
      else if (evt.type === 'pair-accepted') this.$message.success(this.$t('sync.pairOkMsg'))
      else if (evt.type === 'pair-rejected') this.$message.error(this.$t('sync.pairRejectedMsg'))
      else if (evt.type === 'pair-throttled') this.throttledAlert = true
      else if (evt.type === 'round-done' || evt.type === 'round-error') {
        this.feedLive = [{ at: Date.now(), kind: evt.type === 'round-error' ? 'error' : (evt.dir === 'pull' ? 'pull' : 'push'), peer: evt.deviceName || evt.deviceId || '', detail: evt.detail || evt.error || '' }].concat(this.feedLive).slice(0, 50)
      }
      this.refresh()
    },
    bindSyncEvents () {
      if (this._syncEventBound) return
      const api = (typeof window !== 'undefined' && window.todoAPI) as unknown as Record<string, unknown> | null
      if (api && typeof api.onSyncEvent === 'function') {
        (api.onSyncEvent as (cb: (evt: { type?: string }) => void) => void)(this.onSyncEvent)
        this._syncEventBound = true
      }
    },
    showIncomingPair (evt) {
      this.incomingPair = {
        deviceName: evt.deviceName || '',
        deviceId: evt.deviceId || '',
        host: evt.host || '',
        expiresAt: Date.now() + 60 * 1000,
        leftSec: 60
      }
      if (!this._pairReqTimer) this._pairReqTimer = setInterval(() => this.tickIncomingPair(), 1000)
    },
    tickIncomingPair () {
      if (!this.incomingPair) { clearInterval(this._pairReqTimer); this._pairReqTimer = null; return }
      this.incomingPair.leftSec = Math.max(0, Math.round((this.incomingPair.expiresAt - Date.now()) / 1000))
      if (this.incomingPair.leftSec === 0) this.dismissIncomingPair()
    },
    dismissIncomingPair () {
      this.incomingPair = null
      if (this._pairReqTimer) { clearInterval(this._pairReqTimer); this._pairReqTimer = null }
    },
    async respondPair (accept) {
      const req = this.incomingPair
      this.dismissIncomingPair()
      try {
        await syncPairRespond({ accept: !!accept })
        if (accept) this.$message.success(this.$t('sync.pairOkMsg'))
      } catch (e) { this.$message.error(this.$t('sync.pairFailMsg')) }
      if (req) this.refresh()
    },
    async connectPeer () {
      const host = String(this.connectHost || '').trim()
      if (!host) return
      this.busy = true
      try {
        await syncPairRequest(host)
        this.$message.success(this.$t('sync.connectSent'))
      } catch (e) { this.$message.error(this.$t('sync.pairFailMsg')) } finally { this.busy = false }
    },
    async submitPairing () {
      this.busy = true
      try {
        await pairWithCode(this.pairDraft, this.pairTarget || (this.peers[0] && this.peers[0].deviceId))
        this.$message.success(this.$t('sync.pairOkMsg'))
        this.pairDraft = ''
        this.status = await getSyncStatus()
      } catch (e) { this.$message.error(this.$t('sync.pairFailMsg')) } finally { this.busy = false }
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
    if (this._pairReqTimer) { clearInterval(this._pairReqTimer); this._pairReqTimer = null }
  },
  mounted () { this.refresh(); this.bindSyncEvents() }
}
</script>

<style>
.sync-free-tip { color: var(--brand, #008d8e); font-weight: 500; }
.sync-devices { display: flex; flex-direction: column; gap: 6px; width: 100%; }
.sync-device-card { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding: 6px 10px;
  background: var(--hover-bg); border-radius: 6px; }
.sync-device-card--self { border: 1px solid var(--brand); }
.sync-device-name { color: var(--text-0); font-weight: 500; }
.sync-device-meta { color: var(--text-2); }
.sync-device-error { color: var(--danger, var(--text-2)); width: 100%; }
.sync-dot { width: 8px; height: 8px; border-radius: 50%; flex: none; background: var(--text-3); }
.sync-dot--ok { background: var(--success, var(--brand)); }
.sync-dot--off { background: var(--text-3); }
.sync-dot--err { background: var(--danger, var(--brand)); }
.sync-pending { color: var(--brand); font-size: 12px; }
.sync-security-strip { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; width: 100%;
  padding: 6px 10px; border-radius: 6px; background: var(--hover-bg); color: var(--text-0); }
.sync-security-list { width: 100%; }
.sync-security-item { padding: 2px 0; }
.sync-collapse-toggle { background: none; border: none; cursor: pointer; color: var(--text-0); }
.sync-feed { display: flex; flex-direction: column; gap: 4px; width: 100%; }
.sync-feed-item { display: flex; align-items: baseline; gap: 8px; }
.sync-feed-icon { color: var(--brand); font-weight: 600; width: 14px; text-align: center; }
.sync-feed-time { color: var(--text-3); flex: none; min-width: 64px; }
.sync-feed-text { color: var(--text-1); }
.sync-pair-overlay { position: fixed; inset: 0; background: var(--mask, rgba(0, 0, 0, 0.35));
  display: flex; align-items: center; justify-content: center; }
.sync-pair-dialog { background: var(--bg-0, var(--hover-bg)); border-radius: 8px; padding: 16px 20px;
  min-width: 280px; box-shadow: var(--shadow, none); }
.sync-pair-dialog__title { color: var(--text-0); font-weight: 600; margin-bottom: 8px; }
.sync-pair-dialog__body { color: var(--text-1); margin-bottom: 6px; }
.sync-pair-dialog__actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 12px; }
</style>
