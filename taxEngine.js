// taxEngine.js — deterministic Indian income-tax computation.
// Ported line-for-line from the frontend's calcTaxNew / calcTaxOld / applyTax
// (itr.html) so the backend and the browser NEVER disagree on the numbers.
// Keep this file in sync with itr.html if the frontend tax logic changes.

function calcTaxNew(taxable, year) {
  let slabs;
  if (year === '2025-26') {
    slabs = [
      { lo: 0,       hi: 400000,   rate: 0,    label: 'Up to ₹4,00,000' },
      { lo: 400000,  hi: 800000,   rate: 0.05, label: '₹4,00,001 – ₹8,00,000' },
      { lo: 800000,  hi: 1200000,  rate: 0.10, label: '₹8,00,001 – ₹12,00,000' },
      { lo: 1200000, hi: 1600000,  rate: 0.15, label: '₹12,00,001 – ₹16,00,000' },
      { lo: 1600000, hi: 2000000,  rate: 0.20, label: '₹16,00,001 – ₹20,00,000' },
      { lo: 2000000, hi: 2400000,  rate: 0.25, label: '₹20,00,001 – ₹24,00,000' },
      { lo: 2400000, hi: Infinity, rate: 0.30, label: 'Above ₹24,00,000' },
    ];
  } else {
    slabs = [
      { lo: 0,       hi: 300000,   rate: 0,    label: 'Up to ₹3,00,000' },
      { lo: 300000,  hi: 600000,   rate: 0.05, label: '₹3,00,001 – ₹6,00,000' },
      { lo: 600000,  hi: 900000,   rate: 0.10, label: '₹6,00,001 – ₹9,00,000' },
      { lo: 900000,  hi: 1200000,  rate: 0.15, label: '₹9,00,001 – ₹12,00,000' },
      { lo: 1200000, hi: 1500000,  rate: 0.20, label: '₹12,00,001 – ₹15,00,000' },
      { lo: 1500000, hi: Infinity, rate: 0.30, label: 'Above ₹15,00,000' },
    ];
  }
  let tax = 0; const bd = [];
  for (const sl of slabs) {
    const tis = taxable > sl.lo ? Math.min(taxable, sl.hi) - sl.lo : 0;
    bd.push({ ...sl, tis, taxInSlab: tis * sl.rate });
    tax += tis * sl.rate;
  }
  return { tax, bd };
}

function calcTaxOld(taxable, age) {
  let ex = 250000;
  if (age === 'senior') ex = 300000;
  if (age === 'supersenior') ex = 500000;
  const slabs = [
    { lo: 0,        hi: ex,        rate: 0,    label: 'Up to ' + ex },
    { lo: ex,       hi: 500000,    rate: 0.05, label: ex + ' – ₹5,00,000' },
    { lo: 500000,   hi: 1000000,   rate: 0.20, label: '₹5,00,001 – ₹10,00,000' },
    { lo: 1000000,  hi: Infinity,  rate: 0.30, label: 'Above ₹10,00,000' },
  ];
  let tax = 0; const bd = [];
  for (const sl of slabs) {
    const tis = taxable > sl.lo ? Math.min(taxable, sl.hi) - sl.lo : 0;
    bd.push({ ...sl, tis, taxInSlab: tis * sl.rate });
    tax += tis * sl.rate;
  }
  return { tax, bd };
}

// CORRECT ORDER: Base Tax → Surcharge → Rebate 87A → Cess 4%
function applyTax(rawTax, taxable, regime, year) {
  let sur = 0;
  if (taxable > 5000000  && taxable <= 10000000) sur = rawTax * 0.10;
  if (taxable > 10000000 && taxable <= 20000000) sur = rawTax * 0.15;
  if (taxable > 20000000 && taxable <= 50000000) sur = rawTax * 0.25;
  if (taxable > 50000000) sur = rawTax * (regime === 'new' ? 0.25 : 0.37);
  const taxWithSur = rawTax + sur;

  let reb = 0;
  if (sur === 0) {
    if (regime === 'new') {
      if (year === '2025-26' && taxable <= 1200000) reb = Math.min(rawTax, 60000);
      else if (taxable <= 700000) reb = Math.min(rawTax, 25000);
    }
    if (regime === 'old' && taxable <= 500000) reb = Math.min(rawTax, 12500);
  }

  const afterReb = Math.max(0, taxWithSur - reb);
  const cess = Math.round(afterReb * 0.04);
  return { total: Math.round(afterReb + cess), reb, sur: Math.round(sur), cess };
}

const STD_NEW = 75000;
const STD_OLD = 50000;

// Computes taxable_income_new/old + tax_new/tax_old from the raw extracted
// fields, exactly mirroring the browser's recalcWithDeductions() but using
// the Form-16-extracted deduction figures as the starting point (before the
// user manually edits anything in "Recalculate & Compare").
function computeTax({ salary, deductionsOld, otherIncomeTotal, businessTaxable, fy, age }) {
  const gross    = salary.gross_salary || 0;
  const hraEx    = salary.hra_exempt || 0;
  const otherEx  = salary.other_exempt || 0;
  const ptax     = Math.min(salary.professional_tax || 0, 2500);
  const enps     = deductionsOld.sec_80ccd_2_employer_nps || 0;
  const otherInc = (otherIncomeTotal || 0) + (businessTaxable || 0);

  // Chapter VI-A total EXCLUDING employer NPS (that's applied separately,
  // to both regimes) — matches d.deductions_old.total in the frontend.
  const chVI = Math.max(0, (deductionsOld.total || 0) - enps);

  const txNew = Math.max(0, (gross - STD_NEW) + otherInc - enps);

  const salEx  = hraEx + otherEx + ptax;
  const netSal = Math.max(0, gross - salEx - STD_OLD) + otherInc;
  const txOld  = Math.max(0, netSal - chVI - enps);

  const { tax: rNew } = calcTaxNew(txNew, fy);
  const { tax: rOld } = calcTaxOld(txOld, age);
  const tNew = applyTax(rNew, txNew, 'new', fy);
  const tOld = applyTax(rOld, txOld, 'old', fy);

  return { taxable_income_new: Math.round(txNew), taxable_income_old: Math.round(txOld), tax_new: tNew, tax_old: tOld };
}

module.exports = { calcTaxNew, calcTaxOld, applyTax, computeTax, STD_NEW, STD_OLD };
