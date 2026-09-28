/* Regression check for lib-cdp-client.cjs error paths (round 6):
 * 1. getJSON against a stale service returning non-JSON (HTML) must REJECT, not throw an
 *    uncaughtException out of the 'end' handler.
 * 2. cdpConnect must reject pending send/evalJS when the socket closes, instead of hanging
 *    the caller (and the process exit-zombie guard) forever.
 * 3. cdpConnect timeoutMs must reject a call that never gets a response.
 * Run: node cli/check-cdp-client.cjs  (no Electron, no browser needed) */
const http = require('http')
const net = require('net')
const assert = require('assert')
const { getJSON, cdpConnect } = require('./lib-cdp-client.cjs')

const withTimeout = (p, ms, label) => Promise.race([
  p,
  new Promise((_, rej) => setTimeout(() => rej(new Error(label + ': still pending after ' + ms + 'ms')), ms))
])

async function main () {
  // --- 1. non-JSON body -> rejection, not uncaughtException ---
  let uncaught = null
  const onUncaught = e => { uncaught = e }
  process.on('uncaughtException', onUncaught)
  const htmlServer = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<html>stale service</html>') })
  await new Promise(r => htmlServer.listen(0, '127.0.0.1', r))
  const htmlPort = htmlServer.address().port
  let rejErr = null
  try { await withTimeout(getJSON(htmlPort, '/json/version'), 3000, 'getJSON html') } catch (e) { rejErr = e }
  htmlServer.close()
  assert.ok(rejErr, 'getJSON must reject on non-JSON body')
  assert.ok(/non-JSON response/.test(rejErr.message), 'reject reason names non-JSON body, got: ' + rejErr.message)
  assert.strictEqual(uncaught, null, 'no uncaughtException may escape getJSON')
  process.off('uncaughtException', onUncaught)

  // --- 2. socket close -> pending calls reject ---
  // Minimal WebSocket server: complete the RFC6455 handshake, then destroy the socket. The
  // client's WebSocket must fire onclose, and the in-flight send/evalJS must reject via
  // failAll instead of hanging forever.
  const crypto = require('crypto')
  const conns = []
  const tcp = net.createServer(sock => {
    conns.push(sock)
    let buf = ''
    sock.on('data', d => {
      buf += d
      if (!buf.includes('\r\n\r\n')) return // handshake headers may arrive split
      const key = /Sec-WebSocket-Key:\s*(\S+)/i.exec(buf)
      if (!key || sock.upgraded) return
      sock.upgraded = true
      sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${crypto.createHash('sha1').update(key[1].trim() + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')}\r\n\r\n`)
      setTimeout(() => sock.destroy(), 100)
    })
  })
  await new Promise(r => tcp.listen(0, '127.0.0.1', r))
  const tcpPort = tcp.address().port
  const c = cdpConnect(`ws://127.0.0.1:${tcpPort}/devtools/browser/x`)
  await c.open // handshake completes before the server destroys the socket
  let sendErr = null
  try { await withTimeout(c.send('Runtime.evaluate', {}), 3000, 'send on closed socket') } catch (e) { sendErr = e }
  let evalErr = null
  try { await withTimeout(c.evalJS('1+1'), 3000, 'evalJS on closed socket') } catch (e) { evalErr = e }
  conns.forEach(s => s.destroy()); tcp.close()
  assert.ok(sendErr, 'send must reject after socket close')
  assert.ok(/CDP/.test(sendErr.message), 'send rejection is CDP-labeled, got: ' + sendErr.message)
  assert.ok(evalErr, 'evalJS must reject after socket close')
  assert.ok(/CDP/.test(evalErr.message), 'evalJS rejection is CDP-labeled, got: ' + evalErr.message)

  // --- 3. timeoutMs rejects a never-answered call ---
  const silent = net.createServer(sock => conns.push(sock)) // accept, never respond, never close
  await new Promise(r => silent.listen(0, '127.0.0.1', r))
  const sPort = silent.address().port
  const c2 = cdpConnect(`ws://127.0.0.1:${sPort}/x`, { timeoutMs: 200 })
  // silent server never completes the handshake -> `open` itself must reject via timeoutMs
  let openErr = null
  try { await withTimeout(c2.open, 3000, 'open timeout') } catch (e) { openErr = e }
  let toErr = null
  try { await withTimeout(c2.evalJS('1+1'), 3000, 'evalJS timeout') } catch (e) { toErr = e }
  conns.forEach(s => s.destroy()); silent.close()
  assert.ok(openErr && /timed out/.test(openErr.message), 'open must reject via timeoutMs on silent peer, got: ' + (openErr && openErr.message))
  assert.ok(toErr, 'evalJS must reject (timeout or dead socket), never hang, got: ' + (toErr && toErr.message))

  console.log('check-cdp-client: OK (non-JSON reject, close rejects pending, timeoutMs)')
}

main().then(
  () => process.exit(0),
  e => { console.error('check-cdp-client: FAIL\n' + (e && e.stack || e)); process.exit(1) }
)
