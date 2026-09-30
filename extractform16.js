// extractForm16.js — calls the Claude API to pull structured fields out of a
// Form-16 / Form 26AS PDF or image. Shared by the Netlify function and the
// local test harness so both use identical extraction logic.

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5-20250929';

const EXTRACT_TOOL = {
  name: 'record_form16_data',
  description: 'Records the structured data extracted from an Indian Form-16 / Form 12BA / Form 26AS document.',
  input_schema: {
    type: 'object',
    properties: {
      taxpayer_name: { type: 'string' },
      pan: { type: 'string', description: '10-character PAN, e.g. ADTPU0062E' },
      fy: { type: 'string', description: 'Financial year in the form "2025-26"' },
      employer_name: { type: 'string' },
      confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
      missing_data: { type: 'array', items: { type: 'string' }, description: 'Human-readable list of expected fields that could not be found in the document' },
      salary: {
        type: 'object',
        properties: {
          gross_salary: { type: 'number', description: 'Gross salary / total emoluments before any exemption or deduction' },
          hra_exempt: { type: 'number', description: 'HRA exemption under section 10(13A), 0 if not applicable' },
          other_exempt: { type: 'number', description: 'Other exemptions under section 10 (e.g. LTA, leave encashment), 0 if none' },
          professional_tax: { type: 'number' },
        },
        required: ['gross_salary'],
      },
      deductions_old: {
        type: 'object',
        description: 'Chapter VI-A deductions already declared to the employer / visible on the Form-16, as used for the Old Regime',
        properties: {
          sec_80c: { type: 'number' },
          sec_80d: { type: 'number' },
          sec_80ccd_2_employer_nps: { type: 'number', description: "Employer's NPS contribution under 80CCD(2) — allowed under BOTH tax regimes" },
          home_loan_interest: { type: 'number' },
          other: { type: 'number' },
          total: { type: 'number', description: 'Sum of all Chapter VI-A deductions shown on the Form-16, INCLUDING sec_80ccd_2_employer_nps' },
        },
      },
      other_income: {
        type: 'object',
        properties: {
          savings_interest: { type: 'number' },
          fd_interest: { type: 'number' },
          dividend: { type: 'number' },
          interest_194a: { type: 'number' },
          dividend_194: { type: 'number' },
          total: { type: 'number' },
        },
      },
      business_income: {
        type: 'object',
        properties: {
          gross_receipts_194j: { type: 'number' },
          taxable_business_income: { type: 'number', description: '50% presumptive taxation on 194J/194JB receipts' },
        },
      },
      tds: {
        type: 'object',
        properties: {
          total_tax_paid: { type: 'number', description: 'Total tax deducted at source, as shown under "Total tax paid" / section 192' },
        },
        required: ['total_tax_paid'],
      },
      is_consolidated: { type: 'boolean' },
      employer_count: { type: 'number' },
      employers: {
        type: 'array',
        items: {
          type: 'object',
          properties: { name: { type: 'string' }, gross_salary: { type: 'number' }, tds: { type: 'number' } },
        },
      },
      data_sources: { type: 'array', items: { type: 'string' } },
      deduplication_notes: { type: 'array', items: { type: 'string' } },
    },
    required: ['salary', 'tds', 'confidence'],
  },
};

function mimeFor(name) {
  const n = (name || '').toLowerCase();
  if (n === 'image/jpeg' || n === 'image/jpg' || n === 'image/png' || n === 'application/pdf') return n;
  return 'application/pdf';
}

async function extractOneDocument({ base64, mimeType, label, apiKey }) {
  const mt = mimeFor(mimeType);
  const blockType = mt === 'application/pdf' ? 'document' : 'image';

  const body = {
    model: MODEL,
    max_tokens: 4096,
    system: `You are a precise Indian payroll/tax document reader. Extract data from the attached ${label || 'Form-16'} document and call record_form16_data with the fields you find. Use 0 for numeric fields that are genuinely absent (not "not found"). List every field you could NOT find in missing_data using plain English names (e.g. "HRA exemption", "PAN"). Never invent numbers — only report what is printed in the document. gross_salary must be the TOTAL gross salary/emoluments before any exemption or standard deduction is subtracted.`,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: blockType,
            source: { type: 'base64', media_type: mt, data: base64 },
          },
          { type: 'text', text: `Extract the structured Form-16 data from this document (${label || 'Form-16'}) and call record_form16_data.` },
        ],
      },
    ],
    tools: [EXTRACT_TOOL],
    tool_choice: { type: 'tool', name: 'record_form16_data' },
  };

  const resp = await fetch(ANTHROPIC_API_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  });

  const raw = await resp.text();
  let json;
  try { json = JSON.parse(raw); } catch (e) {
    throw new Error(`Claude API returned non-JSON (status ${resp.status}): ${raw.slice(0, 300)}`);
  }
  if (!resp.ok) {
    const msg = json?.error?.message || `Claude API error (status ${resp.status})`;
    throw new Error(msg);
  }

  const toolUse = (json.content || []).find(b => b.type === 'tool_use' && b.name === 'record_form16_data');
  if (!toolUse) throw new Error('Claude did not return structured data for this document.');
  return toolUse.input;
}

module.exports = { extractOneDocument };
