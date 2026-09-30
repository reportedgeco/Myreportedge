// netlify/functions/analyze.js
// Backend for the ITR Preview tool (itr.html). Called as POST /.netlify/functions/analyze
//
// Request body — one of:
//   Single Form-16:      { base64, mimeType, name, year, password }
//   Multi-document mode: { documents: [{docType, base64, mimeType, label, password}, ...], year, name }
//
// Response body always matches the shape itr.html's renderReport() expects,
// e.g. { taxpayer_name, pan, fy, salary, deductions_old, tds, tax_new, tax_old,
//        taxable_income_new, taxable_income_old, confidence, missing_data, ... }
// or, on failure: { error: "human readable message" }
//
// REQUIRES an environment variable ANTHROPIC_API_KEY to be set in
// Netlify → Site settings → Environment variables.

const { extractOneDocument } = require('./extractForm16');
const { computeTax } = require('./taxEngine');

function mergeNumeric(a, b) { return (a || 0) + (b || 0); }

// Combine extraction results from multiple documents (2 Form-16s, or a
// Form-16 + Form 26AS) into one consolidated data object.
function consolidate(results, labels) {
  const employers = results.map((r, i) => ({
    name: r.employer_name || labels[i] || `Employer ${i + 1}`,
    gross_salary: r.salary?.gross_salary || 0,
    tds: r.tds?.total_tax_paid || 0,
  }));

  const salary = {
    gross_salary: results.reduce((s, r) => mergeNumeric(s, r.salary?.gross_salary), 0),
    hra_exempt: results.reduce((s, r) => mergeNumeric(s, r.salary?.hra_exempt), 0),
    other_exempt: results.reduce((s, r) => mergeNumeric(s, r.salary?.other_exempt), 0),
    professional_tax: Math.max(...results.map(r => r.salary?.professional_tax || 0)),
  };

  const deductions_old = {
    sec_80c: Math.max(...results.map(r => r.deductions_old?.sec_80c || 0)),
    sec_80d: Math.max(...results.map(r => r.deductions_old?.sec_80d || 0)),
    sec_80ccd_2_employer_nps: results.reduce((s, r) => mergeNumeric(s, r.deductions_old?.sec_80ccd_2_employer_nps), 0),
    home_loan_interest: Math.max(...results.map(r => r.deductions_old?.home_loan_interest || 0)),
    other: Math.max(...results.map(r => r.deductions_old?.other || 0)),
  };
  deductions_old.total = deductions_old.sec_80c + deductions_old.sec_80d + deductions_old.sec_80ccd_2_employer_nps + deductions_old.home_loan_interest + deductions_old.other;

  const other_income = results.reduce((acc, r) => {
    const o = r.other_income || {};
    acc.savings_interest = mergeNumeric(acc.savings_interest, o.savings_interest);
    acc.fd_interest = mergeNumeric(acc.fd_interest, o.fd_interest);
    acc.dividend = mergeNumeric(acc.dividend, o.dividend);
    acc.interest_194a = mergeNumeric(acc.interest_194a, o.interest_194a);
    acc.dividend_194 = mergeNumeric(acc.dividend_194, o.dividend_194);
    acc.total = mergeNumeric(acc.total, o.total);
    return acc;
  }, {});

  const business_income = results.reduce((acc, r) => {
    const b = r.business_income || {};
    acc.gross_receipts_194j = mergeNumeric(acc.gross_receipts_194j, b.gross_receipts_194j);
    acc.taxable_business_income = mergeNumeric(acc.taxable_business_income, b.taxable_business_income);
    return acc;
  }, {});

  const tds = { total_tax_paid: results.reduce((s, r) => mergeNumeric(s, r.tds?.total_tax_paid), 0) };

  const missing = [...new Set(results.flatMap(r => r.missing_data || []))];
  const confidences = results.map(r => r.confidence || 'medium');
  const confidence = confidences.includes('low') ? 'low' : confidences.includes('medium') ? 'medium' : 'high';

  const primary = results[0] || {};

  return {
    taxpayer_name: primary.taxpayer_name,
    pan: primary.pan,
    employer_name: employers.map(e => e.name).join(' + '),
    salary, deductions_old, other_income, business_income, tds,
    confidence, missing_data: missing,
    is_consolidated: true,
    employer_count: employers.length,
    employers,
    data_sources: labels,
    deduplication_notes: [],
  };
}

exports.handler = async (event) => {
  const headers = { 'content-type': 'application/json' };

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return { statusCode: 200, headers, body: JSON.stringify({ error: 'Server is not configured yet (missing ANTHROPIC_API_KEY). Please contact support.' }) };
  }

  let payload;
  try { payload = JSON.parse(event.body || '{}'); } catch (e) {
    return { statusCode: 200, headers, body: JSON.stringify({ error: 'Malformed request.' }) };
  }

  const year = payload.year || '2025-26';
  const age = payload.age || 'below60';
  const name = payload.name;

  try {
    let extracted, isConsolidated = false, dataSources = [];

    if (Array.isArray(payload.documents) && payload.documents.length > 0) {
      isConsolidated = payload.documents.length > 1;
      dataSources = payload.documents.map(d => d.label || d.docType || 'document');
      const results = await Promise.all(payload.documents.map(d =>
        extractOneDocument({ base64: d.base64, mimeType: d.mimeType, label: d.label || d.docType, apiKey })
      ));
      extracted = isConsolidated ? consolidate(results, dataSources) : results[0];
    } else if (payload.base64) {
      extracted = await extractOneDocument({ base64: payload.base64, mimeType: payload.mimeType, label: 'Form-16', apiKey });
    } else {
      return { statusCode: 200, headers, body: JSON.stringify({ error: 'No document was received. Please attach your Form-16 and try again.' }) };
    }

    const fy = extracted.fy || year;

    const { taxable_income_new, taxable_income_old, tax_new, tax_old } = computeTax({
      salary: extracted.salary || {},
      deductionsOld: extracted.deductions_old || {},
      otherIncomeTotal: extracted.other_income?.total || 0,
      businessTaxable: extracted.business_income?.taxable_business_income || 0,
      fy, age,
    });

    const responseData = {
      ...extracted,
      taxpayer_name: extracted.taxpayer_name || name,
      fy,
      taxable_income_new,
      taxable_income_old,
      tax_new,
      tax_old,
      is_consolidated: isConsolidated,
      data_sources: dataSources.length ? dataSources : undefined,
    };

    return { statusCode: 200, headers, body: JSON.stringify(responseData) };
  } catch (err) {
    console.error('analyze error:', err);
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ error: err.message || 'Something went wrong while analysing your document. Please try again with a clearer PDF.' }),
    };
  }
};
