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
  // Derived from the referral id, so a retry reuses the same txn doc ids instead
  // of minting a second pair that looks like an unrelated payment.
  const txnRefId = txnIdFor(referralDocId);

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
  // Callers log the blocked cases themselves — their wording differs and is
  // grepped in the field.
  if (!referredBy.ref) {
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

  // Both legs, the approval and the dequeue commit together or not at all. The
  // platform retries a failed run (failurePolicy: retry), and before this the
  // money moved outside any transaction with `approved` written afterwards — so
  // a failure between the two paid the referrer twice.
  const referralRef = firestoreDb.collection('referral').doc(referralDocId);
  const paid = await firestoreDb.runTransaction(async (tx) => {
    // Authoritative check: referralDoc was read by the caller and may be stale.
    const fresh = await tx.get(referralRef);
    if (fresh.exists && fresh.data().status === 'approved') return false;

    // Every read must precede the writes below.
    const adminSnap = await tx.get(adminWalletRef);
    const receiverSnap = await tx.get(referredBy.ref);
    const adminBalance = toFixed(adminSnap.data().balance);
    const receiverBalance = toFixed(receiverSnap.data().balance);

    const increment = admin.firestore.FieldValue.increment;
    tx.update(adminWalletRef, { balance: increment(-incentiveUsd) });
    tx.update(referredBy.ref, { balance: increment(incentiveUsd) });

    tx.set(adminWalletRef.collection('transactions').doc(txnRefId), {
      ...adminTransaction,
      previousBalance: adminBalance,
    });
    tx.set(referredBy.ref.collection('transactions').doc(txnRefId), {
      ...referredByTxn,
      previousBalance: receiverBalance,
    });

    tx.set(
      referralRef,
      { status: 'approved', txnId: txnRefId, updatedAt: admin.firestore.Timestamp.now() },
      { merge: true },
    );
    tx.delete(firestoreDb.collection('referral_cron').doc(referralDocId));

    return true;
  });

  if (!paid) return { outcome: OUTCOME.ALREADY_APPROVED };

  logger.info(`Referral settled. ${txnRefId}`);

  if (onPaid) await onPaid({ adminWalletId, referredByWalletId: wallet.walletId });

  return { outcome: OUTCOME.PAID, txnId: txnRefId, referredByWalletId: wallet.walletId };
}

// Stable per referral, same 24-hex shape the random ids had.
function txnIdFor(referralDocId) {
  return crypto.createHash('sha256').update(String(referralDocId)).digest('hex').slice(0, 24);
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

module.exports = { settleReferral, OUTCOME };