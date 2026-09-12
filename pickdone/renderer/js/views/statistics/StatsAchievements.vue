<template>
  <!-- 7. Achievements wall (markup moved verbatim from StatisticsView.vue; all copy via the global statsA.* shard) -->
  <div class="tl-card ach-card">
    <div class="tl-head"><b>{{ $t('statsA.StatisticsView.achTitle') }}</b><span class="tl-sub">{{ $t('statsA.StatisticsView.achSub', { n: achievements.earnedCount }) }}</span></div>
    <div class="ach-totals">
      <div class="ach-total">
        <div class="ach-total__v">{{ achievements.totals.done }}</div>
        <div class="ach-total__t">{{ $t('statsA.StatisticsView.achTotalDone') }}</div>
      </div>
      <div class="ach-total">
        <div class="ach-total__v">{{ achievements.totals.focusHours }}<span class="ach-total__u">{{ $t('statsA.StatisticsView.unitHour') }}</span></div>
        <div class="ach-total__t">{{ $t('statsA.StatisticsView.achTotalFocus') }}</div>
      </div>
      <div class="ach-total">
        <div class="ach-total__v">{{ achievements.totals.streak }}<span class="ach-total__u">{{ $t('statsA.StatisticsView.unitDay') }}</span></div>
        <div class="ach-total__t">{{ $t('statsA.StatisticsView.achTotalStreak') }}</div>
      </div>
    </div>
    <div class="ach-fams">
      <div v-for="f in achievements.families" :key="f.id" class="ach-fam" :class="{'ach-fam--max': f.maxed}">
        <span class="ach-fam__icon" v-html="f.icon"></span>
        <div class="ach-fam__info">
          <div class="ach-fam__row1">
            <span class="ach-fam__name">{{ $t(f.famNameKey) }}</span>
            <span class="ach-fam__lv" :class="{'ach-fam__lv--max': f.maxed}">Lv.{{ f.level }}<template v-if="f.maxed"> MAX</template></span>
          </div>
          <div class="ach-fam__num">
            <span class="ach-fam__cur">{{ f.cur }}</span>
            <span class="ach-fam__next">/ {{ f.nextV }} {{ $t(f.unitKey) }} · {{ $t(f.nextNameKey || 'statsA.Achievements.achMax') }}</span>
          </div>
          <div class="ach-progress"><div class="ach-progress__bar" :style="{width: f.pct+'%'}"></div></div>
        </div>
        <span class="ach-fam__badges" :title="$t('statsA.Achievements.achEarnedN', { n: f.earnedBadgesOfFam })">
          <template v-if="f.earnedBadgesOfFam">✓×{{ f.earnedBadgesOfFam }}</template>
        </span>
      </div>
    </div>
  </div>
</template>

<script lang="ts">
/**
 * Achievements wall extracted from StatisticsView.vue (2026-09-12 split, S1 pilot).
 * Pure presentation over the buildAchievements() model (statistics/achievements.js).
 */
export default {
  name: 'StatsAchievements',
  props: {
    achievements: { type: Object, required: true }
  }
}
</script>
