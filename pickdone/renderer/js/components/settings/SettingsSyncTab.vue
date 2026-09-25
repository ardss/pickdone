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
          <!-- F1 (round-2 P1): alias wins display order, then the advertised deviceName (main now
               carries it — the payload used to only have `name`, so raw UUIDs were shown), then
               the raw record fields. Pencil icon = inline machine-local alias editor. -->
          <span class="sync-device-name">{{ peerDisplayName(p) }}</span>
          <button class="mini sync-alias-btn" v-if="aliasEditingId !== p.deviceId"
                  :aria-label="$t('sync.aliasEdit')" :title="$t('sync.aliasEdit')"
                  :disabled="busy" @click="startAlias(p)">✎</button>
          <el-input v-if="aliasEditingId === p.deviceId" size="small" class="ctl-sm sync-alias-input"
                    maxlength="40" v-model="aliasDraft" :placeholder="$t('sync.aliasPh')"
                    :aria-label="$t('sync.aliasEdit')" @keyup.enter="saveAlias(p)" @blur="saveAlias(p)"/>
          <span class="tip sync-device-meta">{{ p.host }}</span>
          <span class="tip sync-device-meta" v-if="p.lastRoundAt">{{ $t('sync.lastRound', { time: relTime(p.lastRoundAt) }) }}</span>
          <span class="tip sync-device-meta" v-else>{{ $t('sync.neverRan') }}</span>
          <span class="sync-pending" v-if="pendingBadge(p)">{{ pendingBadge(p) }}</span>
          <span class="tip sync-device-error" v-if="isUnpairedByRemote(p)">{{ $t('sync.unpairedByRemote') }}</span>
          <span class="tip sync-device-error" v-else-if="p.lastError">{{ $t('sync.errorPrefix', { msg: String(p.lastError).slice(0, 60) }) }}</span>
          <button class="mini sync-unpair-btn" v-if="!isUnpairedByRemote(p)" :disabled="busy || connecting" @click="askUnpair(p)">{{ $t('sync.unpairBtn') }}</button>
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

    <!-- Y9 (sync-coverage-2): sync conflict backups (meta conflict lost-data snapshots, agent X's
         contract: syncConflictBackupsList -> [{key, lostAt, preview}], syncConflictBackupRestore({key})).
         Defensive: if the main process does not expose the ops yet (agent X not merged), the whole
         section stays hidden. -->
    <div class="form" v-if="conflictBackups !== null">
      <div class="form-item"><span class="form-item__label"></span>
        <div class="form-item__control">
          <button class="mini sync-collapse-toggle" @click="conflictOpen = !conflictOpen">{{ conflictOpen ? '▾' : '▸' }} {{ $t('sync.conflictSection') }} ({{ conflictBackups.length }})</button>
        </div></div>
      <div v-if="conflictOpen" class="sync-conflict-list">
        <div class="tip" v-if="!conflictBackups.length">{{ $t('sync.conflictEmpty') }}</div>
        <div v-for="b in conflictBackups" :key="b.key" class="sync-conflict-item">
          <span class="tip sync-conflict-key">{{ b.key }}</span>
          <span class="tip" v-if="b.lostAt">{{ $t('sync.conflictLostAt', { time: fmtFull(b.lostAt) }) }}</span>
          <span class="tip sync-conflict-preview" v-if="b.preview">{{ b.preview }}</span>
          <button class="mini" :disabled="conflictBusy === b.key" @click="restoreConflict(b)">{{ $t('sync.conflictRestore') }}</button>
        </div>
      </div>
    </div>

    <!-- Outbound pairing: add device by host -->
    <div class="form" v-if="enabled">
      <div class="form-label">{{ $t('sync.addDeviceLabel') }}</div>
      <div class="form-item"><span class="form-item__label">{{ $t('sync.addPeerLabel') }}</span>
        <div class="form-item__control">
          <el-input size="small" class="ctl-sm" :placeholder="$t('sync.addPeerHostPh')" :aria-label="$t('sync.addPeerLabel')" v-model="connectHost"/>
          <button class="mini" :class="{ 'sync-connecting': connecting }" :disabled="busy || connecting || !connectHost" @click="connectPeer">{{ $t('sync.connectBtn') }}</button>
          <span class="tip" v-if="connecting">{{ $t('sync.pairWaiting') }}</span>
          <span class="tip" v-else>{{ $t('sync.addPeerTip') }}</span>
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
              <option v-for="p in peers" :key="p.deviceId" :value="p.deviceId">{{ peerDisplayName(p) }}</option>
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
        <div class="tip sync-feed-hint">{{ $t('sync.feedSessionHint') }}</div>
      </div>
    </div>

    <!-- Inbound pair-request dialog (custom inline modal, not ElMessageBox — this Element build
         exposes service components awkwardly; codebase prefers parent-v-if custom modals) -->
    <div class="sync-pair-overlay" v-if="incomingPair" @keydown="onPairKeydown">
      <div class="sync-pair-dialog" role="dialog" aria-modal="true" :aria-label="$t('sync.pairRequestTitle')" ref="pairDialog">
        <div class="sync-pair-dialog__title">{{ $t('sync.pairRequestTitle') }}</div>
        <div class="sync-pair-dialog__body">{{ $t('sync.pairRequestFrom', { name: incomingPair.deviceName || incomingPair.deviceId || '?', host: incomingPair.host }) }}</div>
        <div class="tip" v-if="!pairExpired">{{ $t('sync.pairCountdown', { n: incomingPair.leftSec }) }}</div>
        <div class="tip sync-pair-expired" v-if="pairExpired">{{ $t('sync.pairExpiredHint') }}</div>
        <div class="sync-pair-dialog__actions" v-if="!pairExpired">
          <button class="mini" ref="pairRejectBtn" @click="respondPair(false)">{{ $t('sync.rejectBtn') }}</button>
          <button class="mini sync-pair-accept" @click="respondPair(true)">{{ $t('sync.acceptBtn') }}</button>
        </div>
      </div>
    </div>

    <!-- Destructive-action confirm dialog: unpair a device (P1-3) / re-pair while other devices
         exist (P1-4 — one shared pairing secret means the new pair disconnects existing peers).
         Same custom-modal convention as the pair-request dialog above. -->
    <div class="sync-pair-overlay" v-if="confirmBox" @keydown="onConfirmKeydown">
      <div class="sync-pair-dialog" role="dialog" aria-modal="true" :aria-label="$t(confirmBox.titleKey)" ref="confirmDialog">
        <div class="sync-pair-dialog__title">{{ $t(confirmBox.titleKey) }}</div>
        <div class="sync-pair-dialog__body">{{ $t(confirmBox.textKey, confirmBox.params || {}) }}</div>
        <div class="sync-pair-dialog__actions">
          <button class="mini" ref="confirmCancelBtn" @click="cancelConfirm">{{ $t('sync.confirmCancelBtn') }}</button>
          <button class="mini sync-pair-accept" @click="okConfirm">{{ $t('sync.confirmOkBtn') }}</button>
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
  return { push: '↑', pull: '↓', error: '!', pair: '∞', snapshot: '⇄' }[kind] || '·'
}
/** Map a pairing failure (err.reason/err.message from the main process) to an i18n key;
 *  '' means "no specific reason known" → the caller shows the generic confirm-flow message. */
function pairFailureKey (err) {
  const r = String((err && (err.reason || err.message)) || '')
  if (/reject/i.test(r)) return 'sync.pairRejectedMsg'
  if (/time[- ]?out|timed/i.test(r)) return 'sync.pairTimeoutMsg'
  if (/throttl/i.test(r)) return 'sync.pairThrottledMsg'
  return ''
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
/** P2c (2026-09-19 UX review round 2): a peer whose pairing secret was REVOKED on this side (or
 *  that unpaired us) fails authenticated hello forever — it shows as a zombie card. Map such
 *  lastError markers (agent-A field: `lastError`; defensive patterns incl. 'unpaired',
 *  'peer-unauthorized', auth-rejected, and the Chinese notice) to the dedicated "unpaired by the
 *  other device — pair again" state instead of a transient-looking red error. */
function peerUnpairedByRemote (lastError) {
  if (!lastError) return false
  return /unpair|peer-unauthorized|unauthorized|auth[^.]{0,16}reject/i.test(String(lastError))
}
/** F1 (round-2 P1 2026-09-21): peer display name — machine-local alias wins, then the advertised
 *  deviceName (main now carries it on the status payload), then the raw record name/deviceId. */
function peerDisplayName (peer) {
  if (!peer) return ''
  return peer.alias || peer.deviceName || peer.name || peer.deviceId || ''
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
      // Device Center state
      connecting: false, // outbound pair request in flight (60s await) — button disabled + inline hint
      incomingPair: null, // { deviceName, deviceId, host, expiresAt, leftSec }
      pairExpired: false, // pair-request countdown hit 0 — brief inline hint before auto-dismiss
      relTick: 0, // 30s-ticker counter; a render dependency of relTime so times stay fresh
      feedLive: [], // live-appended items from round-done/round-error while tab is open
      throttledAlert: false,
      securityOpen: false,
      manualOpen: false,
      feedOpen: false,
      confirmBox: null, // P1-3/P1-4: { titleKey, textKey, params, onOk } destructive-action confirm
      // F1 (round-2 P1): inline per-peer alias editor state (machine-local, sync.peerAlias.<id>)
      aliasEditingId: null, // deviceId currently being aliased (null = no editor open)
      aliasDraft: '',
      // Y9 conflict backups: null = ops unavailable (hide the section); array = list from main
      conflictBackups: null,
      conflictOpen: false,
      conflictBusy: null
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
    /** Y9: probe + list conflict backups. Missing/unavailable op (agent X not merged) => null
     *  (section hidden); any other failure also degrades to hidden — this UI must never block sync. */
    async loadConflictBackups () {
      try {
        const list = await dbCallLoose('syncConflictBackupsList')
        this.conflictBackups = Array.isArray(list) ? list : []
      } catch (e) { this.conflictBackups = null }
    },
    /** Y9/U6: restore one backup via the contract op, then refresh the list. Main expects a
     *  `{key}` payload object (src/main/sync-conflict-backups.js), not a bare key string — the
     *  old bare-string call made every restore throw "not a metaConflictBackup key". */
    async restoreConflict (b) {
      this.conflictBusy = b.key
      try {
        await dbCallLoose('syncConflictBackupRestore', { key: b.key })
        this.$message.success(this.$t('sync.conflictRestored'))
      } catch (e) {
        this.$message.error(this.$t('sync.conflictRestoreFail'))
      } finally {
        this.conflictBusy = null
        this.loadConflictBackups()
      }
    },
    dotClass (p) {
      void this.relTick // 30s ticker dependency: re-render ages out the red error dot past 5min
      return peerDotClass(p)
    },
    /** F1: alias-wins display name for a peer card / pairing target select. */
    peerDisplayName (p) { return peerDisplayName(p) },
    /** F1: open the inline alias editor pre-filled with the current alias. */
    startAlias (p) {
      if (!p || !p.deviceId) return
      this.aliasEditingId = p.deviceId
      this.aliasDraft = p.alias || ''
    },
    /** F1: persist the machine-local alias (empty clears it back to the advertised name).
     *  Blur+Enter can both fire — the editing-id reset makes the second call a no-op. */
    async saveAlias (p) {
      if (!p || this.aliasEditingId !== p.deviceId) return
      this.aliasEditingId = null
      const alias = String(this.aliasDraft || '').trim()
      try {
        await dbCallLoose('syncSetPeerAlias', { deviceId: p.deviceId, alias })
        this.$message.success(this.$t('sync.aliasSaved'))
        this.refresh()
      } catch (e) { this.$message.error(this.$t('sync.aliasSaveFail')) }
    },
    feedIcon (k) { return feedIcon(k) },
    /** P2c: peer card in the "unpaired by the other device" state — dedicated copy + no Unpair button. */
    isUnpairedByRemote (p) { return peerUnpairedByRemote(p && p.lastError) },
    dotTip (p) {
      void this.relTick // 30s ticker dependency: tooltip stays in sync with the dot's error window
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
      const kindKey = { push: 'sync.kindPush', pull: 'sync.kindPull', error: 'sync.kindError', pair: 'sync.kindPair', snapshot: 'sync.kindSnapshot' }[it.kind] || 'sync.kindPush'
      const who = it.peer ? `${it.peer} · ` : ''
      const detail = it.detail ? ` ${it.detail}` : ''
      return `${this.$t(kindKey)} · ${who}${detail}`.trim()
    },
    relTime (ts) {
      void this.relTick // 30s ticker dependency: re-render refreshes relative times
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
        const kind = evt.type === 'round-error' ? 'error' : (evt.kind === 'snapshot' ? 'snapshot' : (evt.dir === 'pull' ? 'pull' : 'push'))
        this.feedLive = [{ at: Date.now(), kind, peer: evt.deviceName || evt.deviceId || '', detail: evt.detail || evt.error || '' }].concat(this.feedLive).slice(0, 50)
      }
      this.refresh()
    },
    bindSyncEvents () {
      if (this._syncEventBound) return
      const api = (typeof window !== 'undefined' && window.todoAPI) as unknown as Record<string, unknown> | null
      if (api && typeof api.onSyncEvent === 'function') {
        // Keep the disposer: without it every tab remount stacks another listener (duplicate toasts/feed entries)
        const off = (api.onSyncEvent as (cb: (evt: { type?: string }) => void) => (void | (() => void)))(this.onSyncEvent)
        this._syncEventDisposer = typeof off === 'function' ? off : null
        this._syncEventBound = true
      }
    },
    /** Main holds an unanswered pair request for 60s and exposes it via syncGetStatus —
     *  recover the confirm dialog when the settings tab is (re)opened mid-request. */
    checkPendingPair () {
      const pp = this.status && this.status.pendingPair
      if (pp && !this.incomingPair) this.showIncomingPair({ deviceName: pp.deviceName, deviceId: pp.deviceId, host: pp.host })
    },
    showIncomingPair (evt) {
      this.pairExpired = false
      this.incomingPair = {
        deviceName: evt.deviceName || '',
        deviceId: evt.deviceId || '',
        host: evt.host || '',
        expiresAt: Date.now() + 60 * 1000,
        leftSec: 60
      }
      if (!this._pairReqTimer) this._pairReqTimer = setInterval(() => this.tickIncomingPair(), 1000)
      this.focusPairDialog()
    },
    /** A11y: move focus into the dialog (safe default = 拒绝) and remember where to restore it. */
    focusPairDialog () {
      if (typeof document === 'undefined') return
      this._pairPrevFocus = document.activeElement
      this.$nextTick(() => {
        const btn = this.$refs.pairRejectBtn as HTMLButtonElement | undefined
        if (btn && btn.focus) btn.focus()
      })
    },
    /** Keydown on the overlay: Escape = reject (stopped — must not bubble up and close the
     *  whole settings modal); Tab = cycle focus inside the dialog (focus trap). */
    onPairKeydown (e) {
      if (e.key === 'Escape') {
        e.preventDefault(); e.stopPropagation()
        this.respondPair(false)
        return
      }
      if (e.key !== 'Tab') return
      const root = this.$refs.pairDialog
      if (!root || !root.querySelectorAll) return
      const focusables = [...root.querySelectorAll('button, [href], input, select, [tabindex]')].filter((el: HTMLButtonElement) => !el.disabled)
      if (!focusables.length) { e.preventDefault(); return }
      const first = focusables[0]
      const last = focusables[focusables.length - 1]
      const active = document.activeElement
      if (!root.contains(active)) { e.preventDefault(); (e.shiftKey ? last : first).focus(); return }
      if (e.shiftKey && active === first) { e.preventDefault(); last.focus() }
      else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus() }
    },
    tickIncomingPair () {
      if (!this.incomingPair) { clearInterval(this._pairReqTimer); this._pairReqTimer = null; return }
      this.incomingPair.leftSec = Math.max(0, Math.round((this.incomingPair.expiresAt - Date.now()) / 1000))
      // Expiry is not silent anymore: brief inline hint, then auto-dismiss
      if (this.incomingPair.leftSec === 0 && !this.pairExpired) {
        this.pairExpired = true
        if (!this._pairExpiryTimer) this._pairExpiryTimer = setTimeout(() => this.dismissIncomingPair(), 2500)
      }
    },
    dismissIncomingPair () {
      this.incomingPair = null
      if (this._pairReqTimer) { clearInterval(this._pairReqTimer); this._pairReqTimer = null }
      if (this._pairExpiryTimer) { clearTimeout(this._pairExpiryTimer); this._pairExpiryTimer = null }
      const prev = this._pairPrevFocus
      if (prev && prev.focus && document.contains(prev)) { try { prev.focus() } catch (e) { /* gone */ } }
      this._pairPrevFocus = null
    },
    async respondPair (accept) {
      const req = this.incomingPair
      this.dismissIncomingPair()
      try {
        const r = (await syncPairRespond({ accept: !!accept })) as { ok?: boolean } | null
        // ok:false = the 60s window already elapsed in main — say so instead of faking success
        if (accept) (r && r.ok === false) ? this.$message.warning(this.$t('sync.pairExpiredMsg')) : this.$message.success(this.$t('sync.pairOkMsg'))
      } catch (e) { this.$message.error(this.$t('sync.pairFailMsg')) }
      if (req) this.refresh()
    },
    async connectPeer () {
      const host = String(this.connectHost || '').trim()
      // P1-4: ONE in-flight guard for both pairing flows — submitPairing used `busy` while
      // connectPeer used `connecting`, so both could run concurrently and interleave the two
      // secret rotations. connectPeer now holds `busy` too.
      if (!host || this.busy || this.connecting) return
      // P1-4: pairing adopts a NEW single shared secret — existing peers are disconnected and
      // must re-pair. Say so before the user pulls the trigger.
      const proceed = () => {
        this.busy = true
        this.connecting = true // immediate feedback: the 63s await must not leave the user staring at a dead button
        try {
          syncPairRequest(host).then(() => {
            this.$message.success(this.$t('sync.connectSent'))
          }).catch(e => {
            const key = pairFailureKey(e)
            this.$message.error(this.$t(key || 'sync.pairFailGenericMsg'))
          }).finally(() => { this.busy = false; this.connecting = false; this.refresh() })
        } catch (e) { this.busy = false; this.connecting = false }
      }
      if (this.peers.length) this.askConfirm('sync.repairTitle', 'sync.repairWarning', {}, proceed)
      else proceed()
    },
    async submitPairing () {
      // P1-4: shared in-flight guard (see connectPeer)
      if (this.busy || this.connecting) return
      const proceed = () => {
        this.busy = true
        pairWithCode(this.pairDraft, this.pairTarget || (this.peers[0] && this.peers[0].deviceId)).then(async () => {
          this.$message.success(this.$t('sync.pairOkMsg'))
          this.pairDraft = ''
          this.status = await getSyncStatus()
        }).catch(() => { this.$message.error(this.$t('sync.pairFailMsg')) }).finally(() => { this.busy = false })
      }
      if (this.peers.length) this.askConfirm('sync.repairTitle', 'sync.repairWarning', {}, proceed)
      else proceed()
    },
    /* ---------- P1-3/P1-4 confirm dialog ---------- */
    askConfirm (titleKey, textKey, params, onOk) {
      this.confirmBox = { titleKey, textKey, params: params || {}, onOk }
      // P2d (2026-09-19 UX review round 2): the overlay @keydown never fired because nothing inside
      // held focus — Escape was unreachable. Focus the safe default (取消) on open, mirroring the
      // pair-request dialog; the overlay keydown handler then receives Escape/Tab. Restore focus on close.
      if (typeof document !== 'undefined') this._confirmPrevFocus = document.activeElement
      this.$nextTick(() => {
        const btn = this.$refs.confirmCancelBtn as HTMLButtonElement | undefined
        if (btn && btn.focus) btn.focus()
      })
    },
    restoreConfirmFocus () {
      const prev = this._confirmPrevFocus
      if (prev && prev.focus && document.contains(prev)) { try { prev.focus() } catch (e) { /* gone */ } }
      this._confirmPrevFocus = null
    },
    cancelConfirm () { this.confirmBox = null; this.restoreConfirmFocus() },
    okConfirm () {
      const box = this.confirmBox
      this.confirmBox = null
      this.restoreConfirmFocus()
      if (box && typeof box.onOk === 'function') box.onOk()
    },
    onConfirmKeydown (e) {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); this.cancelConfirm() }
    },
    /** P1-3: unpair a peer card — confirm first (revoking the shared pairing secret disconnects
     *  ALL previously paired devices; both sides must re-pair). */
    askUnpair (p) {
      if (!p || !p.deviceId || this.busy || this.connecting) return
      const name = p.deviceName || p.deviceId
      this.askConfirm('sync.unpairTitle', 'sync.unpairConfirm', { name }, async () => {
        this.busy = true
        try {
          await dbCallLoose('syncUnpairPeer', { deviceId: p.deviceId })
          this.$message.success(this.$t('sync.unpairDoneMsg', { name }))
        } catch (e) { this.$message.error(this.$t('sync.unpairFailMsg')) } finally {
          this.busy = false
          this.refresh()
        }
      })
    },
    async onToggle (v) {
      this.busy = true
      try {
        const s = await setSyncEnabled(v)
        this.enabled = !!s.enabled
        this.status = this.enabled ? await getSyncStatus() : null
        // P2f: sync off kills the remote running-tomato chip immediately (no stale announce)
        if (!this.enabled && this.$store) { try { this.$store.commit('tomatoAnnounce/clearRemote') } catch (e) { /* store absent in isolated mounts */ } }
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
    },
    /** 30s ticker: relative times ("3 分钟前") are computed from Date.now() at render time, so a
     *  light tick (bumps _relTick, a render dependency) refreshes them without a status round-trip. */
    startRelTicker () {
      if (this._relTimer) return
      // Instance-field timer (not data — vue/no-reserved-keys; timers need no reactivity)
      this._relTimer = setInterval(() => { this.relTick++ }, 30 * 1000)
    }
  },
  beforeUnmount () {
    if (this._pairTimer) { clearInterval(this._pairTimer); this._pairTimer = null }
    if (this._pairReqTimer) { clearInterval(this._pairReqTimer); this._pairReqTimer = null }
    if (this._pairExpiryTimer) { clearTimeout(this._pairExpiryTimer); this._pairExpiryTimer = null }
    if (this._relTimer) { clearInterval(this._relTimer); this._relTimer = null }
    if (this._syncEventDisposer) { try { this._syncEventDisposer() } catch (e) { /* already gone */ } this._syncEventDisposer = null }
    this._syncEventBound = false
  },
  mounted () {
    this.refresh().then(() => this.checkPendingPair())
    this.loadConflictBackups()
    this.bindSyncEvents()
    this.startRelTicker()
  }
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
.sync-connecting { opacity: 0.6; cursor: wait; }
.sync-feed-hint { color: var(--text-3); }
.sync-pair-expired { color: var(--danger, var(--text-2)); }
.sync-unpair-btn { color: var(--danger, var(--text-2)); }
.sync-alias-btn { background: none; border: none; cursor: pointer; color: var(--text-3); padding: 0 2px; }
.sync-alias-btn:hover { color: var(--brand); }
.sync-alias-input { width: 160px; }
.sync-pair-dialog__body { white-space: pre-line; }
</style>
