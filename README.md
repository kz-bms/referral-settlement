# referral-settlement

Settles one referral: validates both wallets, converts the incentive, moves the
money, and marks the referral approved.

Two copies of this used to exist — `kz-referral-cron/index.js` and
`backOfficeService/model/Wallet.js` — which meant every money fix had to land
twice.

```js
const { settleReferral, OUTCOME } = require('referral-settlement');

const result = await settleReferral(referralDoc, referralDocId, deps);
```

## What it does not do

It does not own the queue. The cron scans `referral_cron`; the back office takes
an explicit list. They also persist blocked referrals to different collections.
That logic stays with each caller, which acts on the returned outcome.

## Outcomes

| outcome | meaning |
|---|---|
| `alreadyApproved` | `referralDoc.status` was already `approved`; nothing done |
| `blocked` | a wallet check failed. Carries `stage` (`referredTo`/`referredBy`) and the `status` to persist |
| `exchangeFailed` | currency conversion returned nothing; no money moved |
| `noIncentive` | the region's `referralIncentive` is not > 0 |
| `paid` | settled. Carries `txnId` and `referredByWalletId` |

On `paid` it has already written both transaction documents, set the referral to
`approved`, and deleted the `referral_cron` document.

## Dependencies

Injected, because the two callers have different helper modules.

| key | purpose |
|---|---|
| `admin` | initialised `firebase-admin` |
| `listWallet(kzId)` | `{ wallets: [...] }` |
| `checkDisableWallet(regionName)` | region-level wallet freeze |
| `getReferralIncentiveFromRegion(iso2)` | incentive in USD |
| `currencyExchange({fromCurrency,toCurrency,amount})` | `{ convertedAmount, conversionRate }`, or falsy on failure |
| `sendReferralFcm(kzId)` | notify when the referrer has no wallet |
| `toFixed(n)` | the caller's rounding |
| `logger` | `{ info, error }` |
| `adminWalletId` | the wallet that funds incentives |
| `defaultCurrency` | optional, defaults to `USD` |
| `onPaid({adminWalletId, referredByWalletId})` | optional; the back office re-indexes Solr here |

## Two things worth knowing

**Balances are USD.** `incentiveUsd` is what moves; `incentiveLocal` is carried
on the transaction for display only. Both legs of the double entry use the USD
figure, which is why they balance.

**The referrer wallet loop preserves an always-true condition** from the
originals (`type !== 'retailer' || type !== 'wholesaler'`), so retailer and
wholesaler wallets are not actually skipped. Left unchanged deliberately —
fixing it would change who gets paid, which is not a refactor.

## Not yet idempotent

`txnId` is random per attempt and balances are read-then-write rather than
`FieldValue.increment` inside a transaction. A retry after a partial failure can
pay twice. That predates this extraction and is the next thing worth fixing.