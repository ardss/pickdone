#!/usr/bin/env node
/**
 * PickDone billing — standalone sandbox service entry.
 *
 *   node server/billing-service.mjs --port 58481 [--data ./billing-data]
 *
 * Secrets policy (never hardcoded, never persisted):
 *   PICKDONE_BILLING_WEBHOOK_SECRET   sandbox webhook HMAC secret
 *   PICKDONE_BILLING_ADMIN_TOKEN      /v1/reconcile*
 *   PICKDONE_BILLING_INTERNAL_TOKEN   /v1/usage (trusted storage reporter)
 * Missing env vars are replaced by RANDOM per-boot values printed once to
 * stderr — convenient for sandbox/dev, self-invalidating across restarts, so
 * nothing secret ever lands in a file or in git.
 *
 * This is the SANDBOX slice: the provider is the in-process simulator, the
 * identity is mock (per-account API keys minted here). No real money, no real
 * merchant, no real checkout URL. Real-provider wiring is evidence-gated.
 */

import { createBillingService, startBillingServer } from './billing/service.mjs'
import { createSandboxProvider } from './billing/providers/sandbox.mjs'
import { randomBytes } from 'node:crypto'

const args = process.argv.slice(2)
const argOf = name => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : null
}

const port = Number(argOf('--port') || process.env.PORT || 58481)
const dataDir = argOf('--data') || null

const env = name => process.env[name] || null
const webhookSecret = env('PICKDONE_BILLING_WEBHOOK_SECRET')
const adminToken = env('PICKDONE_BILLING_ADMIN_TOKEN')
const internalToken = env('PICKDONE_BILLING_INTERNAL_TOKEN')
if (!webhookSecret || !adminToken || !internalToken) {
  process.stderr.write('[billing] missing env secrets — generating RANDOM per-boot values (sandbox only):\n')
}

const service = createBillingService({
  dataDir,
  provider: createSandboxProvider({ webhookSecret: webhookSecret || randomBytes(24).toString('hex') }),
  adminToken: adminToken || undefined,
  internalToken: internalToken || undefined,
})
if (!webhookSecret) process.stderr.write(`  PICKDONE_BILLING_WEBHOOK_SECRET=(random) admin=${service.config.adminToken.slice(0, 6)}… internal=${service.config.internalToken.slice(0, 6)}…\n`)

const server = await startBillingServer(service, { port })
const addr = server.address()
process.stdout.write(`[billing] sandbox billing service on http://${addr.address}:${addr.port} (data: ${dataDir || 'memory-only'})\n`)
process.stdout.write('[billing] SANDBOX MODE — simulated payments, mock identity, no real charges\n')
