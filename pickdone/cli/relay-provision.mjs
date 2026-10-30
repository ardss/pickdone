#!/usr/bin/env node
/* eslint-env node */
/**
 * Operator provisioning for the HOSTED drill relay (lubancat): binds a relay account
 * onto a fresh billing account with an ACTIVE cloud subscription, through the SAME
 * durable modules/files the running relay uses (billing-state.json + ledger.jsonl +
 * relay-bindings.json). The running relay must be RESTARTED afterwards to load the
 * new binding — restart-after-provision is itself the persistence acceptance.
 *
 * Usage on lubancat: node ~/jrelay/provision.cjs <relayAccount>
 * Idempotent: an existing binding for the account is left untouched.
 */
import { join } from 'node:path'

const BASE = '/home/cat/jrelay'
const BILLING_DIR = join(BASE, 'relay-data', 'billing')
const account = process.argv[2]
if (!account) { console.error('usage: provision.cjs <relayAccount>'); process.exit(1) }

const billingMod = await import('file://' + join(BASE, 'server/billing/store.mjs'))
const entMod = await import('file://' + join(BASE, 'server/sync-relay-entitlement.mjs'))

const store = billingMod.createBillingStore({ dataDir: BILLING_DIR })
const bridge = entMod.createSandboxTrustBridge({ billingStore: store, bindingsPath: join(BILLING_DIR, 'relay-bindings.json') })

const existing = bridge.bindingOf(account)
if (existing && existing.accountId) {
  console.log('already bound:', account, '->', existing.accountId)
  process.exit(0)
}

const { accountId } = store.createAccount()
store.setSubscription(accountId, {
  accountId,
  planId: 'cloud',
  cycle: 'monthly',
  status: 'active',
  startedAt: Date.now() - 24 * 60 * 60 * 1000,
  currentPeriodEnd: Date.now() + 30 * 24 * 60 * 60 * 1000,
  orderId: 'ord_drill_provision',
  frozenReason: null,
})
bridge.bind(account, accountId)
const verify = await bridge.resolveTrust({ account })
console.log('bound:', account, '->', accountId, '| trusted:', verify.trusted, '| hostedSync:', verify.hostedSync, '| frozen:', verify.frozen)
if (!verify.trusted || !verify.hostedSync) { console.error('PROVISION FAILED — trust did not resolve'); process.exit(1) }
