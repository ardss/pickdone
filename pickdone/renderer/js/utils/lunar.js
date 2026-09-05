/** Sole funnel for deep-importing solarlunar: the two relative depths used to be inconsistent (../../../ crossed the project root, white-screening main.js).
 *  ISC-licensed solarlunar (js-calendar-converter was GPL, hence the library switch). */
export const loadSolarLunar = () => import('../../../node_modules/solarlunar/dist/solarlunar.esm.js')
