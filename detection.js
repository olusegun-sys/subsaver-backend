// WHY: Detection engine for Subsaver. Identifies recurring subscription charges
// from raw Mono transactions. Built for the Nigerian market — amounts come in
// kobo from Mono and are converted to naira (divide by 100).

// WHY: Mono's transaction category field helps filter obvious non-subscription
// transactions before pattern-matching runs[citation:2].
const SUBSCRIPTION_CATEGORIES = ['entertainment', 'personal_care', 'phone_internet'];
const EXCLUDED_CATEGORIES = ['transfer', 'cash_withdrawal', 'bank_charges', 'loan_repayment'];

// WHY: How many occurrences of the same merchant before we consider it recurring.
const MIN_OCCURRENCES = 3;

// WHY: Amount tolerance — subscription prices drift slightly (taxes, plan changes).
// 15% covers realistic variation without letting random charges through.
const AMOUNT_TOLERANCE = 0.15;

// WHY: Gap tolerance in days — monthly bills don't land on the exact same date.
const CADENCE_TOLERANCE_DAYS = 10;

// WHY: If the last charge was more than 1.5x the normal cycle ago, it's likely forgotten.
const FORGOTTEN_MULTIPLIER = 1.5;

/**
 * Normalize a Mono narration string into a clean merchant name.
 * WHY: Mono narrations often contain prefixes/suffixes like "POS PURCHASE NETFLIX.COM #8842".
 * We strip noise to group the same merchant together reliably.
 */
function normalizeMerchant(narration) {
  if (!narration) return '';
  let clean = narration
    .replace(/^POS\s+/i, '')
    .replace(/^TRANSFER\s+(TO|FROM)\s+/i, '')
    .replace(/^WEB\s+/i, '')
    .replace(/\.COM.*$/i, '')
    .replace(/#\w+$/i, '')
    .replace(/\s+\d+$/i, '')
    .trim();
  // WHY: Return lowercase for grouping consistency.
  return clean.toLowerCase();
}

/**
 * Convert Mono's kobo amount to naira.
 * WHY: Mono returns amounts as integers in kobo (smallest unit)[citation:2].
 * Nigeria's standard is to display naira — 1 naira = 100 kobo.
 */
function koboToNaira(kobo) {
  return Math.round(kobo) / 100;
}

/**
 * Main detection function. Takes raw Mono transactions and returns subscriptions.
 * @param {Array} transactions - Raw transaction objects from Mono.
 * @returns {Array} - Subscription objects matching Subsaver's data contract.
 */
export function detectSubscriptions(transactions) {
  // WHY: Guard clause — never process null/undefined input.
  if (!Array.isArray(transactions) || transactions.length === 0) {
    return [];
  }

  // WHY: Step 1 — Filter to debit-only, non-excluded categories.
  // Subscriptions are always outgoing (money leaving the account).
  const debits = transactions.filter(t => {
    const isDebit = t.type === 'debit';
    const category = (t.category || '').toLowerCase();
    const isExcluded = EXCLUDED_CATEGORIES.some(ex => category.includes(ex));
    return isDebit && !isExcluded;
  });

  // WHY: Step 2 — Group by normalized merchant name.
  // This is where "NETFLIX.COM #8842" and "NETFLIX SUBSCRIPTION" become one group.
  const groups = {};
  for (const tx of debits) {
    const merchant = normalizeMerchant(tx.narration);
    if (!merchant) continue;

    if (!groups[merchant]) {
      groups[merchant] = [];
    }
    groups[merchant].push(tx);
  }

  // WHY: Step 3 — Analyze each group for recurring patterns.
  const subscriptions = [];

  for (const [merchantKey, txs] of Object.entries(groups)) {
    // WHY: Need enough occurrences to establish a pattern.
    if (txs.length < MIN_OCCURRENCES) continue;

    // WHY: Sort chronologically so gap calculations are valid.
    txs.sort((a, b) => new Date(a.date) - new Date(b.date));

    // WHY: Collect amounts in naira for consistency checks.
    const amounts = txs.map(t => koboToNaira(t.amount));
    const avgAmount = amounts.reduce((s, a) => s + a, 0) / amounts.length;

    // WHY: If amounts vary wildly, it's not a subscription — it's random spending.
    const maxDeviation = Math.max(...amounts.map(a => Math.abs(a - avgAmount) / avgAmount));
    if (maxDeviation > AMOUNT_TOLERANCE) continue;

    // WHY: Calculate gaps between consecutive charges (in days).
    const gaps = [];
    for (let i = 1; i < txs.length; i++) {
      const prev = new Date(txs[i - 1].date);
      const curr = new Date(txs[i].date);
      const days = Math.round((curr - prev) / (1000 * 60 * 60 * 24));
      gaps.push(days);
    }

    // WHY: Average gap must be within monthly/quarterly/yearly ranges.
    const avgGap = gaps.reduce((s, g) => s + g, 0) / gaps.length;
    const cadence = getCadenceFromGap(avgGap);

    // WHY: If gaps are too inconsistent, it's not a real subscription.
    const maxGapDeviation = Math.max(...gaps.map(g => Math.abs(g - avgGap) / avgGap));
    if (maxGapDeviation > CADENCE_TOLERANCE_DAYS / avgGap) continue;

    // WHY: Build the subscription object per Subsaver's data contract.
    const lastTx = txs[txs.length - 1];
    const lastChargeDate = new Date(lastTx.date);
    const now = new Date();
    const daysSinceLastCharge = Math.round((now - lastChargeDate) / (1000 * 60 * 60 * 24));

    // WHY: "Likely forgotten" heuristic — if the last charge was more than
    // 1.5x the normal cadence ago, the user probably forgot to cancel.
    const isForgotten = daysSinceLastCharge > avgGap * FORGOTTEN_MULTIPLIER;

    subscriptions.push({
      id: `sub_${merchantKey.replace(/\s+/g, '_')}_${lastTx._id?.slice(-6) || Date.now()}`,
      merchant: merchantKey.charAt(0).toUpperCase() + merchantKey.slice(1),
      amount: Math.round(avgAmount),        // WHY: Final NGN amount — no further conversion.
      lastCharge: lastChargeDate.toISOString().split('T')[0], // YYYY-MM-DD format.
      daysSinceLastCharge,
      flagged: isForgotten,
      status: 'active',
    });
  }

  // WHY: Sort by amount descending so the biggest charges surface first.
  return subscriptions.sort((a, b) => b.amount - a.amount);
}

/**
 * Determine cadence label from average gap in days.
 * WHY: Matches Subsaver's existing getCadence() logic for display consistency.
 */
function getCadenceFromGap(days) {
  if (days <= 10) return 'weekly';
  if (days <= 45) return 'monthly';
  if (days <= 100) return 'quarterly';
  return 'yearly';
}