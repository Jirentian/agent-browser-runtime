// Alibaba Public lead extractor for Agent Browser Runtime.
//
// Runs in the Agent Browser Runtime broker against the rendered Alibaba
// International / AliSupplier public-pool page. Default collection is readonly.
// Claiming is performed only by explicit claim-and-extract scripts.

export const schema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    mode: { type: 'string', enum: ['page_state', 'list'], default: 'list' },
    maxItems: { type: 'integer', default: 50 },
    maxScrolls: { type: 'integer', default: 5 },
    scrollPauseMs: { type: 'integer', default: 1600 },
    pageLoadWaitMs: { type: 'integer', default: 3500 },
    waitForRowsMs: { type: 'integer', default: 10000 },
    collectDetailTabs: { type: 'boolean', default: true },
    collectContactCard: { type: 'boolean', default: true },
    tabWaitMs: { type: 'integer', default: 1800 },
    minTextLength: { type: 'integer', default: 24 },
    includeRawText: { type: 'boolean', default: true },
    rowSelector: { type: 'string', default: 'tr, [class*="customer"], [class*="inquiry"], [class*="lead"], [class*="card"], [class*="item"]' },
  },
};

export async function extract({ pageHtml = '', url, finalUrl, params = {}, ui }) {
  const config = normalizeParams(params);
  const targetUrl = finalUrl || url || '';
  await sleep(config.pageLoadWaitMs);
  await ui?.waitFor?.({ selector: 'body', timeoutMs: 20000 }).catch(() => null);

  let html = pageHtml || '';
  const snapshots = [];
  for (let i = 0; i < config.maxScrolls; i += 1) {
    await ui?.scroll?.({ count: 1, deltaY: 900 + (i % 3) * 220, pauseMs: config.scrollPauseMs }).catch(() => null);
    await sleep(config.scrollPauseMs);
    const refreshed = await ui?.html?.({ timeoutMs: 30000 }).catch(() => null);
    if (refreshed?.html) html = refreshed.html;
  }
  if (!html) {
    const refreshed = await ui?.html?.({ timeoutMs: 30000 }).catch(() => null);
    html = refreshed?.html || '';
  }
  html = await waitForStablePublicListHtml({ html, targetUrl, ui, waitForRowsMs: config.waitForRowsMs });
  snapshots.push({ label: 'initial', html, text: textFromHtml(html) });

  const pageState = evaluateAlibabaPageState(targetUrl, html, snapshots[0].text);
  if (config.mode === 'page_state') {
    return {
      source: 'alibaba_public',
      kind: 'page_state',
      mode: config.mode,
      url: targetUrl,
      page_state: pageState,
      total: 0,
      leads: [],
      diagnostics: {
        htmlLength: html.length,
        interactionPolicy: 'readonly_no_mouse_no_scroll',
      },
    };
  }

  if (config.collectContactCard && isCustomerDetailPage(targetUrl, snapshots[0].text) && ui) {
    const contactSnapshot = await captureContactCardSnapshot(ui, html, config.tabWaitMs);
    if (contactSnapshot?.html) snapshots.push(contactSnapshot);
  }

  if (config.collectDetailTabs && isCustomerDetailPage(targetUrl, snapshots[0].text) && ui) {
    for (const tab of DETAIL_TAB_TARGETS) {
      const clicked = await clickDetailTab(ui, tab, config.tabWaitMs);
      if (!clicked?.ok) continue;
      await sleep(config.tabWaitMs);
      const refreshed = await ui.html({ timeoutMs: 30000, humanize: false }).catch(() => null);
      if (refreshed?.html) snapshots.push({ label: tab.label, html: refreshed.html, text: textFromHtml(refreshed.html) });
    }
  }

  const htmlForParse = snapshots.map((snapshot) => snapshot.html).join('\n');
  const textForParse = snapshots.map((snapshot) => snapshot.text).join(' | ');
  const leads = parseAlibabaPublicLeads(htmlForParse, {
    sourceUrl: targetUrl,
    maxItems: config.maxItems,
    minTextLength: config.minTextLength,
    includeRawText: config.includeRawText,
    snapshots,
    combinedText: textForParse,
    isDetailPage: isCustomerDetailPage(targetUrl, textForParse),
  });

  return {
    source: 'alibaba_public',
    kind: 'lead_candidates',
    mode: config.mode,
    url: targetUrl,
    total: leads.length,
    leads,
    diagnostics: {
      htmlLength: htmlForParse.length,
      parsedBlocks: collectCandidateBlocks(htmlForParse, config.minTextLength).length,
      maxItems: config.maxItems,
      maxScrolls: config.maxScrolls,
      includeRawText: config.includeRawText,
      detailSnapshots: snapshots.map((snapshot) => snapshot.label),
      page_state: pageState,
    },
  };
}

function normalizeParams(params) {
  return {
    mode: params.mode || 'list',
    maxItems: positiveInt(params.maxItems, 50),
    maxScrolls: params.mode === 'page_state' ? 0 : positiveInt(params.maxScrolls, 5),
    scrollPauseMs: positiveInt(params.scrollPauseMs, 1600),
    pageLoadWaitMs: positiveInt(params.pageLoadWaitMs, 3500),
    waitForRowsMs: positiveInt(params.waitForRowsMs, 10000),
    collectDetailTabs: params.collectDetailTabs !== false,
    collectContactCard: params.collectContactCard !== false,
    tabWaitMs: positiveInt(params.tabWaitMs, 1800),
    minTextLength: positiveInt(params.minTextLength, 24),
    includeRawText: params.includeRawText !== false,
    rowSelector: params.rowSelector || '',
  };
}

async function waitForStablePublicListHtml({ html, targetUrl, ui, waitForRowsMs }) {
  const startedAt = Date.now();
  let currentHtml = html || '';
  while (Date.now() - startedAt <= waitForRowsMs) {
    const state = evaluateAlibabaPageState(targetUrl, currentHtml, textFromHtml(currentHtml));
    if (state.status !== 'unknown' || !ui) return currentHtml;
    await sleep(500);
    const refreshed = await ui.html({ timeoutMs: 30000, humanize: false }).catch(() => null);
    if (refreshed?.html) currentHtml = refreshed.html;
  }
  return currentHtml;
}

function evaluateAlibabaPageState(url, html, visibleText) {
  const cleanText = normalizeSpace(visibleText);
  const actualUrl = String(url || '');
  const passwordInputCount = (String(html || '').match(/type=["']password["']/gi) || []).length;
  const customerRowCount = (String(html || '').match(/next-table-row/g) || []).length;
  const isPublicCustomerUrl = /alicrm\.alibaba\.com\/\?/i.test(actualUrl) && actualUrl.includes('#public-customer');
  const isCustomerDetailUrl = /\/crmpage\/customer_detail/i.test(actualUrl);
  const detailCompanyName = detailCompanyNameFromUrl(actualUrl);
  const hasDetailCompany = !detailCompanyName || cleanText.toLowerCase().includes(detailCompanyName.toLowerCase());
  const hasDetailBasicInfo = cleanText.includes('客户详情') && cleanText.includes('建档时间') && cleanText.includes('经营地址') && hasDetailCompany;
  const hasVisibleLoginForm = /(登录|Sign in|Password|密码)/i.test(cleanText) && /(login|password|密码)/i.test(cleanText);
  const hasCaptchaOrSecurity = /(captcha|安全验证|安全校验|滑块验证|拖动滑块|请完成验证|人机验证|security check|verify you are human)/i.test(cleanText);
  const hasCustomerTong = cleanText.includes('客户通');
  const hasPublicCustomer = cleanText.includes('公海客户');
  const hasCustomerRows = customerRowCount > 0;

  return {
    status: isPublicCustomerUrl && hasCustomerTong && hasPublicCustomer && hasCustomerRows && !hasVisibleLoginForm && passwordInputCount === 0 && !hasCaptchaOrSecurity
      ? 'public_customer_list_ready'
      : isCustomerDetailUrl && hasDetailBasicInfo && !hasVisibleLoginForm && passwordInputCount === 0 && !hasCaptchaOrSecurity
        ? 'customer_detail_ready'
        : hasVisibleLoginForm || passwordInputCount > 0
          ? 'login_required'
          : hasCaptchaOrSecurity
            ? 'captcha_or_security_check'
            : 'unknown',
    actual_url: actualUrl,
    has_customer_tong: hasCustomerTong,
    has_public_customer: hasPublicCustomer,
    has_customer_rows: hasCustomerRows,
    customer_row_count: customerRowCount,
    password_input_count: passwordInputCount,
    has_visible_login_form: hasVisibleLoginForm,
    has_captcha_or_security: hasCaptchaOrSecurity,
    is_public_customer_url: isPublicCustomerUrl,
    is_customer_detail_url: isCustomerDetailUrl,
    has_detail_basic_info: hasDetailBasicInfo,
    has_detail_company: hasDetailCompany,
  };
}

function detailCompanyNameFromUrl(url) {
  try {
    return cleanValue(new URL(url || '').searchParams.get('companyName') || '');
  } catch (_) {
    return '';
  }
}

function parseAlibabaPublicLeads(html, options) {
  const seen = new Map();
  const leads = [];

  for (const item of parseListRows(html, options)) {
    pushLead(leads, seen, item, options);
    if (leads.length >= options.maxItems) break;
  }
  if (leads.length >= options.maxItems) {
    return leads.slice(0, options.maxItems).map((lead, index) => ({ result_rank: index + 1, ...lead }));
  }

  for (const item of parseJsonLikeObjects(html, options)) {
    pushLead(leads, seen, item, options);
  }
  for (const block of collectCandidateBlocks(html, options.minTextLength)) {
    pushLead(leads, seen, parseLeadBlock(block, options), options);
    if (leads.length >= options.maxItems) break;
  }

  return leads.slice(0, options.maxItems).map((lead, index) => ({
    result_rank: index + 1,
    ...lead,
  }));
}

function pushLead(leads, seen, lead, options) {
  if (!lead) return;
  const cleaned = cleanLead(lead, options);
  if (!isUsefulLead(cleaned)) return;
  const key = cleaned.dedupe_key || [
    cleaned.crm_customer_id,
    cleaned.company_name,
    cleaned.contact_name,
    cleaned.country,
    cleaned.detail_url,
  ].filter(Boolean).join('|').toLowerCase();
  if (!key) return;
  if (seen.has(key)) {
    const index = seen.get(key);
    leads[index] = mergeLead(leads[index], { ...cleaned, dedupe_key: key });
    return;
  }
  seen.set(key, leads.length);
  leads.push({ ...cleaned, dedupe_key: key });
}

function mergeLead(base, extra) {
  const merged = { ...base };
  for (const [key, value] of Object.entries(extra)) {
    if (value == null || value === '') continue;
    if (Array.isArray(value)) {
      merged[key] = Array.from(new Set([...(merged[key] || []), ...value]));
    } else if (value && typeof value === 'object') {
      merged[key] = mergeNested(merged[key], value);
    } else if (merged[key] == null || merged[key] === '') {
      merged[key] = value;
    }
  }
  return merged;
}

function mergeNested(base, extra) {
  if (base == null) return extra;
  const merged = { ...base };
  for (const [key, value] of Object.entries(extra)) {
    if (value == null || value === '') continue;
    if (Array.isArray(value)) {
      merged[key] = Array.from(new Set([...(merged[key] || []), ...value]));
    } else if (value && typeof value === 'object') {
      merged[key] = mergeNested(merged[key], value);
    } else if (merged[key] == null || merged[key] === '') {
      merged[key] = value;
    }
  }
  return merged;
}

function cleanLead(lead, options) {
  const urlHints = leadHintsFromUrl(options.sourceUrl);
  const rawText = normalizeSpace(lead.raw_text || '');
  const detailUrl = absolutizeUrl(lead.detail_url || firstUrl(rawText) || urlHints.detail_url, options.sourceUrl);
  const crmCustomerId = cleanId(lead.crm_customer_id || urlHints.crm_customer_id || findFirst(rawText, ID_PATTERNS));
  const companyName = cleanValue(urlHints.company_name || lead.company_name || findFirst(rawText, COMPANY_PATTERNS));
  const contactName = cleanValue(urlHints.contact_name || lead.contact_name || findFirst(rawText, CONTACT_PATTERNS));
  const email = cleanEmail(lead.email || findFirst(rawText, EMAIL_PATTERNS) || (options.isDetailPage ? findFirst(options.combinedText || '', EMAIL_PATTERNS) : ''));
  const country = cleanValue(lead.country || findFirst(rawText, COUNTRY_PATTERNS));
  const memberLevel = cleanValue(lead.member_level || findFirst(rawText, LEVEL_PATTERNS));
  const interestCategory = cleanValue(lead.interest_category || findFirst(rawText, INTEREST_PATTERNS));
  const recentLogin = cleanValue(lead.recent_login || findFirst(rawText, LOGIN_PATTERNS));
  const purchaseIntent = cleanValue(lead.purchase_intent || findFirst(rawText, PURCHASE_PATTERNS));
  const lastFollowUp = cleanValue(lead.last_follow_up || findFirst(rawText, FOLLOWUP_PATTERNS));
  const detail = options.isDetailPage ? extractDetailData(options.combinedText || rawText, options.snapshots || [], options.sourceUrl) : emptyDetailData();

  const publicNotes = [
    interestCategory && `interest=${interestCategory}`,
    recentLogin && `recent_login=${recentLogin}`,
    purchaseIntent && `purchase=${purchaseIntent}`,
    lastFollowUp && `last_follow_up=${lastFollowUp}`,
  ].filter(Boolean).join('; ');

  const result = {
    source_type: 'alibaba_public',
    crm_customer_id: crmCustomerId || null,
    company_name: companyName || null,
    contact_name: contactName || null,
    email: email || null,
    country: country || null,
    member_level: memberLevel || null,
    interest_category: interestCategory || null,
    recent_login: recentLogin || null,
    purchase_intent: purchaseIntent || null,
    last_follow_up: lastFollowUp || null,
    public_notes: publicNotes || null,
    public_pool_summary: lead.public_pool_summary || null,
    list_click_target: lead.list_click_target || null,
    claim_click_target: lead.claim_click_target || null,
    basic_info: detail.basic_info,
    site_behavior: detail.site_behavior,
    store_footprint: detail.store_footprint,
    business_records: detail.business_records,
    buyer_homepage: detail.buyer_homepage,
    contact_card: cleanContactCardForLead(detail.contact_card, { companyName, contactName }),
    detail_url: detailUrl || null,
    source_url: options.sourceUrl || null,
  };
  if (options.includeRawText) result.raw_text = rawText.slice(0, 1800);
  return result;
}

function isUsefulLead(lead) {
  if (lead.crm_customer_id || lead.email) return true;
  const businessIdentity = Boolean(lead.company_name || lead.contact_name);
  const buyerContext = [lead.country, lead.member_level, lead.interest_category, lead.recent_login, lead.purchase_intent, lead.last_follow_up]
    .filter(Boolean).length;
  return businessIdentity && buyerContext >= 1;
}

function parseJsonLikeObjects(html, options) {
  const text = decodeHtml(stripScriptsNoise(html));
  const items = [];
  const objectRe = /\{[^{}]*(?:customerId|customer_id|buyerId|buyerName|companyName|company|country|email|memberLevel|inquiry)[^{}]*\}/gi;
  let match;
  while ((match = objectRe.exec(text))) {
    const raw = match[0];
    const lead = {
      crm_customer_id: jsonValue(raw, ['customerId', 'customer_id', 'buyerId', 'buyer_id', 'crmCustomerId']),
      company_name: jsonValue(raw, ['companyName', 'company_name', 'company']),
      contact_name: jsonValue(raw, ['buyerName', 'contactName', 'contact_name', 'name']),
      email: jsonValue(raw, ['email', 'mail']),
      country: jsonValue(raw, ['country', 'countryName', 'country_name']),
      member_level: jsonValue(raw, ['memberLevel', 'level', 'customerLevel']),
      interest_category: jsonValue(raw, ['category', 'interestCategory', 'productCategory']),
      purchase_intent: jsonValue(raw, ['purchaseIntent', 'inquiry', 'requirement']),
      detail_url: jsonValue(raw, ['url', 'detailUrl', 'detail_url']),
      raw_text: raw,
    };
    if (hasNativeUsefulLead(lead)) items.push(lead);
  }
  return items;
}

function parseListRows(html) {
  const rows = [];
  const rowRe = /<tr\b[^>]*class="[^"]*\bnext-table-row\b[^"]*"[^>]*>[\s\S]*?<\/tr>/gi;
  let match;
  while ((match = rowRe.exec(html))) {
    const row = match[0];
    const rowIndex = listRowIndex(row);
    const cells = collectCells(row);
    if (cells.length < 10) continue;
    const byCol = Object.fromEntries(cells.map((cell) => [cell.col ?? String(cell.j), cell]));
    const identity = parseListIdentity(byCol[1]?.html || '', byCol[1]?.text || '');
    if (!identity.contact_name && !identity.company_name) continue;
    const follow = parseFollowCell(byCol[3]?.text || '');
    const noteTime = cellMain(byCol[4]?.text || '');
    const country = cellMain(byCol[8]?.text || '');
    const customerSource = normalizeDelimitedList(cellMain(byCol[9]?.text || ''));
    const businessType = normalizeDelimitedList(cellMain(byCol[10]?.text || ''));
    const ownerName = cellMain(byCol[11]?.text || '');
    const latestFollowTime = cellMain(byCol[12]?.text || '');
    const createdAt = cellMain(byCol[13]?.text || '');
    rows.push({
      source_type: 'alibaba_public',
      contact_name: identity.contact_name,
      company_name: identity.company_name,
      email: identity.email,
      country,
      member_level: cellMain(byCol[2]?.text || ''),
      list_click_target: identity.click_target ? listClickTarget(identity.click_target, rowIndex) : null,
      claim_click_target: claimClickTarget(rowIndex),
      last_follow_up: compactNotes([
        follow.status && `status=${follow.status}`,
        follow.note && `note=${follow.note}`,
        noteTime && `note_time=${noteTime}`,
      ]),
      purchase_intent: cellMain(byCol[5]?.text || ''),
      public_pool_summary: {
        customer_stage: cellMain(byCol[2]?.text || '') || null,
        follow_status: follow.status || null,
        follow_note: follow.note || null,
        note_time: noteTime || null,
        country: country || null,
        customer_source: customerSource || null,
        business_type: businessType || null,
        owner_name: ownerName || null,
        latest_follow_time: latestFollowTime || null,
        created_at: createdAt || null,
      },
      raw_text: cells.map((cell) => cell.text).filter(Boolean).join(' | '),
    });
  }
  return rows;
}

function listRowIndex(rowHtml) {
  const value = /data-next-table-row="([^"]+)"/i.exec(rowHtml)?.[1];
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function listClickTarget(baseTarget, rowIndex) {
  const selector = Number.isFinite(rowIndex)
    ? `td[data-next-table-row="${rowIndex}"][data-next-table-col="1"] .name`
    : 'td[data-next-table-col="1"] .name';
  return {
    strategy: 'selector',
    selector,
    target_text: baseTarget.target_text,
    selector_hint: 'td[data-next-table-row="<row_index>"][data-next-table-col="1"] .name',
    source_area: 'public_customer_list',
    confidence: Number.isFinite(rowIndex) ? 'high' : 'medium',
    row_index: rowIndex,
  };
}

function claimClickTarget(rowIndex) {
  const selector = Number.isFinite(rowIndex)
    ? `td[data-next-table-row="${rowIndex}"][data-next-table-col="14"] .add-my-customer`
    : 'td[data-next-table-col="14"] .add-my-customer';
  return {
    strategy: 'selector',
    selector,
    selector_hint: 'td[data-next-table-row="<row_index>"][data-next-table-col="14"] .add-my-customer',
    source_area: 'public_customer_list_operation',
    action: 'add_to_my_customer',
    confidence: Number.isFinite(rowIndex) ? 'high' : 'medium',
    row_index: rowIndex,
  };
}

function collectCells(rowHtml) {
  const cells = [];
  const cellRe = /<td\b([^>]*)>[\s\S]*?<\/td>/gi;
  let match;
  while ((match = cellRe.exec(rowHtml))) {
    const attrs = match[1] || '';
    cells.push({
      j: cells.length,
      col: /data-next-table-col="([^"]+)"/i.exec(attrs)?.[1] || null,
      html: match[0],
      text: textFromHtml(match[0]),
    });
  }
  return cells;
}

function parseListIdentity(html, text) {
  const name = htmlTextByClass(html, 'name');
  const company = htmlTextByClass(html, 'column-component-company-name-companyName');
  const parts = String(text).split('|').map((part) => cleanValue(part)).filter(Boolean);
  const email = parts.find((part) => part.includes('@')) || '';
  const nonEmail = parts.filter((part) => !part.includes('@'));
  const contactName = name || nonEmail[0] || '';
  const companyName = company || nonEmail.slice(1).reverse().find((part) => part !== contactName) || contactName;
  return {
    contact_name: contactName,
    company_name: companyName,
    email,
    click_target: name ? {
      target_text: name,
    } : null,
  };
}

function htmlTextByClass(html, className) {
  const re = new RegExp(`<[^>]+class=["'][^"']*\\b${escapeRe(className)}\\b[^"']*["'][^>]*>([\\s\\S]*?)<\\/[^>]+>`, 'i');
  return cleanValue(textFromHtml(re.exec(html)?.[1] || ''));
}

function parseFollowCell(text) {
  const parts = String(text).split('|').map((part) => cleanValue(part)).filter(Boolean);
  return {
    status: parts[0] || '',
    note: parts.slice(1).join(' | '),
  };
}

function cellMain(text) {
  const parts = String(text).split('|').map((part) => cleanValue(part)).filter((part) => part && part !== '-');
  return parts.join(' | ');
}

function normalizeDelimitedList(value) {
  return String(value || '')
    .split('|')
    .flatMap((part) => part.split(','))
    .map((part) => cleanValue(part))
    .filter((part) => part && part !== '-')
    .join(',') || '';
}

function hasNativeUsefulLead(lead) {
  if (lead.crm_customer_id || lead.email) return true;
  const businessIdentity = Boolean(lead.company_name || lead.contact_name);
  const buyerContext = [lead.country, lead.member_level, lead.interest_category, lead.recent_login, lead.purchase_intent, lead.last_follow_up]
    .filter(Boolean).length;
  return businessIdentity && buyerContext >= 1;
}

function collectCandidateBlocks(html, minTextLength) {
  const blocks = [];
  const visibleHtml = stripVisibleNoise(html);
  const blockPatterns = [
    /<tr\b[\s\S]*?<\/tr>/gi,
    /<(?:li|article|section)\b[\s\S]*?<\/(?:li|article|section)>/gi,
    /<div\b[^>]*(?:customer|inquiry|lead|card|item)[^>]*>[\s\S]*?<\/div>/gi,
  ];

  for (const pattern of blockPatterns) {
    let match;
    while ((match = pattern.exec(visibleHtml))) {
      const block = match[0];
      const text = normalizeSpace(decodeHtml(stripTags(block)));
      if (text.length >= minTextLength && looksLikeLeadText(text)) blocks.push(block);
    }
  }

  if (blocks.length === 0) {
    const text = normalizeSpace(decodeHtml(stripTags(visibleHtml)));
    const chunks = text.split(/(?=(?:客户|买家|Buyer|Customer|Company|国家|Country)\b)/i);
    for (const chunk of chunks) {
      if (chunk.length >= minTextLength && looksLikeLeadText(chunk)) blocks.push(chunk.slice(0, 2400));
    }
  }

  return blocks;
}

function parseLeadBlock(block, options) {
  const text = normalizeSpace(decodeHtml(stripTags(block)));
  const href = firstHref(block);
  const companyName = valueAfterLabels(text, ['公司名称', 'Company Name', 'Company']);
  const profileName = profileNameFromText(text);
  const contactName = valueAfterLabels(text, ['联系人', '客户名称', '客户名', 'Buyer', 'Contact Name']) || profileName;
  const country = valueAfterLabels(text, ['经营地址', '国家', 'Country', 'Region']);
  const memberLevel = valueAfterLabels(text, ['客户等级', '买家等级', '客户阶段', 'Level']);
  const interestCategory = valueAfterLabels(text, ['采购品类', '感兴趣商品类目', '感兴趣类目', '兴趣类目', 'Interested Category', 'Category']);
  const purchaseIntent = valueAfterLabels(text, ['采购意向', '采购情况', '采购需求', '询盘内容', 'Purchase', 'Requirement', 'Inquiry']);
  const sourceText = valueAfterLabels(text, ['客户来源', 'Source']);
  const businessType = valueAfterLabels(text, ['商业类型', 'Business Type']);
  const registeredAt = valueAfterLabels(text, ['注册时间', 'Register Time']);
  const createdAt = valueAfterLabels(text, ['建档时间', 'Created Time']);
  const followUp = compactNotes([
    sourceText && `source=${sourceText}`,
    businessType && `business_type=${businessType}`,
    registeredAt && `registered_at=${registeredAt}`,
    createdAt && `created_at=${createdAt}`,
    valueAfterLabels(text, ['历史小记', '跟进小记']) && `notes=${valueAfterLabels(text, ['历史小记', '跟进小记'])}`,
  ]);
  return {
    crm_customer_id: findFirst(text, ID_PATTERNS),
    company_name: companyName || findFirst(text, COMPANY_PATTERNS),
    contact_name: contactName || findFirst(text, CONTACT_PATTERNS),
    email: findFirst(text, EMAIL_PATTERNS),
    country: country || findFirst(text, COUNTRY_PATTERNS),
    member_level: memberLevel || findFirst(text, LEVEL_PATTERNS),
    interest_category: interestCategory || findFirst(text, INTEREST_PATTERNS),
    recent_login: findFirst(text, LOGIN_PATTERNS),
    purchase_intent: purchaseIntent || findFirst(text, PURCHASE_PATTERNS),
    last_follow_up: followUp || findFirst(text, FOLLOWUP_PATTERNS),
    detail_url: absolutizeUrl(href, options.sourceUrl),
    raw_text: text,
  };
}

function extractDetailData(text, snapshots, sourceUrl = '') {
  const allText = normalizeSpace(text);
  const initialText = snapshotText(snapshots, 'initial') || allText;
  const siteText = snapshotText(snapshots, '站内行为') || allText;
  const footprintText = snapshotText(snapshots, '店内足迹') || allText;
  const notesText = snapshotText(snapshots, '跟进小记') || allText;
  const transferText = snapshotText(snapshots, '流转记录') || allText;
  return {
    basic_info: {
      operating_address: valueAfterLabels(initialText, ['经营地址', '国家', 'Country', 'Region']) || null,
      created_at: valueAfterLabels(initialText, ['建档时间', 'Created Time']) || null,
      registered_at: valueAfterLabels(initialText, ['注册时间', 'Register Time']) || null,
      business_type: valueAfterLabels(initialText, ['商业类型', 'Business Type']) || null,
      customer_source: valueAfterLabels(initialText, ['客户来源', 'Source']) || null,
    },
    site_behavior: {
      last_90_days_behavior: sectionSnippet(siteText, ['最近90天内的行为', '近90天行为', '最近90天行为', '近90天站内行为', '近90天站内行为（数据为T+2）'], ['最近搜索', '最常采购行业', '最近询盘商品', '最近询盘产品', '店内足迹', '业务记录', '跟进小记', '流转记录']) || null,
      recent_searches: valueAfterLabels(siteText, ['最近的搜索', '最近搜索', 'Recent Searches']) || null,
      most_purchased_industry: valueAfterLabels(siteText, ['最常采购的行业', '最常采购行业', '常采购行业', 'Most Purchased Industry']) || null,
      recent_inquiry_products: valueAfterLabels(siteText, ['最近询盘商品', '最近询盘产品', 'Recent Inquiry Products']) || null,
      recent_inquiry_product_images: imageItemsForSnapshot(snapshots, '站内行为', 'alibaba_site_behavior', sourceUrl),
    },
    store_footprint: {
      recent_visited_products: sectionSnippet(footprintText, ['最近访问的商品', '最近访问商品', 'Recent Visited Products'], ['近90天站内行为', '近90天站内行为（数据为T+2）', '站内行为', 'AI背调']) || null,
      last_store_visit_time: valueAfterLabels(footprintText, ['最近访问店铺的时间', '访问店铺时间', '最近访问店铺', 'Last Store Visit']) || null,
      product_images: imageItemsForSnapshot(snapshots, '店内足迹', 'alibaba_store_footprint', sourceUrl),
    },
    business_records: {
      follow_notes: followNoteItems(notesText).join(' || ') || null,
      flow_records: flowRecordItems(transferText).join(' || ') || null,
    },
    buyer_homepage: buyerHomepageFromSnapshots(snapshots, allText, sourceUrl),
    contact_card: contactCardFromSnapshots(snapshots, allText),
  };
}

async function captureContactCardSnapshot(ui, currentHtml, pauseAfterMs) {
  let html = currentHtml || '';
  let hasModal = /所有联系人|contactModal/i.test(html);
  let clickResult = null;

  if (!hasModal) {
    clickResult = await ui.click({ selector: 'button[class*="viewMoreInfo"]', pauseAfterMs, humanize: false }).catch(() => null);
    if (!clickResult?.ok) {
      clickResult = await ui.click({ targetText: '展开更多信息', pauseAfterMs }).catch(() => null);
    }
    if (clickResult?.ok) {
      await sleep(pauseAfterMs);
      const refreshed = await ui.html({ timeoutMs: 30000, humanize: false }).catch(() => null);
      html = refreshed?.html || html;
      hasModal = /所有联系人|contactModal/i.test(html);
    }
  }

  if (!hasModal && !/身份|邮箱验证|申请名片授权/i.test(html)) return null;

  const snapshot = {
    label: '联系人信息',
    html,
    text: textFromHtml(html),
    opened_by: clickResult?.ok ? 'view_more_info' : hasModal ? 'modal_already_open' : 'initial_card',
  };

  if (hasModal) {
    await ui.click({ selector: 'div.ant-modal-footer button.ant-btn-primary, div.ant-modal-footer button', pauseAfterMs: 300, humanize: false }).catch(() => null);
    await ui.click({ targetText: '知道了', pauseAfterMs: 300 }).catch(() => null);
  }
  return snapshot;
}

function contactCardFromSnapshots(snapshots, fallbackText) {
  const contactSnapshots = (snapshots || []).filter((snapshot) => snapshot.label === '联系人信息');
  const html = (contactSnapshots.length ? contactSnapshots : snapshots || []).map((snapshot) => snapshot.html || '').join('\n');
  const fieldHtml = contactModalHtml(html) || html;
  const hasFieldHtml = Boolean(fieldHtml);
  const text = normalizeSpace(`${contactSnapshots.map((snapshot) => snapshot.text || '').join(' | ')} | ${fallbackText || ''}`);
  const identity = buyerIdentityFromHtml(fieldHtml, text);
  const email = contactFieldValue(fieldHtml, '邮箱') || cleanEmail(valueAfterLabels(text, ['邮箱', 'Email']));
  const emailVerifiedText = contactFieldValue(fieldHtml, '邮箱验证') || valueAfterLabels(text, ['邮箱验证']);
  const mobile = contactFieldValue(fieldHtml, '手机') || valueAfterLabels(text, ['手机', 'Mobile']);
  const landline = contactFieldValue(fieldHtml, '座机') || valueAfterLabels(text, ['座机', 'Phone']);
  const socialAccount = contactFieldValue(fieldHtml, '社交账号') || valueAfterLabels(text, ['社交账号', 'Social Account']);
  const jobTitle = contactFieldValue(fieldHtml, '职位') || valueAfterLabels(text, ['职位', 'Job Title']);
  const gender = contactFieldValue(fieldHtml, '性别') || valueAfterLabels(text, ['性别', 'Gender']);
  const note = contactFieldValue(fieldHtml, '备注') || (hasFieldHtml ? null : valueAfterLabels(text, ['备注', 'Note']));
  const authorizationStatus = businessCardAuthorizationStatus(`${html}\n${text}`, { email, mobile, landline, socialAccount });

  return {
    buyer_identity_level: identity.level || null,
    identity_level: identity.level || null,
    identity_source: identity.source || null,
    identity_badge_url: identity.badge_url || null,
    email: normalizeContactValue(email),
    email_verified: booleanFromYesNo(emailVerifiedText),
    email_verified_text: normalizeContactValue(emailVerifiedText),
    mobile: normalizeContactValue(mobile),
    landline: normalizeContactValue(landline),
    social_account: normalizeContactValue(socialAccount),
    whatsapp: whatsappFromSocialAccount(socialAccount),
    job_title: normalizeContactValue(jobTitle),
    gender: normalizeContactValue(gender),
    note: normalizeContactValue(note),
    business_card_authorization_status: authorizationStatus,
    business_card_authorization_requested: authorizationStatus === 'pending_buyer_authorization',
    expanded_contact_info_collected: contactSnapshots.length > 0,
  };
}

function contactModalHtml(html) {
  const source = String(html || '');
  const marker = source.lastIndexOf('所有联系人');
  if (marker < 0) return '';
  const modalRoot = source.lastIndexOf('ant-modal-root', marker);
  const divStart = modalRoot >= 0 ? source.lastIndexOf('<div', modalRoot) : -1;
  return source.slice(divStart >= 0 ? divStart : Math.max(0, marker - 6000));
}

function buyerIdentityFromHtml(html, text) {
  const explicit = /\bL[0-4]\b/i.exec(contactFieldValue(html, '身份') || text)?.[0];
  if (explicit) return { level: explicit.toUpperCase(), source: 'visible_text', badge_url: null };

  const segment = contactFieldSegment(html, '身份');
  const badgeUrl = /<img\b[^>]*src=["']([^"']+)["'][^>]*(?:alt=["']buyer-tag["'])?/i.exec(segment)?.[1]
    || /<img\b[^>]*(?:alt=["']buyer-tag["'])[^>]*src=["']([^"']+)["']/i.exec(segment)?.[1]
    || '';
  const level = buyerBadgeLevelFromUrl(badgeUrl);
  return {
    level,
    source: level ? 'badge_image_map' : badgeUrl ? 'unresolved_badge_image' : null,
    badge_url: badgeUrl || null,
  };
}

function buyerBadgeLevelFromUrl(url) {
  if (!url) return null;
  if (/O1CN01Y2kXyK27mJc8CmtgL/i.test(url)) return 'L4';
  if (/O1CN016s9YtC1jJsEn1Insi/i.test(url)) return 'L3';
  if (/O1CN01NQDNGN1GXxg1QhmCW/i.test(url)) return 'L2';
  if (/O1CN01QPXkVq1xUmP6u0guh/i.test(url)) return 'L1';
  return null;
}

function contactFieldValue(html, label) {
  return normalizeContactValue(textFromHtml(contactFieldValueHtml(html, label)));
}

function contactFieldValueHtml(html, label) {
  const segment = contactFieldSegment(html, label);
  if (!segment) return '';
  const valueMarker = /<div\b[^>]*class=["'][^"']*value--[^"']*["'][^>]*>/i.exec(segment);
  return valueMarker ? segment.slice(valueMarker.index + valueMarker[0].length) : '';
}

function contactFieldSegment(html, label) {
  const source = String(html || '');
  const labelRe = new RegExp(`<div\\b[^>]*class=["'][^"']*label--[^"']*["'][^>]*>\\s*${escapeRe(label)}\\s*<\\/div>`, 'i');
  const match = labelRe.exec(source);
  if (!match) return '';
  const start = match.index;
  const nextRow = source.indexOf('<div class="row--', start + match[0].length);
  const stops = [
    nextRow,
    source.indexOf('<div class="introduceContainer', start + match[0].length),
    source.indexOf('<div class="viewMoreInfoContainer', start + match[0].length),
    source.indexOf('<div class="ant-modal-footer"', start + match[0].length),
    source.indexOf('<div class="contactModalFooter', start + match[0].length),
  ].filter((index) => index > start && index - start < 1600);
  const end = stops.length > 0 ? Math.min(...stops) : Math.min(source.length, start + 900);
  return source.slice(start, end);
}

function normalizeContactValue(value) {
  const cleaned = cleanValue(value);
  if (!cleaned || /^[-－—]+$/.test(cleaned)) return null;
  const parts = cleaned.split('|')
    .map((part) => cleanValue(part))
    .filter((part) => part && !/^[-－—]+$/.test(part))
    .filter((part) => !looksLikeLabel(part) && !isNoiseValue(part))
    .filter((part) => !/展开更多信息|申请名片授权|知道了|<path\b|<svg\b|<div\b|class=["']/i.test(part));
  if (parts.length === 0) return null;
  return parts.join(' | ');
}

function cleanContactCardForLead(card, context) {
  const cleaned = { ...emptyContactCard(), ...(card || {}) };
  for (const key of ['mobile', 'landline', 'social_account', 'whatsapp', 'job_title', 'gender', 'note']) {
    cleaned[key] = normalizeContactValue(cleaned[key]);
  }
  if (cleaned.note && [context.companyName, context.contactName].filter(Boolean).some((value) => sameLooseValue(cleaned.note, value))) {
    cleaned.note = null;
  }
  if (cleaned.mobile && !/[\d+() -]{5,}/.test(cleaned.mobile)) cleaned.mobile = null;
  return cleaned;
}

function sameLooseValue(left, right) {
  return cleanValue(left).toLowerCase() === cleanValue(right).toLowerCase();
}

function booleanFromYesNo(value) {
  const cleaned = cleanValue(value);
  if (!cleaned) return null;
  if (/^(是|已验证|verified|yes|true)$/i.test(cleaned)) return true;
  if (/^(否|未验证|no|false)$/i.test(cleaned)) return false;
  return null;
}

function whatsappFromSocialAccount(value) {
  const cleaned = normalizeContactValue(value);
  if (!cleaned || !/whats\s*app|wa\b/i.test(cleaned)) return null;
  return cleaned;
}

function businessCardAuthorizationStatus(source, visibleContacts) {
  const text = normalizeSpace(source || '');
  if (/已发送名片申请|待买家授权/i.test(text)) return 'pending_buyer_authorization';
  if (/申请名片授权/i.test(text)) return 'available_to_request';
  if (visibleContacts.email || visibleContacts.mobile || visibleContacts.landline || visibleContacts.socialAccount) return 'contact_visible';
  return 'not_found';
}

function buyerHomepageFromSnapshots(snapshots, text, sourceUrl) {
  const html = (snapshots || []).map((snapshot) => snapshot.html || '').join('\n');
  const labelSeen = normalizeSpace(text).includes('Ta的Alibaba买家主页');
  const href = /<a\b[^>]*href=["']([^"']+)["'][^>]*>\s*Ta的Alibaba买家主页\s*<\/a>/i.exec(html)?.[1]
    || /href=["']([^"']+)["'][^>]{0,300}>\s*Ta的Alibaba买家主页/i.exec(html)?.[1]
    || '';
  const url = absolutizeUrl(href, sourceUrl);
  return {
    label_seen: labelSeen,
    status: url ? 'link_present' : labelSeen ? 'link_present_or_button_visible' : 'not_found',
    url: url || null,
  };
}

function snapshotText(snapshots, label) {
  return normalizeSpace((snapshots || []).find((snapshot) => snapshot.label === label)?.text || '');
}

const DETAIL_TAB_TARGETS = [
  { label: '站内行为', selector: '[data-node-key="behavior"] .ant-tabs-tab-btn, #rc-tabs-0-tab-behavior' },
  { label: '店内足迹', selector: '[data-node-key="footprint"] .ant-tabs-tab-btn, #rc-tabs-0-tab-footprint' },
  { label: '跟进小记', selector: '[data-node-key="notes"] .ant-tabs-tab-btn, #rc-tabs-0-tab-notes' },
  { label: '流转记录', selector: '[data-node-key="transfer"] .ant-tabs-tab-btn, #rc-tabs-0-tab-transfer' },
];

async function clickDetailTab(ui, tab, pauseAfterMs) {
  const bySelector = await ui.click({ selector: tab.selector, pauseAfterMs, humanize: false }).catch(() => null);
  if (bySelector?.ok) return bySelector;
  return ui.click({ targetText: tab.label, pauseAfterMs }).catch(() => null);
}

function followNoteItems(text) {
  const parts = sectionParts(text, ['历史小记'], ['暂无流转记录', '是否粉丝', '最近访问店铺', '最近访问商品', '近90天站内行为', '近90天站内行为（数据为T+2）']);
  const items = [];
  for (let i = 0; i < parts.length; i += 1) {
    if (!looksLikeDateTime(parts[i])) continue;
    const statusIndex = findLastIndex(parts, Math.max(0, i - 4), i, /(TM沟通|跟单中|洽谈中|未成交|售后|公海召回)/);
    if (statusIndex < 0) continue;
    const item = parts.slice(statusIndex, i + 1).filter((part) => part !== '-' && !isNoiseValue(part)).join(' | ');
    if (item && !items.includes(item)) items.push(item);
  }
  return items.slice(0, 12);
}

function flowRecordItems(text) {
  if (normalizeSpace(text).includes('暂无流转记录')) return [];
  const parts = sectionParts(text, ['客户流转：'], ['是否粉丝', '最近访问店铺', '最近访问商品', '近90天站内行为', '近90天站内行为（数据为T+2）']);
  const items = [];
  let recordStart = 0;
  for (let i = 0; i < parts.length; i += 1) {
    if (!looksLikeDateTime(parts[i])) continue;
    const item = parts.slice(recordStart, i + 1)
      .filter((part) => part !== '-' && part !== '客户流转：' && !looksLikeLabel(part) && !isNoiseValue(part))
      .join(' | ');
    if (item && !items.includes(item)) items.push(item);
    recordStart = i + 1;
  }
  return items.slice(0, 12);
}

function sectionParts(text, startLabels, stopLabels) {
  const parts = normalizeSpace(text).split('|').map((part) => cleanValue(part)).filter(Boolean);
  const start = parts.findIndex((part) => startLabels.some((label) => sameLabel(part, label)));
  if (start < 0) return [];
  const section = [];
  for (let i = start + 1; i < parts.length; i += 1) {
    if (stopLabels.some((label) => sameLabel(parts[i], label))) break;
    const part = cleanValue(parts[i]);
    if (!part || part === '-' || isNoiseValue(part)) continue;
    section.push(part);
  }
  return section;
}

function looksLikeDateTime(value) {
  return /^\d{4}-\d{2}-\d{2}(?:\s+\d{2}:\d{2}:\d{2})?$/.test(cleanValue(value));
}

function findLastIndex(parts, start, end, pattern) {
  for (let i = end - 1; i >= start; i -= 1) {
    if (pattern.test(parts[i])) return i;
  }
  return -1;
}

function emptyDetailData() {
  return {
    basic_info: null,
    site_behavior: null,
    store_footprint: null,
    business_records: null,
    buyer_homepage: null,
    contact_card: emptyContactCard(),
  };
}

function emptyContactCard() {
  return {
    buyer_identity_level: null,
    identity_level: null,
    identity_source: null,
    identity_badge_url: null,
    email: null,
    email_verified: null,
    email_verified_text: null,
    mobile: null,
    landline: null,
    social_account: null,
    whatsapp: null,
    job_title: null,
    gender: null,
    note: null,
    business_card_authorization_status: null,
    business_card_authorization_requested: false,
    expanded_contact_info_collected: false,
  };
}

function imageItemsForSnapshot(snapshots, label, sourceArea, sourceUrl) {
  const snapshot = snapshots.find((item) => item.label === label);
  if (!snapshot?.html) return [];
  return collectImageItems(snapshot.html, { sourceArea, sourceUrl }).slice(0, 20);
}

function collectImageItems(html, context) {
  const items = [];
  const seen = new Set();
  const imgRe = /<img\b([^>]*)>/gi;
  let match;
  while ((match = imgRe.exec(html))) {
    const attrs = match[1] || '';
    const url = decodeHtml(firstAttr(attrs, 'src') || firstAttr(attrs, 'data-src') || '');
    if (!/^https?:\/\//i.test(url)) continue;
    if (!isLikelyAlibabaProductImage(url)) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    items.push({
      url,
      source_area: context.sourceArea,
      label: imageLabel(attrs, url, context.sourceArea),
      source_url: context.sourceUrl || null,
      confidence: 'medium',
    });
  }
  return items;
}

function firstAttr(attrs, name) {
  const re = new RegExp(`\\b${escapeRe(name)}=["']([^"']+)["']`, 'i');
  return re.exec(attrs)?.[1] || '';
}

function imageLabel(attrs, url, sourceArea) {
  const alt = cleanValue(firstAttr(attrs, 'alt') || firstAttr(attrs, 'title') || firstAttr(attrs, 'aria-label'));
  if (alt) return alt;
  const file = decodeURIComponent(url.split('/').pop()?.split('?')[0] || '').replace(/_\\d+x\\d+\\.jpg$/i, '');
  if (file && !/^H?[a-f0-9]{12,}/i.test(file)) return file.slice(0, 120);
  return sourceArea === 'alibaba_site_behavior' ? 'recent inquiry product image' : 'store footprint product image';
}

function isLikelyAlibabaProductImage(url) {
  if (!/alicdn\.com|alibaba\.com/i.test(url)) return false;
  if (/blue-tag|avatar|icon|logo|default|ai-follow-up|TB1iFmeKNv1gK0jSZFFXXb0sXXa-80-80|TB1vdHdIpXXXXXYXXXXF5vTHFXX-60-59/i.test(url)) return false;
  if (/tps[-/]|tfs/i.test(url) && !/sc0\d\.alicdn\.com/i.test(url)) return false;
  return /sc0\d\.alicdn\.com/i.test(url) || url.includes('/kf/');
}

function sectionSnippet(text, startLabels, stopLabels) {
  const parts = normalizeSpace(text).split('|').map((part) => cleanValue(part)).filter(Boolean);
  const start = parts.findIndex((part) => startLabels.some((label) => sameLabel(part, label)));
  if (start < 0) return '';
  let end = parts.length;
  for (let i = start + 1; i < parts.length; i += 1) {
    if (stopLabels.some((label) => sameLabel(parts[i], label))) {
      end = i;
      break;
    }
  }
  return parts.slice(start + 1, end).filter((part) => part !== '-').join(' | ').slice(0, 1200);
}

function leadHintsFromUrl(sourceUrl) {
  try {
    const parsed = new URL(sourceUrl || '');
    const customerId = parsed.searchParams.get('customerId') || '';
    const companyName = parsed.searchParams.get('companyName') || '';
    const isDetail = /\/crmpage\/customer_detail/i.test(parsed.pathname);
    return {
      crm_customer_id: customerId,
      company_name: companyName,
      contact_name: companyName,
      detail_url: isDetail ? parsed.toString() : '',
    };
  } catch (_) {
    return { crm_customer_id: '', company_name: '', contact_name: '', detail_url: '' };
  }
}

function valueAfterLabels(text, labels) {
  const parts = normalizeSpace(text).split('|').map((part) => cleanValue(part)).filter(Boolean);
  for (const label of labels) {
    const index = parts.findIndex((part) => sameLabel(part, label));
    if (index < 0) continue;
    for (let i = index + 1; i < Math.min(parts.length, index + 5); i += 1) {
      const candidate = cleanValue(parts[i]);
      if (!candidate || candidate === '-') continue;
      if (looksLikeLabel(candidate)) return '';
      if (isNoiseValue(candidate)) continue;
      return candidate;
    }
  }
  return '';
}

function sameLabel(value, label) {
  return cleanValue(value).toLowerCase() === cleanValue(label).toLowerCase();
}

function looksLikeLabel(value) {
  return /^(身份|邮箱|邮箱验证|手机|座机|社交账号|职位|性别|管理信息|公司信息|公司名称|官方网站|传真|经营地址|客户来源|商业类型|年采购额|注册时间|建档时间|备注|采购意向|采购品类|客户阶段|所属客群|最近访问商品|近90天站内行为|近90天站内行为（数据为T\+2）|Email|Phone|Mobile|Landline|Social Account|Job Title|Gender|Company|Country|Source)$/i.test(cleanValue(value));
}

function isNoiseValue(value) {
  return /^(Invalid date|开启体验|该能力由第三方 OKKI CRM 提供|专属客服|行业领袖专属客服|常见问题|客户通|My Alibaba|近90天站内行为|近90天站内行为（数据为T\+2）|最近访问商品)$/i.test(cleanValue(value));
}

function profileNameFromText(text) {
  const parts = normalizeSpace(text).split('|').map((part) => cleanValue(part)).filter(Boolean);
  const detailIndex = parts.findIndex((part) => part === '客户详情');
  if (detailIndex >= 0) {
    for (let i = detailIndex + 1; i < Math.min(parts.length, detailIndex + 8); i += 1) {
      const candidate = parts[i];
      if (candidate && candidate !== '搜索' && !looksLikeLabel(candidate)) return candidate;
    }
  }
  const ownerIndex = parts.findIndex((part) => /^业务员[:：]/.test(part));
  if (ownerIndex > 0) {
    for (let i = ownerIndex - 1; i >= Math.max(0, ownerIndex - 5); i -= 1) {
      const candidate = parts[i];
      if (candidate && !looksLikeLabel(candidate)) return candidate;
    }
  }
  return '';
}

function compactNotes(items) {
  return items.filter(Boolean).join('; ');
}

function looksLikeLeadText(text) {
  if (/(alicrm\.|components\.|i18n|webpack|function\s*\(|__NEXT_DATA__|window\.)/i.test(text)) return false;
  return /(客户|买家|公司|国家|采购|询盘|跟进|公海|Buyer|Customer|Company|Country|Inquiry|Purchase|RFQ|Login|Follow)/i.test(text);
}

const ID_PATTERNS = [
  /(?:客户ID|客户编号|Customer\s*ID|Buyer\s*ID|CRM\s*ID)[:：\s#-]*([A-Za-z0-9_-]{4,})/i,
  /\b(?:customerId|buyerId|crmCustomerId)["']?\s*[:=]\s*["']?([A-Za-z0-9_-]{4,})/i,
];

const COMPANY_PATTERNS = [
  /(?:公司名称|公司名|Company(?:\s*Name)?)[:：\s-]*([^|,，;；]{2,80})/i,
  /(?:companyName|company_name)["']?\s*[:=]\s*["']([^"']{2,80})/i,
];

const CONTACT_PATTERNS = [
  /(?:联系人|客户名称|客户名|买家|Buyer|Contact(?:\s*Name)?)[:：\s-]*([^|,，;；]{2,60})/i,
  /(?:buyerName|contactName|contact_name)["']?\s*[:=]\s*["']([^"']{2,60})/i,
];

const COUNTRY_PATTERNS = [
  /(?:国家|Country|Region)[:：\s-]*([^|,，;；]{2,60})/i,
  /(?:countryName|country_name|country)["']?\s*[:=]\s*["']([^"']{2,60})/i,
];

const LEVEL_PATTERNS = [
  /(?:客户等级|买家等级|等级|Level)[:：\s-]*(L\d+|A\d+|B\d+|C\d+|[^|,，;；]{1,30})/i,
  /(?:memberLevel|customerLevel)["']?\s*[:=]\s*["']([^"']{1,30})/i,
];

const INTEREST_PATTERNS = [
  /(?:感兴趣商品类目|感兴趣类目|兴趣类目|Interested\s*Category|Category)[:：\s-]*([^|;；]{2,120})/i,
  /(?:interestCategory|productCategory|category)["']?\s*[:=]\s*["']([^"']{2,120})/i,
];

const LOGIN_PATTERNS = [
  /(?:最近登录|最近活跃|Last\s*Login|Recent\s*Login)[:：\s-]*([^|,，;；]{2,60})/i,
];

const PURCHASE_PATTERNS = [
  /(?:采购情况|采购需求|询盘内容|Purchase|Requirement|Inquiry)[:：\s-]*([^|;；]{2,160})/i,
];

const FOLLOWUP_PATTERNS = [
  /(?:历史跟进|最近跟进|Last\s*Follow(?:-|\s*)up|Follow(?:-|\s*)up)[:：\s-]*([^|;；]{2,160})/i,
];

const EMAIL_PATTERNS = [
  /\b([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})\b/i,
];

function findFirst(text, patterns) {
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match?.[1]) return cleanValue(match[1]);
  }
  return '';
}

function firstHref(html) {
  const match = /\bhref=["']([^"']+)["']/i.exec(html);
  return match?.[1] || '';
}

function firstUrl(text) {
  const match = /\bhttps?:\/\/[^\s"'<>]+/i.exec(text);
  return match?.[0] || '';
}

function absolutizeUrl(value, baseUrl) {
  if (!value) return '';
  const clean = decodeHtml(String(value).trim());
  if (/^https?:\/\//i.test(clean)) return clean;
  if (!baseUrl) return clean;
  try {
    return new URL(clean, baseUrl).toString();
  } catch (_) {
    return clean;
  }
}

function jsonValue(raw, keys) {
  for (const key of keys) {
    const pattern = new RegExp(`["']?${escapeRe(key)}["']?\\s*[:=]\\s*["']([^"']+)["']`, 'i');
    const match = pattern.exec(raw);
    if (match?.[1]) return decodeJsonish(match[1]);
  }
  return '';
}

function decodeJsonish(value) {
  return decodeHtml(String(value).replace(/\\u([0-9a-f]{4})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16))).replace(/\\"/g, '"'));
}

function stripScriptsNoise(html) {
  return String(html)
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, ' ');
}

function stripVisibleNoise(html) {
  return String(html)
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, ' ');
}

function stripTags(html) {
  return String(html)
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/(?:td|th|div|span|p|li|tr)>/gi, ' | ')
    .replace(/<[^>]+>/g, ' ');
}

function textFromHtml(html) {
  return normalizeSpace(decodeHtml(stripTags(html)));
}

function isCustomerDetailPage(url, text) {
  return /\/crmpage\/customer_detail/i.test(String(url || '')) || normalizeSpace(text).includes('客户详情');
}

function normalizeSpace(value) {
  return String(value || '').replace(/\s+/g, ' ').replace(/\s*\|\s*/g, ' | ').trim();
}

function cleanValue(value) {
  return normalizeSpace(value)
    .replace(/^(?:-|:|：)+/, '')
    .replace(/\s+(?:客户ID|Customer\s*ID|Buyer\s*ID|CRM\s*ID)[:：\s#-]*.*$/i, '')
    .trim();
}

function cleanId(value) {
  const clean = cleanValue(value);
  return /^[A-Za-z0-9_-]{4,}$/.test(clean) ? clean : '';
}

function cleanEmail(value) {
  if (String(value || '').includes('*') && String(value || '').includes('@')) return cleanValue(value);
  const match = EMAIL_PATTERNS[0].exec(String(value || ''));
  return match?.[1]?.toLowerCase() || '';
}

function decodeHtml(value) {
  return String(value || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

function escapeRe(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function positiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms || 0)));
}
