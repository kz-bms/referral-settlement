'use strict';

// Settles one referral: validates both wallets, converts the incentive, moves
// the money and marks the referral approved. Extracted from kz-referral-cron
// and backOfficeService, which ran two copies of this.
//
// Deliberately does NOT own the queue. The cron scans `referral_cron` while the
// back office takes an explicit list, and they persist blocked referrals to
// different collections — so callers keep that and act on the outcome below.

const crypto = require('crypto');

const OUTCOME = {
  ALREADY_APPROVED: 'alreadyApproved',
  BLOCKED: 'blocked',
  EXCHANGE_FAILED: 'exchangeFailed',
  NO_INCENTIVE: 'noIncentive',
  PAID: 'paid',
};

/**
 * @param {object} referralDoc   the `referral` document data
 * @param {string} referralDocId its id
 * @param {object} deps          see README; all are required except onPaid
 * @returns {Promise<object>}    { outcome, ...details } — never throws for a
 *                               business reason, only for an infrastructure one
 */
async function settleReferral(referralDoc, referralDocId, deps) {
  const {
    admin,
    listWallet,
    checkDisableWallet,
    getReferralIncentiveFromRegion,
    currencyExchange,
    sendReferralFcm,
    toFixed,
    logger,
    adminWalletId,
    defaultCurrency = 'USD',
    onPaid,
  } = deps;

  if (referralDoc.status === 'approved') {
    return { outcome: OUTCOME.ALREADY_APPROVED };
  }

  const firestoreDb = admin.firestore();
  const adminWalletRef = firestoreDb.collection('super_wallet').doc(adminWalletId);
  const txnRefId = crypto.randomBytes(3 * 4).toString('hex');

  // The invitee's wallet must exist and be verified before anyone is paid.
  const referredTo = await resolveReferredTo(referralDoc, { firestoreDb, listWallet });
  if (!referredTo.ref) {
    return { outcome: OUTCOME.BLOCKED, stage: 'referredTo', status: referredTo.status };
  }

  const referredBy = await resolveReferredBy(referralDoc, {
    firestoreDb,
    listWallet,
    checkDisableWallet,
    sendReferralFcm,
  });
  if (!referredBy.ref) {
    logger.info(`ReferredBy ${referralDoc.referredBy} blocked: ${referredBy.status}`);
    return { outcome: OUTCOME.BLOCKED, stage: 'referredBy', status: referredBy.status };
  }

  const wallet = referredBy.wallet;

  // incentiveUsd is what the ledger moves; incentiveLocal is display only.
  const incentiveUsd = await getReferralIncentiveFromRegion(wallet.kyc.region.iso2);
  if (!(incentiveUsd > 0)) return { outcome: OUTCOME.NO_INCENTIVE };

  let incentiveLocal = incentiveUsd;
  let conversionRate = 1;
  if (wallet.kyc.region.currencyAbbreviation !== defaultCurrency) {
    const res = await currencyExchange({
      fromCurrency: defaultCurrency,
      toCurrency: wallet.kyc.region.currencyAbbreviation,
      amount: incentiveUsd,
    });
    if (!res) return { outcome: OUTCOME.EXCHANGE_FAILED };

    incentiveLocal = res['convertedAmount'];
    conversionRate = res['conversionRate'];
  }

  const now = () => new Date().toISOString().replace('T', ' ');

  const adminTransaction = {
    amount: toFixed(incentiveUsd),
    currency: defaultCurrency,
    locale: '',
    txnId: txnRefId,
    mainTxnId: txnRefId,
    receiver: referredBy.receiver,
    receiverRef: referredBy.ref,
    partyRef: referredTo.ref,
    txnType: 'debit',
    txnContext: 'referral_incentive',
    remarks: `Referral | Ref: ${txnRefId}`,
    createdAt: now(),
    createdAtTimestamp: admin.firestore.Timestamp.now(),
  };

  const referredByTxn = {
    amount: toFixed(incentiveLocal),
    currency: wallet.kyc.region.currencyAbbreviation,
    convertedAmount: toFixed(incentiveUsd),
    conversionRate: conversionRate,
    defaultCurrency: defaultCurrency,
    partyRef: referredTo.ref,
    locale: '',
    txnId: txnRefId,
    mainTxnId: txnRefId,
    txnType: 'credit',
    txnContext: 'referral_incentive',
    remarks: `Referral | Ref: ${txnRefId}`,
    createdAt: now(),
    createdAtTimestamp: admin.firestore.Timestamp.now(),
  };

  await debit(adminWalletRef, incentiveUsd, adminTransaction, txnRefId, toFixed);
  logger.info(`Admin transaction updated. ${txnRefId}`);

  await credit(referredBy.ref, incentiveUsd, referredByTxn, txnRefId, toFixed);
  logger.info(`ReferredBy entity transaction updated. ${txnRefId}`);

  if (onPaid) await onPaid({ adminWalletId, referredByWalletId: wallet.walletId });

  await firestoreDb.collection('referral').doc(referralDocId).set(
    { status: 'approved', txnId: txnRefId, updatedAt: admin.firestore.Timestamp.now() },
    { merge: true },
  );
  await firestoreDb.collection('referral_cron').doc(referralDocId).delete();

  return { outcome: OUTCOME.PAID, txnId: txnRefId, referredByWalletId: wallet.walletId };
}

// Returns { ref, status } — ref is null when the referral cannot proceed.
async function resolveReferredTo(referralDoc, { firestoreDb, listWallet }) {
  const array = await listWallet(referralDoc.referredTo ?? '');
  if (!array.wallets.length) return { ref: null, status: referralDoc.status };

  for (const wallet of array.wallets) {
    if (wallet.type !== 'user') continue;

    if (!wallet.kyc.isVerified || wallet.disableWallet) {
      return {
        ref: null,
        status: wallet.disableWallet ? 'newUserWalletDisabled' : 'pending',
      };
    }
    return { ref: firestoreDb.collection('super_wallet').doc(wallet.walletId) };
  }
  return { ref: null, status: referralDoc.status };
}

// Returns { ref, wallet, receiver, status }.
async function resolveReferredBy(
  referralDoc,
  { firestoreDb, listWallet, checkDisableWallet, sendReferralFcm },
) {
  const array = await listWallet(referralDoc.referredBy ?? '');
  if (!array.wallets.length) {
    await sendReferralFcm(referralDoc.referredBy ?? '');
    return { ref: null, status: 'receiverWalletNotCreated' };
  }

  for (const wallet of array.wallets) {
    // Preserved verbatim from both originals: this condition is always true,
    // so retailer/wholesaler wallets are not actually skipped. Left as-is —
    // changing it would change who gets paid.
    if (wallet.type !== 'retailer' || wallet.type !== 'wholesaler') {
      if (
        !wallet.kyc.isVerified ||
        wallet.disableWallet ||
        (await checkDisableWallet(wallet.kyc.region.name))
      ) {
        return {
          ref: null,
          status: !wallet.kyc.isVerified
            ? 'receiverWalletNotVerified'
            : wallet.disableWallet
              ? 'walletDisabled'
              : 'walletRegionDisabled',
        };
      }

      return {
        ref: firestoreDb.collection('super_wallet').doc(wallet.walletId),
        wallet,
        receiver: {
          walletRefId: wallet.walletRefId,
          displayName: wallet.displayName,
          email: wallet.email,
          phoneNumber: wallet.kyc.mobile,
          imageUrl: wallet.imageUrl,
        },
      };
    }
  }
  return { ref: null, status: referralDoc.status };
}

async function debit(walletRef, amount, txn, txnRefId, toFixed) {
  const doc = await walletRef.get();
  const balance = toFixed(doc.data().balance);

  await walletRef.update({ balance: toFixed(balance - amount) });
  txn['previousBalance'] = toFixed(balance);
  await walletRef.collection('transactions').doc(txnRefId).set(txn);
}

async function credit(walletRef, amount, txn, txnRefId, toFixed) {
  const doc = await walletRef.get();
  const balance = toFixed(doc.data().balance);

  await walletRef.update({ balance: toFixed(balance + amount) });
  txn['previousBalance'] = toFixed(balance);
  await walletRef.collection('transactions').doc(txnRefId).set(txn);
}

module.exports = { settleReferral, OUTCOME };