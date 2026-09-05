/**
 * Pure pixel drawing for the pomodoro tray progress ring / taskbar badge (BGRA, no Electron dependency — unit-testable):
 * progress ring (brand teal = focus / orange = rest) + remaining minutes in the ring center (3×5 pixel font with outline), plus a today's-pomodoro-count badge.
 */
const BRAND_WORK = [15, 157, 143] // teal (brand color, focus state)
const BRAND_REST = [254, 153, 51] // orange (rest state)


/* 3×5 pixel digit font (3 bits per row, top to bottom) — for ring-center minutes / badge digits */
const TS = 32 // tray icon size (ample margin left for the progress ring + minute digits)
const DIGITS = {
  '0': [7, 5, 5, 5, 7], '1': [2, 6, 2, 2, 7], '2': [7, 1, 7, 4, 7], '3': [7, 1, 7, 1, 7],
  '4': [5, 5, 7, 1, 1], '5': [7, 4, 7, 1, 7], '6': [7, 4, 7, 5, 7], '7': [7, 1, 1, 2, 2],
  '8': [7, 5, 7, 5, 7], '9': [7, 5, 7, 1, 7]
}


/** Small BGRA canvas utility */
function canvas (size) {
  const px = new Uint8Array(size * size * 4)
  const set = (x, y, c, a = 255) => {
    x = Math.round(x); y = Math.round(y)
    if (x < 0 || y < 0 || x >= size || y >= size) return
    const i = (y * size + x) * 4
    px[i] = c[2]; px[i + 1] = c[1]; px[i + 2] = c[0]; px[i + 3] = a
  }
  return { px, set }
}

/** Draw text on the canvas with the pixel font (scaled), with an optional halo color for a 1px outline so it stays readable on any background */
function drawText (cv, size, text, cx, cy, scale, color, halo) {
  const glyphW = 3 * scale
  const totalW = text.length * glyphW + (text.length - 1) * scale
  const totalH = 5 * scale
  let ox = Math.round(cx - totalW / 2)
  const oy = Math.round(cy - totalH / 2)
  for (const ch of text) {
    const g = DIGITS[ch]
    if (g) {
      for (let r = 0; r < 5; r++) {
        for (let b = 0; b < 3; b++) {
          if (g[r] & (4 >> b)) {
            for (let dy = 0; dy < scale; dy++) {
              for (let dx = 0; dx < scale; dx++) {
                const x = ox + b * scale + dx
                const y = oy + r * scale + dy
                if (halo) {
                  cv.set(x - 1, y, halo); cv.set(x + 1, y, halo)
                  cv.set(x, y - 1, halo); cv.set(x, y + 1, halo)
                }
              }
            }
          }
        }
      }
      for (let r = 0; r < 5; r++) {
        for (let b = 0; b < 3; b++) {
          if (g[r] & (4 >> b)) {
            for (let dy = 0; dy < scale; dy++) {
              for (let dx = 0; dx < scale; dx++) cv.set(ox + b * scale + dx, oy + r * scale + dy, color)
            }
          }
        }
      }
    }
    ox += glyphW + scale
  }
}


/** Tray icon: progress ring + remaining minutes at the center (with outline, readable on both light and dark taskbars) */
function drawTrayPixels (frac, minutes, color) {
  const cv = canvas(TS)
  const cx = TS / 2, cy = TS / 2, r = TS / 2 - 3
  const base = [136, 136, 136]
  for (let a = 0; a < 360; a += 3) {
    const rad = (a - 90) * Math.PI / 180
    for (let t = -1; t <= 1; t++) cv.set(cx + (r + t) * Math.cos(rad), cy + (r + t) * Math.sin(rad), base, 90)
  }
  if (frac > 0) {
    const sweep = Math.max(1, Math.round(360 * Math.min(1, frac)))
    for (let a = 0; a <= sweep; a += 2) {
      const rad = (a - 90) * Math.PI / 180
      for (let t = -1.5; t <= 1.5; t += 0.5) cv.set(cx + (r + t) * Math.cos(rad), cy + (r + t) * Math.sin(rad), color)
    }
  }
  drawText(cv, TS, String(Math.min(99, minutes)), cx, cy, 2, [255, 255, 255], [40, 40, 40])
  return cv.px
}

/** Today's pomodoro badge: brand-color round base + white digits */
function drawBadgePixels (count) {
  const size = 16
  const cv = canvas(size)
  const cx = size / 2, cy = size / 2, r = size / 2 - 1
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if ((x - cx + 0.5) ** 2 + (y - cy + 0.5) ** 2 <= r * r) cv.set(x, y, BRAND_WORK)
    }
  }
  drawText(cv, size, String(Math.min(99, count)), cx, cy, 1, [255, 255, 255], BRAND_WORK)
  return cv.px
}


module.exports = { drawTrayPixels, drawBadgePixels, BRAND_WORK, BRAND_REST }
