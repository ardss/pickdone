<template>
  <div class="empty" :class="{ 'empty--inline': inline }">
    <div class="empty__icon" v-html="icon"></div>
    <div class="empty__text"><slot name="text"/></div>
    <slot name="action"/>
  </div>
</template>

<script lang="ts">
/**
 * Shared empty-state component (replaces the repeated
 * `.empty > .empty__icon + .empty__text` three-line markup across views).
 *
 * Rendered DOM is byte-identical to the previous hand-written markup:
 *   <div class="empty"><div class="empty__icon"></div><div class="empty__text">…</div></div>
 * Styling lives entirely in assets/css/base.css (.empty / .empty__icon / .empty__text),
 * so this component carries no scoped styles — zero visual diff by construction.
 *
 * Props:
 *  - icon (string, optional): raw SVG/HTML for a custom icon. Default: none —
 *    the icon div stays empty and the base.css background illustration shows.
 *  - inline (boolean, default false): adds the `empty--inline` modifier
 *    (compact auto-height variant, see base.css).
 *
 * Slots:
 *  - text:   the empty-state message (i18n expression passed through verbatim).
 *  - action: optional action button/link, rendered as a direct child of `.empty`
 *            (after `.empty__text`) — matches the legacy ProjectOverviewView layout.
 */
export default {
  name: 'EmptyState',
  props: {
    icon: { type: String, default: '' },
    inline: { type: Boolean, default: false }
  }
}
</script>
