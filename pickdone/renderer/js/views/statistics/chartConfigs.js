/**
 * Statistics page chart config builders (split out from StatisticsView) — Chart.js data/options assembly for
 * the four canvas chart kinds chart-c/e/f/g. Pure functions, no component state.
 */
/**
 * Statistics —— aligned with the reference insights page (todo-list-statistics, component scope):
 *   div.page > div.navbar (yesterday summary/event stats/tomato stats/weekly report, 4 navbar__item)
 *   + div.content > base-scrollbar > div.container > subpage (.page max-width:785px)
 * Project baseline subpages: event stats/tomato stats carry div.page__select > m-select (last 7 days to last year / custom range),
 *           yesterday summary/weekly report render dataList directly.
 * Data pipeline: reference POST /todoList/getReportTask|getReportTomato|getReportWeek|getReportYesterdaySummary
 *   (params userId/token/showTomato/startTime[/endTime]/weekStartSun), returning data.list =
 *   an array of modelType-dispatched models; the offline implementation computes an isomorphic dataList locally from Vuex (todoList/tomatoRecordList/category),
 *   then goes through the isomorphic ChartGeneric dispatcher. modelType mapping vs the reference ChartGeneric (index.pretty.js ud function):
 *     1/layoutId0->chart-a icon text card | 2->double+chart-b x2 | 3->chart-c line | 1/layoutId1->chart-d big number
 *     4->chart-e bar | 5->chart-f doughnut | 6->chart-g radar | 88->chart-h premium upgrade.
 * The Chart.js configs for ChartA~H are modeled on index.pretty.js (Md=chart.js):
 *   main color #7f8df0, fill rgba(15, 157, 143, 0.2), aspectRatio 2.5, y-axis dashed grid borderDash:[5],
 *   doughnut palette ['#0f9d8f','#ff8b2b','#ef655b','#2e7ab9','#40aac9','#f96f96'], etc.
 */
import { cssVar, tt } from '../../utils/core.js'

// Monochrome lightness gradient (dark -> light): the category chart expresses hierarchy with shades of one main color instead of rainbow colors

// Brand teal monochrome lightness gradient (dark -> light): derived from the global --brand=#0f9d8f
const DOUGHNUT_PALETTE = ['#0a6f62', '#0f9d8f', '#3cb4a5', '#6fc7bb', '#a3dbd3', '#d9efeb']
/* Range options store i18n keys (statsA.ChartConfigs.*), resolved with $t at render time (no component instance at module level) */
const RANGE_OPTIONS = [
  'statsA.ChartConfigs.range7d',
  'statsA.ChartConfigs.range14d',
  'statsA.ChartConfigs.range30d',
  'statsA.ChartConfigs.range3m',
  'statsA.ChartConfigs.range6m',
  'statsA.ChartConfigs.range1y'
]

/** Whether the current theme is dark (html[data-theme="dark"] when colorMode=dark) */
function isDarkTheme () {
  return document.documentElement.getAttribute('data-theme') === 'dark'
}

/* ---------- Chart.js configs (modeled on the reference ChartC/E/F/G structure) ---------- */

/** ChartC line chart (type line, tension .4, fill; when baselineValue is provided, a dashed baseline reference line is overlaid;
 *  mainLabel overrides the default main-series legend name, e.g. the focus-trend chart shows "focus minutes") */
function chartCConfig (list, baselineValue, mainLabel) {
  const main = {
    label: mainLabel || tt('statsA.ChartConfigs.legendDone'),
    data: list.map(i => i.value),
    tension: .4,
    borderColor: cssVar('--brand') || '#0f9d8f',
    backgroundColor: 'rgba(15, 157, 143, 0.2)',
    fill: !0
  }
  const datasets = baselineValue != null
    ? [main, {
        label: tt('statsA.ChartConfigs.legendBaseline'),
        data: list.map(() => baselineValue),
        borderColor: 'rgba(127,140,153,.55)',
        borderWidth: 1.5,
        borderDash: [6, 5],
        pointRadius: 0,
        fill: !1
      }]
    : [main]
  return {
    type: 'line',
    data: { labels: list.map(i => i.label), datasets },
    options: {
      responsive: !0,
      aspectRatio: 2.5,
      interaction: { mode: 'index', intersect: !1 },
      stacked: !1,
      plugins: {
        legend: { display: baselineValue != null || !!mainLabel, position: 'bottom', labels: { boxWidth: 10, usePointStyle: !0, color: '#8a939d', font: { size: 11 } } }
      },
      scales: {
        x: { grid: { drawBorder: !1, display: !1 } },
        y: { grid: { drawBorder: !1, color: 'rgba(127,140,153,.12)' }, ticks: { color: '#9aa3ad' } }
      }
    }
  }
}

/** ChartE bar chart (type bar, borderWidth 2, fill; when overlayList is provided, a line sub-series is overlaid) */
function chartEConfig (list, overlayList) {
  const datasets = [{
    label: tt('statsA.ChartConfigs.legendDone'),
    data: list.map(i => i.value),
    borderColor: cssVar('--brand') || '#0f9d8f',
    borderWidth: 2,
    backgroundColor: 'rgba(15, 157, 143, 0.2)',
    fill: !0
  }]
  if (overlayList) {
    datasets.push({
      type: 'line',
      label: tt('statsA.ChartConfigs.legendFocusNorm'),
      data: overlayList.map(i => i.value),
      yAxisID: 'y1',
      borderColor: '#0a6f62',
      borderWidth: 2,
      pointRadius: 2.5,
      tension: .35,
      fill: !1
    })
  }
  return {
    type: 'bar',
    data: { labels: list.map(i => i.label), datasets },
    options: {
      responsive: !0,
      aspectRatio: 2.5,
      interaction: { mode: 'index', intersect: !1 },
      plugins: {
        legend: { display: !!overlayList, position: 'bottom', labels: { boxWidth: 10, usePointStyle: !0, color: '#8a939d', font: { size: 11 } } }
      },
      scales: {
        x: { grid: { drawBorder: !1, display: !1 } },
        y: { grid: { drawBorder: !1, color: 'rgba(127,140,153,.12)' }, ticks: { color: '#9aa3ad' } },
        /* The sub-series uses the right axis to show real values (minutes) instead of being normalized onto the left axis */
        ...(overlayList ? { y1: { position: 'right', grid: { drawOnChartArea: !1 }, ticks: { color: '#9aa3ad' } } } : {})
      }
    }
  }
}

/** ChartF doughnut chart (tooltip with two-decimal percentages + legend at bottom) */
function chartFConfig (list) {
  return {
    type: 'doughnut',
    data: {
      labels: list.map(i => i.label),
      datasets: [{
        data: list.map(i => i.value),
        backgroundColor: DOUGHNUT_PALETTE.slice(),
        hoverOffset: 4
      }]
    },
    options: {
      responsive: !0,
      aspectRatio: 2.5,
      plugins: {
        tooltip: { callbacks: { label (t) { return `${t.label}: ${(100 * t.parsed).toFixed(1)}%` } } },
        legend: { position: 'bottom', labels: { boxWidth: 10, boxHeight: 10, usePointStyle: !0, color: '#8a939d', font: { size: 12 } } }
      }
    }
  }
}

/** ChartG radar chart (r-axis ticks hidden, pointLabels 12px) */
function chartGConfig (list) {
  return {
    type: 'radar',
    data: {
      labels: list.map(i => i.label),
      datasets: [{
        data: list.map(i => i.value),
        borderColor: cssVar('--brand') || '#0f9d8f',
        backgroundColor: 'rgba(15, 157, 143, 0.2)',
        fill: !0
      }]
    },
    options: {
      responsive: !0,
      aspectRatio: 2.5,
      elements: { line: { borderWidth: 2 } },
      plugins: { legend: { display: !1 } },
      scales: {
        r: { ticks: { display: !1 }, pointLabels: { font: { size: 12 } } }
      }
    }
  }
}

/**
 * ChartGeneric isomorphic dispatcher —— corresponds to the reference index.pretty.js ud render function:
 * 1&&layoutId0→chart-a / 2→double(chart-b left+right) / 3→chart-c / 1&&layoutId1→chart-d /
 * 4->chart-e / 5->chart-f / 6->chart-g / 88->chart-h / others -> .none "chart not adapted"
 */

export { DOUGHNUT_PALETTE, RANGE_OPTIONS, isDarkTheme, chartCConfig, chartEConfig, chartFConfig, chartGConfig }
