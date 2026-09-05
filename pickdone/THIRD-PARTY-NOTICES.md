# Third-Party Components and Asset Attributions

This project depends on and thanks the following open-source projects. Unless noted otherwise, all licenses are permissive; components are unmodified or carry only adaptation-level changes.

## Runtime dependencies (npm dependencies)
| Component | Usage | License |
|---|---|---|
| electron-log | Logging | MIT |
| electron-updater | Auto-update | MIT |
| dayjs | Date handling | MIT |
| sortablejs | Drag-to-sort | MIT |
| exceljs | CSV/spreadsheet export | Apache-2.0 |
| pinyin-pro | Pinyin search | MIT |
| solarlunar | Lunar calendar conversion | ISC |
| better-sqlite3-multiple-ciphers (bundled in vendor/) | SQLite driver | MIT |

## Front-end libraries (bundled into assets/vendor-lib/ at build time)
| Component | License |
|---|---|
| Vue 3.5 / vue-router 4 / vuex 4 / vue-i18n | MIT |
| Element Plus | MIT |
| Chart.js | MIT |
| FullCalendar (core/daygrid/interaction) | MIT |
| html2canvas / jsPDF | MIT |
| Driver.js (onboarding tours) | MIT |
| dayjs isoWeek plugin | MIT |

## Development/test tooling (not shipped with the package)
Electron Builder, ESLint, jsdom (MIT); axe-core (MPL-2.0); pixelmatch / pngjs (MIT)

## Icons and assets
- Material Symbols style icons (calendar_month_24dp etc.): Google Material Icons, Apache-2.0
- mingcute_* icon series: MingCute Icon, Apache-2.0
- ri_* icon series: Remix Icon, Apache-2.0
- Calendar chevron arrows: Font Awesome Free, CC BY 4.0

## Audio assets
The full source list lives in [assets/media/SOURCES.md](assets/media/SOURCES.md). Attribution-required items:
- rain_to_glass.mp3: alxl, CC-BY (opengameart.org/content/rain-on-window-loop)
- train.ogg: gryc, CC-BY (opengameart.org/content/background-rumble-noise)

The remaining ambient sounds (rain/cave/whitenoise/waterflow, OpenGameArt "30 CC0 SFX Loops" etc.) and the completion chimes (Kenney Confirmation SFX) are all CC0; no synthesized audio is shipped in the package.

## Reservation
License texts and copyright notices for each component are governed by their upstream repositories/distributions; this file is an index and acknowledgment only.
