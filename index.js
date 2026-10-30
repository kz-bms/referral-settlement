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
  NOT_COUNTED: 'notCounted',
  PAID: 'paid',
  UNDER_THRESHOLD: 'underThreshold',
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
    getInfluencerThreshold,
    adminWalletId,
    defaultCurrency = 'USD',
    onPaid,
  } = deps;

  if (referralDoc.status === 'approved') {
    return { outcome: OUTCOME.ALREADY_APPROVED };
  }

  const firestoreDb = admin.firestore();
  const referralRef = firestoreDb.collection('referral').doc(referralDocId);
  const adminWalletRef = firestoreDb.collection('super_wallet').doc(adminWalletId);
  // Derived from the referral id, so a retry reuses the same txn doc ids instead
  // of minting a second pair that looks like an unrelated payment.
  const txnRefId = txnIdFor(referralDocId);

  // The invitee's wallet must exist and be verified before anyone is paid.
  const referredTo = await resolveReferredTo(referralDoc, { firestoreDb, listWallet });
  if (!referredTo.ref) {
    return { outcome: OUTCOME.BLOCKED, stage: 'referredTo', status: referredTo.status };
  }

  // Read from the referral itself: a queued copy can be stale or predate the KYC count.
  const current = (await referralRef.get()).data() || referralDoc;
  if (current.status === 'approved') return { outcome: OUTCOME.ALREADY_APPROVED };

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

  // Decided only where a normal referral would be paid, so an under-threshold
  // one goes through exactly the same wallet checks and statuses.
  const threshold = await checkThreshold(current, getInfluencerThreshold);
  if (threshold.outcome) return threshold;
  if (threshold.underThreshold) {
    return approveUnderThreshold(referralRef, referralDocId, threshold, { admin, firestoreDb, logger });
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
  const blockedBy = await firestoreDb.runTransaction(async (tx) => {
    // Authoritative check: referralDoc was read by the caller and may be stale.
    const fresh = await tx.get(referralRef);
    if (fresh.exists && fresh.data().status === 'approved') return OUTCOME.ALREADY_APPROVED;

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
      { status: 'approved', txnId: txnRefId, updatedAt: admin.firestore.Timestamp.now(), ...threshold.audit },
      { merge: true },
    );
    tx.delete(firestoreDb.collection('referral_cron').doc(referralDocId));

    return null;
  });

  if (blockedBy) return { outcome: blockedBy };

  logger.info(`Referral settled. ${txnRefId}`);

  if (onPaid) await onPaid({ adminWalletId, referredByWalletId: wallet.walletId });

  return { outcome: OUTCOME.PAID, txnId: txnRefId, referredByWalletId: wallet.walletId };
}

// An influencer referral is credited only once it has been counted (at the
// new user's KYC) and its number is above the influencer's current threshold.
// Returns { outcome } when it cannot be decided yet, { underThreshold, ... }
// when it is approved without credit, else { audit } — the fields recorded on
// the referral when it is paid.
async function checkThreshold(referralDoc, getInfluencerThreshold) {
  if (!referralDoc.influencerKzId) return { audit: {} };
  if (referralDoc.referralNumber == null) return { outcome: OUTCOME.NOT_COUNTED };

  if (typeof getInfluencerThreshold !== 'function') {
    throw new Error('getInfluencerThreshold is required to settle an influencer referral');
  }
  const thresholdAtSettlement = await getInfluencerThreshold(referralDoc.influencerKzId);
  if (!Number.isFinite(thresholdAtSettlement)) {
    throw new Error(`No threshold for influencer ${referralDoc.influencerKzId}`);
  }

  if (referralDoc.referralNumber <= thresholdAtSettlement) {
    return { underThreshold: true, referralNumber: referralDoc.referralNumber, thresholdAtSettlement };
  }

  return { audit: { underThreshold: false, thresholdAtSettlement } };
}

// Approves an under-threshold referral like any other, without a transaction or
// any credit; `underThreshold` is what tells it apart for reconciliation.
async function approveUnderThreshold(referralRef, referralDocId, threshold, { admin, firestoreDb, logger }) {
  const { referralNumber, thresholdAtSettlement } = threshold;

  const approved = await firestoreDb.runTransaction(async (tx) => {
    const fresh = await tx.get(referralRef);
    if (fresh.exists && fresh.data().status === 'approved') return false;

    tx.set(
      referralRef,
      { status: 'approved', underThreshold: true, thresholdAtSettlement, updatedAt: admin.firestore.Timestamp.now() },
      { merge: true },
    );
    tx.delete(firestoreDb.collection('referral_cron').doc(referralDocId));

    return true;
  });

  if (!approved) return { outcome: OUTCOME.ALREADY_APPROVED };

  logger.info(`Referral approved under threshold, not credited. ${referralDocId} (#${referralNumber} of ${thresholdAtSettlement})`);

  return { outcome: OUTCOME.UNDER_THRESHOLD, referralNumber, thresholdAtSettlement };
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

    // Ready = approved and mobile verified.
    if (!wallet.kyc.isVerified || !wallet.kyc.isMobileVerified || wallet.disableWallet) {
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
      const ready = wallet.kyc.isVerified && wallet.kyc.isMobileVerified;
      if (
        !ready ||
        wallet.disableWallet ||
        (await checkDisableWallet(wallet.kyc.region.name))
      ) {
        return {
          ref: null,
          status: !ready
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