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
| `notCounted` | an influencer referral (`influencerKzId`) not yet counted against the threshold, i.e. no `referralNumber`; nothing done |
| `paid` | settled. Carries `txnId` and `referredByWalletId` |
| `underThreshold` | an influencer referral whose `referralNumber` is at or below the influencer's threshold, at the point a normal referral would be credited. Approved like any referral but **not credited**: `status: approved`, `underThreshold: true`, `thresholdAtSettlement`, no `txnId`, dequeued. Carries `referralNumber` and `thresholdAtSettlement` |

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
| `getInfluencerThreshold(kzId)` | the influencer's current `fixedReferralCount` as a number. Required once an influencer referral is settled; a missing or non-numeric result throws, so nothing is paid |

## Two things worth knowing

**Balances are USD.** `incentiveUsd` is what moves; `incentiveLocal` is carried
on the transaction for display only. Both legs of the double entry use the USD
figure, which is why they balance.

**The referrer wallet loop preserves an always-true condition** from the
originals (`type !== 'retailer' || type !== 'wholesaler'`), so retailer and
wholesaler wallets are not actually skipped. Left unchanged deliberately —
fixing it would change who gets paid, which is not a refactor.

## Idempotent since 1.0.1

Safe to retry, which matters because the cron runs with `failurePolicy: retry`.

- `txnId` is derived from the referral document id, so a retry reuses the same
  transaction documents instead of minting a second pair.
- Both legs, the `approved` flag and the `referral_cron` delete commit in one
  `runTransaction`, with balances moved by `FieldValue.increment`.
- The status is re-read **inside** that transaction. `referralDoc` comes from the
  caller and may be stale, so its `status` field cannot be trusted on a retry —
  a second attempt returns `alreadyApproved` and moves no money.

Before 1.0.1 the money moved outside any transaction with `approved` written
afterwards, so a failure between the two paid the referrer twice under two
unrelated random txnIds.
## Influencer threshold since 1.0.3

Since 1.0.4 an under-threshold referral is approved without credit; 1.0.3
left it `pending`.

An influencer's first `fixedReferralCount` referees earn no incentive; the
normal incentive starts above that. When a referee completes KYC the backend
increments the influencer's `referralCounter` and stamps the referral with
`referralNumber` (its `influencerKzId` is stamped when the referral is created).

The referral otherwise goes through the normal process, including both wallet
checks and their statuses. Where a normal referral would be credited,
`referralNumber` is compared with the influencer's threshold
**at settlement time**, read through `getInfluencerThreshold`:

- not counted yet (no `referralNumber`) → `notCounted`, nothing written
- `referralNumber <= threshold` → `underThreshold`: approved without credit —
  `status: approved`, `underThreshold: true`, `thresholdAtSettlement`, no
  transaction.
- above it → paid as usual, recording `underThreshold: false` and
  `thresholdAtSettlement` alongside `approved`

For reconciliation: approved with a `txnId` was credited; approved with
`underThreshold: true` was not. There is no threshold status.

The decision reads the `referral` document, not the caller's copy, because the
`referral_cron` copy may predate the count.
