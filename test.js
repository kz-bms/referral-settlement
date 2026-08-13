'use strict';
// node --test
//
// Covers every outcome of settleReferral against a fake Firestore, so the money
// math and the exact writes are pinned without touching a real wallet.

const test = require('node:test');
const assert = require('node:assert');
const { settleReferral, OUTCOME } = require('./index.js');

function makeAdmin(seed = {}) {
  const docs = new Map(Object.entries(seed));
  const writes = [];

  const docRef = (path) => ({
    path,
    get: async () => ({ data: () => docs.get(path), exists: docs.has(path) }),
    update: async (d) => {
      writes.push({ op: 'update', path, data: d });
      docs.set(path, { ...(docs.get(path) || {}), ...d });
    },
    set: async (d, opts) => writes.push({ op: 'set', path, data: d, opts }),
    delete: async () => writes.push({ op: 'delete', path }),
    collection: (c) => ({ doc: (id) => docRef(`${path}/${c}/${id}`) }),
  });

  const firestore = () => ({ collection: (c) => ({ doc: (id) => docRef(`${c}/${id}`) }) });
  firestore.Timestamp = { now: () => 'TS' };

  return { admin: { firestore }, writes, docs };
}

const verifiedWallet = (over = {}) => ({
  type: 'user',
  walletId: 'W_TO',
  kyc: { isVerified: true, mobile: '1', region: { iso2: 'US', name: 'United States', currencyAbbreviation: 'USD' } },
  disableWallet: false,
  walletRefId: 'R', displayName: 'D', email: 'e@x', imageUrl: 'i',
  ...over,
});

function makeDeps(admin, over = {}) {
  return {
    admin,
    listWallet: async () => ({ wallets: [verifiedWallet()] }),
    checkDisableWallet: async () => false,
    getReferralIncentiveFromRegion: async () => 0.1,
    currencyExchange: async () => ({ convertedAmount: 0.93845, conversionRate: 9.3845 }),
    sendReferralFcm: async () => {},
    toFixed: (n) => Number(Number(n).toFixed(6)),
    logger: { info: () => {}, error: () => {} },
    adminWalletId: 'KZADMINWALLET000001',
    defaultCurrency: 'USD',
    ...over,
  };
}

test('already approved does nothing', async () => {
  const { admin, writes } = makeAdmin();
  const r = await settleReferral({ status: 'approved' }, 'D1', makeDeps(admin));

  assert.equal(r.outcome, OUTCOME.ALREADY_APPROVED);
  assert.equal(writes.length, 0, 'must not touch anything');
});

test('referredTo unverified blocks as pending', async () => {
  const { admin, writes } = makeAdmin();
  const deps = makeDeps(admin, {
    listWallet: async () => ({ wallets: [verifiedWallet({ kyc: { ...verifiedWallet().kyc, isVerified: false } })] }),
  });
  const r = await settleReferral({ status: 'x', referredTo: 'A', referredBy: 'B' }, 'D1', deps);

  assert.equal(r.outcome, OUTCOME.BLOCKED);
  assert.equal(r.stage, 'referredTo');
  assert.equal(r.status, 'pending');
  assert.equal(writes.length, 0, 'caller owns persistence, not the module');
});

test('referredTo disabled blocks as newUserWalletDisabled', async () => {
  const { admin } = makeAdmin();
  const deps = makeDeps(admin, {
    listWallet: async () => ({ wallets: [verifiedWallet({ disableWallet: true })] }),
  });
  const r = await settleReferral({ status: 'x' }, 'D1', deps);

  assert.equal(r.status, 'newUserWalletDisabled');
});

test('referrer with no wallet blocks and notifies', async () => {
  const { admin } = makeAdmin();
  let notified = null;
  let call = 0;
  const deps = makeDeps(admin, {
    listWallet: async (kzId) => (++call === 1 ? { wallets: [verifiedWallet()] } : { wallets: [] }),
    sendReferralFcm: async (kzId) => { notified = kzId; },
  });
  const r = await settleReferral({ status: 'x', referredBy: 'BOB' }, 'D1', deps);

  assert.equal(r.outcome, OUTCOME.BLOCKED);
  assert.equal(r.stage, 'referredBy');
  assert.equal(r.status, 'receiverWalletNotCreated');
  assert.equal(notified, 'BOB', 'referrer must be notified');
});

test('referrer region disabled blocks as walletRegionDisabled', async () => {
  const { admin } = makeAdmin();
  const deps = makeDeps(admin, { checkDisableWallet: async () => true });
  const r = await settleReferral({ status: 'x' }, 'D1', deps);

  assert.equal(r.status, 'walletRegionDisabled');
});

test('zero incentive pays nothing', async () => {
  const { admin, writes } = makeAdmin();
  const deps = makeDeps(admin, { getReferralIncentiveFromRegion: async () => 0 });
  const r = await settleReferral({ status: 'x' }, 'D1', deps);

  assert.equal(r.outcome, OUTCOME.NO_INCENTIVE);
  assert.equal(writes.length, 0, 'no money may move');
});

test('failed conversion pays nothing', async () => {
  const { admin, writes } = makeAdmin();
  const deps = makeDeps(admin, {
    listWallet: async () => ({ wallets: [verifiedWallet({ kyc: { ...verifiedWallet().kyc, region: { iso2: 'MA', name: 'Morocco', currencyAbbreviation: 'MAD' } } })] }),
    currencyExchange: async () => null,
  });
  const r = await settleReferral({ status: 'x' }, 'D1', deps);

  assert.equal(r.outcome, OUTCOME.EXCHANGE_FAILED);
  assert.equal(writes.length, 0, 'no money may move');
});

test('pays in a USD region: both legs move the same USD amount', async () => {
  const { admin, writes } = makeAdmin({
    'super_wallet/KZADMINWALLET000001': { balance: 100 },
    'super_wallet/W_TO': { balance: 5 },
  });
  let paidHook = null;
  const deps = makeDeps(admin, { onPaid: async (a) => { paidHook = a; } });

  const r = await settleReferral({ status: 'x' }, 'D1', deps);
  assert.equal(r.outcome, OUTCOME.PAID);

  const balances = writes.filter((w) => w.op === 'update');
  assert.equal(balances[0].data.balance, 99.9, 'admin debited 0.1');
  assert.equal(balances[1].data.balance, 5.1, 'referrer credited 0.1');

  const txns = writes.filter((w) => w.op === 'set' && w.path.includes('/transactions/'));
  assert.equal(txns.length, 2, 'one debit doc, one credit doc');
  assert.equal(txns[0].data.txnType, 'debit');
  assert.equal(txns[1].data.txnType, 'credit');
  assert.equal(txns[0].data.txnId, txns[1].data.txnId, 'same txn id both legs');
  assert.equal(txns[0].data.previousBalance, 100);
  assert.equal(txns[1].data.previousBalance, 5);

  const approved = writes.find((w) => w.op === 'set' && w.path === 'referral/D1');
  assert.equal(approved.data.status, 'approved');
  assert.ok(approved.data.txnId, 'txn id recorded on the referral');

  assert.ok(writes.some((w) => w.op === 'delete' && w.path === 'referral_cron/D1'), 'dequeued');
  assert.deepEqual(paidHook, { adminWalletId: 'KZADMINWALLET000001', referredByWalletId: 'W_TO' });
});

test('pays in a non-USD region: ledger moves USD, txn shows local', async () => {
  const { admin, writes } = makeAdmin({
    'super_wallet/KZADMINWALLET000001': { balance: 100 },
    'super_wallet/W_TO': { balance: 5 },
  });
  const mad = verifiedWallet({ kyc: { ...verifiedWallet().kyc, region: { iso2: 'MA', name: 'Morocco', currencyAbbreviation: 'MAD' } } });
  const deps = makeDeps(admin, { listWallet: async () => ({ wallets: [mad] }) });

  const r = await settleReferral({ status: 'x' }, 'D1', deps);
  assert.equal(r.outcome, OUTCOME.PAID);

  const balances = writes.filter((w) => w.op === 'update');
  assert.equal(balances[1].data.balance, 5.1, 'balance moves the USD amount, not 0.93845');

  const credit = writes.find((w) => w.op === 'set' && w.data && w.data.txnType === 'credit');
  assert.equal(credit.data.amount, 0.93845, 'txn amount is local for display');
  assert.equal(credit.data.convertedAmount, 0.1, 'convertedAmount is the USD ledger figure');
  assert.equal(credit.data.currency, 'MAD');
  assert.equal(credit.data.conversionRate, 9.3845);
});