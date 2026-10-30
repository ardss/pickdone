/* Custom protocol privileges (must run before app 'ready'): index.js requires this at module
   top-level, so the schemes are privileged before any window or navigation can use them. */
const { protocol } = require('electron')
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
  { scheme: 'local', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }
])
