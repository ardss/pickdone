<template>

  <div v-if="visible" class="ob-mask" role="dialog" aria-modal="true" :aria-label="$t('onboarding.welcomeTitle')" @keydown.esc="finish">
    <div class="ob-card">
      <h1 class="ob-title">{{ $t('onboarding.welcomeTitle') }}</h1>
      <p class="ob-sub">{{ $t('onboarding.welcomeSub') }}</p>

      <div v-show="step === 0" class="ob-step">
        <h2 class="ob-step__title">{{ $t('onboarding.stepLang') }}</h2>
        <p class="ob-step__sub">{{ $t('onboarding.langSub') }}</p>
        <div class="ob-opts" role="group" :aria-label="$t('onboarding.stepLang')">
          <button v-for="l in langs" :key="l[0]" type="button" class="ob-opt"
            :class="{ 'ob-opt--on': locale === l[0] }" :aria-pressed="locale === l[0]" @click="pickLocale(l[0])">{{ l[1] }}</button>
        </div>
      </div>

      <div v-show="step === 1" class="ob-step">
        <h2 class="ob-step__title">{{ $t('onboarding.stepTheme') }}</h2>
        <p class="ob-step__sub">{{ $t('onboarding.themeSub') }}</p>
        <div class="ob-opts" role="group" :aria-label="$t('onboarding.stepTheme')">
          <button v-for="m in [['light', $t('onboarding.themeLight')], ['dark', $t('onboarding.themeDark')], ['system', $t('onboarding.themeSystem')]]"
            :key="m[0]" type="button" class="ob-opt"
            :class="{ 'ob-opt--on': colorMode === m[0] }" :aria-pressed="colorMode === m[0]" @click="pickTheme(m[0])">{{ m[1] }}</button>
        </div>
      </div>

      <div v-show="step === 2" class="ob-step">
        <h2 class="ob-step__title">{{ $t('onboarding.stepCats') }}</h2>
        <p class="ob-step__sub">{{ $t('onboarding.catsSub') }}</p>
        <div v-if="seedCats" class="ob-cats" aria-hidden="true">
          <span class="ob-cat" style="--dot:var(--brand)">{{ $t('onboarding.catWork') }}</span>
          <span class="ob-cat" style="--dot:#f2a63b">{{ $t('onboarding.catStudy') }}</span>
          <span class="ob-cat" style="--dot:#7ac74f">{{ $t('onboarding.catLife') }}</span>
        </div>
        <div class="ob-opts" role="group" :aria-label="$t('onboarding.stepCats')">
          <button type="button" class="ob-opt" :class="{ 'ob-opt--on': seedCats }"
            :aria-pressed="!!seedCats" @click="seedCats = true">{{ $t('onboarding.catsKeep') }}</button>
          <button type="button" class="ob-opt" :class="{ 'ob-opt--on': !seedCats }"
            :aria-pressed="!seedCats" @click="seedCats = false">{{ $t('onboarding.catsSkip') }}</button>
        </div>
      </div>

      <div class="ob-foot">
        <button type="button" class="ob-link" @click="finish">{{ $t('onboarding.skip') }}</button>
        <div class="ob-foot__main">
          <button v-if="step > 0" type="button" class="ob-btn" @click="prev">{{ $t('onboarding.prev') }}</button>
          <button type="button" class="ob-btn ob-btn--primary" @click="next">
            {{ step < 2 ? $t('onboarding.next') : $t('onboarding.done') }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script lang="ts">
import i18n, { setLocale, SUPPORTED } from '../i18n/index.js'
import dialogA11y from '../utils/dialogA11y.js'
/** First-run setup wizard: language -> color mode -> default categories (triggered only on fresh installs; existing data silently skips and backfills the flag) */
const LS_ONBOARD = 'onboardingDone'
/* v0.1 release decision: the first-run wizard is disabled entirely (auto tour handoff still needs polish). To restore, flip back to true; all logic is retained */
const ONBOARDING_ENABLED = false

export default {
  name: 'OnboardingWizard',
  mixins: [dialogA11y],
  data: () => ({ visible: false, step: 0, locale: 'zh-CN', colorMode: 'light', seedCats: true, langs: SUPPORTED }),
  async mounted () {
    if (!ONBOARDING_ENABLED) { try { localStorage.setItem(LS_ONBOARD, '1') } catch (e) { /* ignore */ } return }
    // When partitioned storage/privacy mode disables LS, getItem throws: same try wrapper as SettingsModal so wizard mounting never crashes
    let onboarded = false
    let hasSettings = false
    try {
      onboarded = !!localStorage.getItem(LS_ONBOARD)
      hasSettings = !!localStorage.getItem('settingsState')
    } catch (e) { /* storage disabled -> treat as fresh */ }
    if (onboarded) return
    // Existing-user protection: never show the wizard if settings were saved or the DB already has tasks (backfill the flag to avoid future false triggers)
    if (hasSettings) { try { localStorage.setItem(LS_ONBOARD, '1') } catch (e) { /* ignore */ } return }
    // DB meta dual-write flag: recognizes existing users even after localStorage is cleared (partition reset / cache clear)
    try {
      const done = await window.todoAPI.dbCall('getMeta', 'onboardingDone')
      if (String(done) === '1') { localStorage.setItem(LS_ONBOARD, '1'); return }
    } catch (e) { /* Debug host fallback: treat as fresh install */ }
    try {
      const n = await window.todoAPI.dbCall('countAll')
      if (Number(n) > 0) { localStorage.setItem(LS_ONBOARD, '1'); this.markDoneInDb(); return }
    } catch (e) { /* Browser debug host fallback: treat as fresh install and continue the wizard */ }
    try { await this.$store.dispatch('category/init') } catch (e) { /* Load failure must not block the wizard */ }
    this.locale = i18n.global.locale
    this.colorMode = this.$store.state.settings.colorMode || 'light'
    this.visible = true
  },
  methods: {
    pickLocale (l) { this.locale = l; setLocale(l) },
    pickTheme (m) { this.colorMode = m; this.$store.dispatch('settings/update', { colorMode: m }) },
    prev () { if (this.step > 0) this.step-- },
    next () { this.step < 2 ? this.step++ : this.finish() },
    finish () {
      this.visible = false
      localStorage.setItem(LS_ONBOARD, '1')
      this.markDoneInDb()
      if (this.seedCats) this.renameSeedCats()
      // First-run journey: after the wizard exits, hand off to the full user journey (create task → start focus → switch view → drag schedule → completion page)
      // Delay = wait for ob-mask removal from the DOM so the spotlight mask doesn't stack with the wizard (the three-layer popup storm defense from dual-Persona testing)
      import('../utils/onboardingTours.js').then(m => { setTimeout(() => m.runJourney(true), 700) })
    },
    /** DB meta dual-write: prevents the wizard from popping up again after localStorage is lost (cache clear / partition reset) */
    markDoneInDb () {
      try { window.todoAPI.dbCall('setMeta', ['onboardingDone', '1']).catch(() => {}) } catch (e) { /* Debug host fallback */ }
    },
    /** Rename seed categories to the chosen language only when they still carry the initial Chinese default names (untouched by the user) */
    renameSeedCats () {
      // Seed categories are named by the current locale on first creation; later upgrades only rename the "initial default names" (protects user-renamed categories from being overwritten)
      // Comparison strategy: backward compatible with older versions -- if the DB still holds the zh default name it also counts as initial (upgrade scenario)
      const seeds = [[100001, 'onboarding.catWork'], [100002, 'onboarding.catStudy'], [100003, 'onboarding.catLife']]
      for (const [id, key] of seeds) {
        const c = this.$store.state.category.list.find(x => x.categoryId === id)
        if (!c) continue
        const initialZh = { 'onboarding.catWork': '工作', 'onboarding.catStudy': '学习', 'onboarding.catLife': '生活' }[key]
        if (c.categoryName === initialZh || c.categoryName === this.$t(key)) {
          this.$store.commit('category/updateCategory', { categoryId: id, categoryName: this.$t(key) })
        }
      }
    }
  },

  beforeUnmount () { /* No persistent listeners */ }
}
</script>
<style>
/* ===== 迁移自全局沉积文件(scripts/css-move.mjs):以下规则随组件生灭 ===== */
.ob-btn {
  padding: 8px 20px; border: 1px solid var(--line-strong); border-radius: var(--radius-md);
  background: transparent; color: var(--text-1); font-size: var(--fs-md); cursor: pointer;
  transition: border-color var(--t-fast), background var(--t-fast), color var(--t-fast);
}
.ob-btn:hover { border-color: var(--brand); color: var(--brand); }
.ob-btn--primary:hover { color: #fff; }
/* 实心主按钮白字不被 hover 变色改写(hover 对比度门禁) */
.ob-btn--primary { background: #0b8276; border-color: #0b8276; color: #fff; }
/* 白字4.7:1(axe serious),品牌观感同实心主按钮 */
.ob-btn--primary:hover { background: var(--brand-hover); color: #fff; }
</style>
