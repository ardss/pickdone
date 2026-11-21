/**
 * Vite build-time defines (vite.config.mjs `define`) — statically replaced at build time,
 * absent in a plain node run. Consumers (e.g. SettingsModal.buildFingerprint) read them
 * inside try/catch and degrade to 'unknown'.
 */
declare const __APP_BUILD_SHA__: string
declare const __APP_BUILD_CHANNEL__: string
