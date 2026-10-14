// ==UserScript==
// @name         KA Visual Solver
// @namespace    local.ka-visual-solver
// @version      4.7.1
// @description  Khan Academy solver using local OpenCode + Big Pickle; dropdown changes do not reset solutions.
// @match        https://www.khanacademy.org/*
// @match        https://classroom.khanacademy.org/*
// @grant        GM.xmlHttpRequest
// @connect      127.0.0.1
// @connect      localhost
// @connect      ::1
// @connect      *
// @run-at       document-idle
// ==/UserScript==

(() => {
  'use strict';
  if (window.__KA_VISUAL_SOLVER_INSTALLED__) return;
  window.__KA_VISUAL_SOLVER_INSTALLED__ = true;

  const DEFAULT_SERVER = 'http://127.0.0.1:4096';
  const MODEL = { providerID: 'opencode', modelID: 'big-pickle' };
  const TIMEOUT = 45000;
  const IMAGE_TIMEOUT = 12000;
  const MAX_IMAGES = 3;
  const MAX_IMAGE_BYTES = 1800000;
  const MAX_PROMPT_CHARS = 10500;

  const state = {
    serverUrl: DEFAULT_SERVER, auto: false, consented: false,
    fingerprint: '', question: null, requestId: 0, loading: false,
    minimized: false, lastError: '',
  };
  let host, shadow, uiRoot;
  const $ = (selector, root = uiRoot) => root ? root.querySelector(selector) : null;
  const $$ = (selector, root = uiRoot) => root ? [...root.querySelectorAll(selector)] : [];

  const CONTROL_SELECTOR = [
    'input:not([type="hidden"]):not([type="radio"]):not([type="checkbox"]):not([type="button"]):not([type="submit"]):not([type="reset"])',
    'select', 'textarea', '[contenteditable="true"]', '[role="textbox"]', '[role="combobox"]',
    '.mq-editable-field', '.mathquill', '.perseus-widget-input-number',
    '.perseus-widget-input-expression', '.perseus-widget-dropdown'
  ].join(',');

  const norm = value => String(value ?? '').replace(/\u00a0/g, ' ').replace(/[\t\r ]+/g, ' ').replace(/\n\s*/g, '\n').trim();
  const textOf = el => el ? norm(el.innerText || el.textContent || '') : '';
  const uniq = values => {
    const seen = new Set(), out = [];
    for (const value of values) {
      const s = norm(value), key = s.toLowerCase();
      if (!s || seen.has(key)) continue;
      seen.add(key); out.push(s);
    }
    return out;
  };
  function visible(el) {
    if (!el || !el.isConnected) return false;
    const style = getComputedStyle(el), rect = el.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) !== 0 && rect.width > 0 && rect.height > 0;
  }
  function escapeHTML(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
  }
  function staticText(el) {
    if (!el) return '';
    const clone = el.cloneNode(true);
    const mask = [
      'input', 'select', 'textarea', '[contenteditable="true"]', '[role="textbox"]', '[role="combobox"]',
      '[role="listbox"]', '[aria-haspopup="listbox"]', '[data-testid*="dropdown" i]', '[class*="dropdown" i]',
      '.mq-editable-field', '.mathquill', '.perseus-widget-input-number', '.perseus-widget-input-expression',
      '.perseus-widget-dropdown', '[draggable="true"]', '[data-rbd-draggable-id]',
      '[data-droppable-id]', '[data-drop-zone]', '[data-testid*="drop-target"]', '[data-testid*="dropzone"]',
      '[data-testid*="drop-zone"]', '[class*="droppable"]', '[class*="drop-target"]', '[class*="dropzone"]'
    ].join(',');
    const nodes = [...clone.querySelectorAll(mask)];
    nodes.filter(n => !nodes.some(other => other !== n && other.contains(n)))
      .forEach(n => n.replaceWith(document.createTextNode(' [answer field] ')));
    return norm(clone.innerText || clone.textContent || '');
  }

  function getParagraphs(scope = document) {
    let nodes = [...scope.querySelectorAll('[data-perseus-paragraph-index]')].filter(visible);
    let strings = uniq(nodes.map(staticText).filter(t => t.length >= 2 && t.length < 2200));
    if (!strings.length) {
      nodes = [...scope.querySelectorAll('.paragraph')].filter(visible);
      strings = uniq(nodes.map(staticText).filter(t => t.length >= 2 && t.length < 2200));
    }
    return { nodes, strings };
  }

  function findQuestionRoot(paragraphNodes) {
    const first = paragraphNodes.find(visible);
    const explicit = first?.closest('.perseus-renderer, .perseus-question-container, [data-testid*="question"], [data-testid*="exercise"]');
    if (explicit && visible(explicit) && textOf(explicit).length < 20000) return explicit;
    if (!first) return document.querySelector('.perseus-renderer, .perseus-question-container, [data-testid*="question"], [data-testid*="exercise"]') || document.querySelector('[role="main"]') || document.querySelector('main') || document.body;
    let best = first.parentElement || first;
    for (let el = first, depth = 0; el && depth < 14; el = el.parentElement, depth++) {
      best = el;
      const hasParagraph = !!el.querySelector('[data-perseus-paragraph-index], .paragraph');
      const hasAnswerUI = !!el.querySelector(`${CONTROL_SELECTOR}, input[type="radio"], input[type="checkbox"], [role="radio"], [role="checkbox"], .perseus-widget-radio-option, .perseus-widget-checkbox-option, .perseus-widget-interactive-graph, .perseus-widget-matrix, .perseus-widget-orderer`);
      const length = textOf(el).length;
      if (hasParagraph && hasAnswerUI && length >= 4 && length < 16000) return el;
      if (el === document.body) break;
    }
    return first.closest('.perseus-renderer') || best;
  }

  function choiceLabel(el) {
    if (!el) return '';
    const explicit = norm(el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('data-label') || '');
    if (el.labels?.length) {
      const label = uniq([...el.labels].map(textOf)).join(' ');
      if (label) return label;
    }
    const id = el.id;
    if (id) {
      const label = el.ownerDocument.querySelector(`label[for="${CSS.escape(id)}"]`);
      if (label && textOf(label)) return textOf(label);
    }
    const t = textOf(el);
    if (t && t.length <= 500) return t;
    let parent = el.parentElement;
    for (let depth = 0; parent && depth < 3; depth++, parent = parent.parentElement) {
      const parentText = staticText(parent);
      const count = parent.querySelectorAll('input[type="radio"], input[type="checkbox"], [role="radio"], [role="checkbox"], .perseus-widget-radio-option, .perseus-widget-checkbox-option').length;
      if (parentText && parentText.length <= 500 && count <= 1) return parentText;
    }
    return explicit;
  }

  function collectChoices(root) {
    if (!root) return { labels: [], kind: '' };
    const radioSelectors = [
      '.perseus-widget-radio-option', '.perseus-radio-option', '[role="radio"]', 'input[type="radio"]', '[data-testid*="choice"]'
    ];
    const checkboxSelectors = [
      '.perseus-widget-checkbox-option', '[role="checkbox"]', 'input[type="checkbox"]'
    ];
    for (const [kind, selectors] of [['radio', radioSelectors], ['checkbox', checkboxSelectors]]) {
      let nodes = [];
      for (const sel of selectors) {
        nodes = [...root.querySelectorAll(sel)].filter(visible);
        if (nodes.length >= 2) break;
      }
      if (!nodes.length) continue;
      nodes = nodes.filter(el => !nodes.some(other => other !== el && other.contains(el)));
      const labels = uniq(nodes.map(choiceLabel).filter(s => s.length <= 550));
      if (labels.length >= 2) return { labels: labels.slice(0, 32), kind };
    }
    return { labels: [], kind: '' };
  }

  function labelForControl(el) {
    const explicit = norm(el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('data-label') || '');
    if (explicit) return explicit;
    const labelledBy = norm(el.getAttribute('aria-labelledby') || '');
    if (labelledBy) {
      const value = labelledBy.split(/\s+/).map(id => document.getElementById(id)).filter(Boolean).map(textOf).filter(Boolean).join(' ');
      if (value) return value;
    }
    for (let p = el.parentElement, depth = 0; p && depth < 5; p = p.parentElement, depth++) {
      if (p.querySelectorAll(CONTROL_SELECTOR).length > 1) continue;
      const s = staticText(p).replace(/\[answer field\]/gi, ' ').trim();
      if (s.length >= 2 && s.length <= 180) return s;
    }
    const sibling = el.previousElementSibling;
    if (sibling && textOf(sibling).length <= 160) return textOf(sibling);
    return '';
  }
  function fieldValue(el) {
    const tag = el.tagName?.toLowerCase();
    if (tag === 'input' || tag === 'textarea') return norm(el.value);
    if (tag === 'select') return norm(el.selectedOptions?.[0]?.textContent || el.value);
    const nested = el.querySelector?.('input:not([type="hidden"]), textarea, select, [contenteditable="true"]');
    if (nested) return fieldValue(nested);
    return norm(el.querySelector?.('.mq-root-block')?.innerText || '');
  }
  function collectInputs(root) {
    if (!root) return [];
    const raw = [...root.querySelectorAll(CONTROL_SELECTOR)].filter(el => visible(el) && !el.closest('#ka-visual-solver-host'));
    const filtered = raw.filter(el => !raw.some(other => other !== el && other.contains(el) && (
      other.matches('.mq-editable-field, .mathquill, .perseus-widget-input-number, .perseus-widget-input-expression, .perseus-widget-dropdown, [role="textbox"], [contenteditable="true"]')
    )));
    const deduped = [];
    for (const el of filtered) {
      const rect = el.getBoundingClientRect();
      if (deduped.some(other => {
        const r = other.getBoundingClientRect();
        return Math.abs(r.left - rect.left) < 1 && Math.abs(r.top - rect.top) < 1 && Math.abs(r.width - rect.width) < 2 && Math.abs(r.height - rect.height) < 2;
      })) continue;
      deduped.push(el);
    }
    return deduped.slice(0, 40).map((el, index) => {
      const tag = el.tagName.toLowerCase();
      const nested = el.querySelector?.('input:not([type="hidden"]), textarea, select');
      const actual = ['input', 'textarea', 'select'].includes(tag) ? el : nested;
      const select = tag === 'select' || !!el.querySelector?.('select');
      const math = el.matches('.mq-editable-field, .mathquill, .perseus-widget-input-expression') || !!el.querySelector?.('.mq-root-block');
      const inTable = !!el.closest('table, [role="table"], [role="grid"], .perseus-widget-table, .perseus-widget-matrix');
      return {
        index, label: labelForControl(el) || `Input ${index + 1}`,
        kind: select ? 'dropdown' : math ? 'math' : ((actual?.type || '').toLowerCase() === 'number' ? 'number' : 'text'),
        value: fieldValue(el), options: select ? [...(tag === 'select' ? el : el.querySelector('select')).options].map(o => norm(o.textContent)).filter(Boolean).slice(0, 30) : [],
        inTable, tag, placeholder: norm(el.getAttribute('placeholder') || actual?.getAttribute('placeholder') || ''),
      };
    });
  }

  function collectTables(root) {
    const selectors = 'table, [role="table"], .perseus-widget-table, .perseus-widget-matrix';
    const all = [...(root?.querySelectorAll(selectors) || [])].filter(visible);
    const outer = all.filter(el => !all.some(other => other !== el && other.contains(el)));
    const tables = [];
    for (const [index, el] of outer.slice(0, 8).entries()) {
      const rowNodes = [...el.querySelectorAll('tr, [role="row"]')].filter(visible).slice(0, 50);
      const rows = rowNodes.map(row => [...row.querySelectorAll('th, td, [role="columnheader"], [role="rowheader"], [role="gridcell"], [role="cell"]')]
        .filter(visible).map(cell => {
          const ctrl = !!cell.querySelector(CONTROL_SELECTOR);
          const own = !!cell.matches('[contenteditable="true"]');
          return { text: ctrl || own ? '' : textOf(cell), header: /^(TH)$/i.test(cell.tagName) || /^(columnheader|rowheader)$/.test(cell.getAttribute('role') || ''), editable: ctrl || own, tag: cell.tagName.toLowerCase(), role: cell.getAttribute('role') || '' };
        }).filter((_, i, a) => true)).filter(row => row.length);
      const cls = typeof el.className === 'string' ? el.className : '';
      const editableCount = rows.flat().filter(c => c.editable).length;
      if (rows.length) tables.push({ index, source: `${el.tagName.toLowerCase()} ${cls}`.slice(0, 180), rows, rowCount: rows.length, colCount: Math.max(...rows.map(r => r.length)), editableCount });
    }
    return tables;
  }

  function collectVisualHints(root) {
    const out = [];
    for (const img of [...(root?.querySelectorAll('img') || [])].filter(visible).slice(0, 18)) {
      out.push({ kind: 'image', alt: norm(img.alt), title: norm(img.title), nearby: norm(img.closest('figure')?.innerText || img.parentElement?.innerText || '').slice(0, 180), src: img.currentSrc || img.src || '', width: Math.round(img.getBoundingClientRect().width), height: Math.round(img.getBoundingClientRect().height) });
    }
    for (const svg of [...(root?.querySelectorAll('svg') || [])].filter(visible).slice(0, 12)) {
      const labels = uniq([...svg.querySelectorAll('text, title, desc')].map(textOf)).slice(0, 40);
      const label = norm(svg.getAttribute('aria-label') || svg.getAttribute('title') || '');
      if (labels.length || label) out.push({ kind: 'svg/diagram', label, labels });
    }
    for (const canvas of [...(root?.querySelectorAll('canvas') || [])].filter(visible).slice(0, 5)) {
      out.push({ kind: 'canvas', label: norm(canvas.getAttribute('aria-label') || canvas.title || ''), width: canvas.width, height: canvas.height });
    }
    return out;
  }

  function collectDragDrop(root) {
    if (!root) return { mode: 'unknown', items: [], targets: [] };
    const orderRoot = root.querySelector('.perseus-widget-orderer, [data-testid*="orderer"], [class*="sortable"]');
    const itemSel = '[draggable="true"], [aria-roledescription*="draggable" i], [data-rbd-draggable-id], [data-testid*="draggable"], [data-testid*="drag-item"], [data-testid*="sortable-item"], [class*="draggable-item"], [class*="drag-item"], [class*="sortable-item"]';
    let itemNodes = [...root.querySelectorAll(itemSel)].filter(visible);
    if (orderRoot && itemNodes.length < 2) itemNodes = [...orderRoot.querySelectorAll('button, [role="button"], li, [tabindex]')].filter(visible);
    itemNodes = itemNodes.filter(el => !itemNodes.some(other => other !== el && other.contains(el)));
    const items = uniq(itemNodes.map(el => textOf(el) || norm(el.getAttribute('aria-label') || el.title || '')).filter(s => s.length <= 180)).slice(0, 30).map((label, index) => ({ index, label }));
    const targetSel = '[aria-dropeffect], [data-droppable-id], [data-drop-zone], [data-testid*="drop-target"], [data-testid*="dropzone"], [data-testid*="drop-zone"], [class*="drop-target"], [class*="dropzone"], [class*="drop-zone"], [class*="droppable"]';
    let targetNodes = [...root.querySelectorAll(targetSel)].filter(visible);
    targetNodes = targetNodes.filter(el => !targetNodes.some(other => other !== el && other.contains(el)));
    const targets = targetNodes.slice(0, 24).map((el, index) => ({ index, label: textOf(el) || norm(el.getAttribute('aria-label') || el.title || '') || `Target ${index + 1}` }));
    return { mode: orderRoot ? 'order' : 'place', items, targets };
  }

  function extractQuestion() {
    const initial = getParagraphs(document);
    if (!initial.nodes.length || !initial.strings.length) return null;
    const root = findQuestionRoot(initial.nodes);
    const paragraphData = getParagraphs(root);
    const paragraphNodes = paragraphData.nodes.length ? paragraphData.nodes : initial.nodes;
    const paragraphs = uniq(paragraphNodes.map(staticText).filter(t => t.length >= 2 && t.length < 2200));
    const renderedText = staticText(root).slice(0, 6800) || paragraphs.join('\n\n');
    const choiceData = collectChoices(root);
    const inputs = collectInputs(root);
    const tables = collectTables(root);
    const visualHints = collectVisualHints(root);
    const dragDrop = collectDragDrop(root);
    const outsideInputs = inputs.filter(input => !input.inTable);

    // The exercise DOM, not the model's JSON, decides which visualization is allowed.
    const explicitGraph = !!root.querySelector('.perseus-widget-interactive-graph, .graphie, [data-testid*="interactive-graph"], [data-testid*="graph-input"]');
    const gridElement = root.querySelector('.perseus-widget-matrix, [role="grid"]');
    const explicitMatrix = !!gridElement;
    const gridCellNodes = gridElement ? [...gridElement.querySelectorAll('[role="gridcell"], [class*="cell"]')].filter(visible).filter(el => ![...el.querySelectorAll('[role="gridcell"], [class*="cell"]')].some(child => visible(child))) : [];
    const gridCells = root.querySelectorAll('[role="gridcell"]').length || gridCellNodes.length;
    let gridRows = 0, gridCols = 0;
    if (gridElement) {
      const roleRows = [...gridElement.querySelectorAll('[role="row"]')].filter(visible);
      if (roleRows.length) {
        gridRows = roleRows.length;
        gridCols = Math.max(0, ...roleRows.map(row => row.querySelectorAll('[role="gridcell"], [role="cell"], [role="columnheader"]').length));
      } else {
        const cellNodes = [...gridElement.querySelectorAll('[role="gridcell"]')].filter(visible);
        if (cellNodes.length) {
          const tops = [...new Set(cellNodes.map(cell => Math.round(cell.getBoundingClientRect().top / 3) * 3))];
          gridRows = tops.length;
          gridCols = Math.max(1, ...tops.map(top => cellNodes.filter(cell => Math.round(cell.getBoundingClientRect().top / 3) * 3 === top).length));
        } else if (gridCellNodes.length) {
          const tops = [...new Set(gridCellNodes.map(cell => Math.round(cell.getBoundingClientRect().top / 3) * 3))];
          gridRows = tops.length;
          gridCols = Math.max(1, ...tops.map(top => gridCellNodes.filter(cell => Math.round(cell.getBoundingClientRect().top / 3) * 3 === top).length));
        } else {
          const colsCss = getComputedStyle(gridElement).gridTemplateColumns;
          if (colsCss && colsCss !== 'none') gridCols = colsCss.split(/\s+/).filter(Boolean).length;
          if (gridCols) gridRows = Math.ceil(Math.max(1, gridCells) / gridCols);
        }
      }
    }
    const actualDrag = dragDrop.items.length >= 2 && (dragDrop.mode === 'order' || dragDrop.targets.length > 0 || !!root.querySelector('[draggable="true"], [data-rbd-draggable-id], [aria-roledescription*="draggable" i]'));
    const editableTable = tables.some(t => t.editableCount > 0) || !!root.querySelector('.perseus-widget-table');
    const checkboxes = choiceData.kind === 'checkbox';
    const choiceTask = choiceData.labels.length >= 2;

    let type = 'unknown';
    if (actualDrag) type = 'drag_drop';
    else if (choiceTask && outsideInputs.length) type = 'mixed';
    else if (choiceTask) type = checkboxes ? 'multi_select' : 'multiple_choice';
    else if (editableTable && inputs.some(x => x.inTable)) type = 'table';
    else if (explicitMatrix && gridCells >= 4 && !outsideInputs.length && !choiceTask) type = 'grid';
    else if (explicitGraph && !outsideInputs.length && !choiceTask) type = 'graph';
    else if (outsideInputs.length >= 2) type = 'multi_input';
    else if (outsideInputs.length === 1) type = outsideInputs[0].kind === 'math' ? 'math' : 'text';
    else if (checkboxes) type = 'multi_select';

    const tableSummaries = tables.map(t => ({
      index: t.index, source: t.source, rowCount: t.rowCount, colCount: t.colCount, editableCount: t.editableCount,
      rows: t.rows.map(row => row.map(c => c.text || (c.editable ? '[answer field]' : '[blank]'))),
    }));
    const snapshot = [renderedText, tableSummaries.length ? `TABLES:\n${tableSummaries.map(t => `Table ${t.index} (${t.rowCount}x${t.colCount}, ${t.editableCount} editable cells):\n${t.rows.map(r => r.join(' | ')).join('\n')}`).join('\n\n')}` : ''].filter(Boolean).join('\n\n').slice(0, 9000);

    const fingerprint = JSON.stringify({
      path: location.pathname,
      paragraphs,
      choices: choiceData.labels,
      type,
      inputStructure: inputs.map(x => ({ index: x.index, kind: x.kind, inTable: x.inTable })),
      tables: tables.map(t => ({ source: t.source, rows: t.rows.map(row => row.map(c => ({ text: c.editable ? '' : c.text, header: c.header, editable: c.editable, role: c.role }))) })),
      visuals: visualHints.map(x => ({ kind: x.kind, alt: x.alt, title: x.title, label: x.label, labels: x.labels, width: x.width, height: x.height })),
      drag: { mode: dragDrop.mode, items: dragDrop.items.map(x => x.label), targets: dragDrop.targets.map(x => x.label) },
      layoutEvidence: { explicitGraph, explicitMatrix, gridCells, gridRows, gridCols, editableTable },
    }).slice(0, 16000);

    return {
      root, paragraphs, renderedText, prompt: snapshot, type,
      choices: choiceData.labels, choiceKind: choiceData.kind, inputs, tables, visuals: visualHints,
      dragDrop, layout: { explicitGraph, explicitMatrix, gridCells, editableTable }, fingerprint,
    };
  }

  function independentInputs(q) { return (q?.inputs || []).filter(x => !x.inTable); }

  function solverPrompt(q) {
    const free = independentInputs(q);
    const payload = {
      questionText: q.paragraphs.join('\n\n').slice(0, 4500) || q.renderedText.slice(0, 4500),
      fullVisibleText: q.renderedText.slice(0, 5500),
      detectedTaskType: q.type,
      DOMPermittedAnswerLayouts: {
        choices: q.choices.length >= 2,
        independentInputs: free.length,
        editableTable: q.layout.editableTable && q.tables.some(t => t.editableCount > 0),
        interactiveGrid: q.type === 'grid' && q.layout.explicitMatrix,
        interactiveGraph: q.type === 'graph' && q.layout.explicitGraph,
        dragDrop: q.type === 'drag_drop',
      },
      answerChoicesInVisibleOrder: q.choices,
      answerInputsInScreenOrder: free.map(x => ({ index: x.index, label: x.label, kind: x.kind, options: x.options, placeholder: x.placeholder })),
      tables: q.tables.slice(0, 5).map(t => ({ index: t.index, rowCount: t.rowCount, colCount: t.colCount, editableCount: t.editableCount, rows: t.rows.slice(0, 24).map(row => row.slice(0, 16).map(c => ({ text: c.text, header: c.header, editable: c.editable }))) })),
      dragDrop: { mode: q.dragDrop.mode, items: q.dragDrop.items, targets: q.dragDrop.targets },
      visualHints: q.visuals.slice(0, 10).map(v => ({ kind: v.kind, alt: v.alt, title: v.title, nearby: v.nearby, width: v.width, height: v.height, label: v.label, labels: v.labels })),
    };
    const inputRule = free.length
      ? `There are ${free.length} independent answer field(s). Return inputAnswers with exactly ${free.length} entries, each {"index": originalIndex, "label":"short label", "answer":"only what belongs in this field"}. Dropdown answers must exactly match a visible option. Never put all work in one blank. Fields inside tables must be filled through table.fills, not inputAnswers.`
      : 'Do not create independent inputAnswers unless the snapshot actually contains independent fields.';
    const mixedRule = q.choices.length >= 2 && free.length
      ? 'THIS IS A MIXED EXERCISE: return the choice index AND answers for every independent blank. Do not omit either half.'
      : 'Answer every task the visible controls require, but do not invent additional task types.';
    return [
      'Solve the exact Khan Academy exercise from this snapshot. Return ONLY one compact valid JSON object; no markdown or prose outside it.',
      'HARD FORMAT CONSTRAINT: DOMPermittedAnswerLayouts is authoritative. Never invent a graph, grid, table, drag/drop task, or answer field that is not explicitly permitted by that object. In particular, if interactiveGraph=false, omit the graph property; if interactiveGrid=false, omit the grid property. A graph/table/grid shown as question context does not automatically mean the student must draw/fill one.',
      'For multiple choice, evaluate each entire option, including all clauses. Select the single option that best answers the whole question; use correctOptionIndex as the zero-based index into answerChoicesInVisibleOrder. Prefer the index over repeating option text. For checkboxes, return all correct indexes in correctOptionIndices.',
      mixedRule, inputRule,
      'Fill-in answers must be short and field-ready. Match grammar and use standard Khan Academy terminology, not a paraphrase. Include units only when the field requires them. Preserve signs, formulas, capitalization and listed dropdown wording.',
      'For calculations, keep unrounded intermediate values, obey requested precision, and use sensible significant figures if none are specified. For measured chemistry results, use precision supported by the measurements; e.g. 19.15 g should become 19.2 g if 3 significant figures are required.',
      'For drag/drop, use only the supplied draggable items and targets. Return each placement with exact item label and targetIndex, or final order with orderIndex. For actual editable tables, use zero-based row/col indexes including headers and fill only editable answer cells. For actual grids use zero-based selectedCells. For actual graphs give points/segments/function as appropriate.',
      'Use the visual attachments and the provided image alt/diagram labels when relevant. Do not claim details from an image that is not attached/readable. Recheck the answer independently before returning it.',
      'Schema: {"type":"multiple_choice|multi_select|mixed|multi_input|drag_drop|table|grid|graph|math|text|unknown","answer":"short answer","correctOptionIndex":0,"correctOptionIndices":[0,2],"inputAnswers":[{"index":0,"label":"field label","answer":"exact field content"}],"dragDrop":{"mode":"place|order","placements":[{"item":"exact item label","target":"exact target label","targetIndex":0,"orderIndex":0}],"order":["item"]},"table":{"tableIndex":0,"fills":[{"row":1,"col":1,"value":"answer"}]},"grid":{"selectedCells":[[1,2]],"values":[[""]]},"graph":{"xMin":-5,"xMax":5,"yMin":-5,"yMax":5,"equation":"y=...","function":{"kind":"line|quadratic","slope":1,"intercept":0,"a":1,"b":0,"c":0},"points":[{"x":1,"y":2}],"segments":[{"from":[0,0],"to":[2,2]}]},"math":"expression","explanation":"brief explanation","steps":["brief step"],"confidence":"high|medium|low"}',
      'All choice indexes, table coordinates and grid coordinates are zero-based. For choices, correctOptionIndex must refer to the exact supplied array. If no answer format matches the visible UI, return a concise answer and explain uncertainty rather than inventing a visualization.',
      'SNAPSHOT:', JSON.stringify(payload).slice(0, MAX_PROMPT_CHARS),
    ].join('\n');
  }

  function verificationPrompt(q, candidate) {
    return [
      'Independently verify and correct this proposed solution. Re-solve from the question snapshot rather than agreeing automatically. Re-read every complete choice and verify the zero-based index; recompute calculations; check every blank, table cell or drag placement. Keep all parts of mixed questions.',
      'STRICT UI RULE: never add a graph/grid/table/drag-drop answer unless DOMPermittedAnswerLayouts in the snapshot explicitly allows it. If the candidate contains a forbidden layout, remove it. Return only compact JSON following the supplied schema.',
      solverPrompt(q), 'CANDIDATE:', JSON.stringify(candidate).slice(0, 5000),
    ].join('\n\n');
  }

  function parseJSON(text) {
    const raw = String(text || '').replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    try { return JSON.parse(raw); } catch (_) {}
    const a = raw.indexOf('{'), b = raw.lastIndexOf('}');
    if (a >= 0 && b > a) { try { return JSON.parse(raw.slice(a, b + 1)); } catch (_) {} }
    return { type: 'text', answer: raw, explanation: '' };
  }
  function getSessionId(p) { return p?.id || p?.sessionID || p?.data?.id || p?.data?.sessionID || p?.session?.id || ''; }
  function getMessageText(p) {
    const parts = p?.parts || p?.data?.parts || p?.message?.parts || p?.data?.message?.parts || p?.info?.parts || [];
    if (Array.isArray(parts)) {
      const text = parts.filter(x => typeof x?.text === 'string' && x.text.trim() && (!x.type || x.type === 'text' || x.type === 'output_text')).map(x => x.text).join('\n').trim();
      if (text) return text;
    }
    for (const v of [p?.text, p?.data?.text, p?.content, p?.data?.content, p?.info?.text, p?.message?.text]) if (typeof v === 'string' && v.trim()) return v.trim();
    return '';
  }
  function parseResponse(response, task) {
    if (response.status < 200 || response.status >= 300) {
      let detail = `OpenCode ${task} failed with HTTP ${response.status}.`;
      try { const p = JSON.parse(response.responseText || '{}'); const e = p.error || p.message || p; detail += ` ${typeof e === 'string' ? e : e.message || JSON.stringify(e).slice(0, 500)}`; } catch (_) {}
      if (response.status === 401 || response.status === 403) detail += ' Check OpenCode authentication.';
      if (response.status === 404) detail += ' Check the local server URL/API version.';
      throw new Error(detail);
    }
    let payload;
    try { payload = JSON.parse(response.responseText || '{}'); } catch (_) { throw new Error('OpenCode returned invalid JSON.'); }
    const content = getMessageText(payload);
    if (!content) {
      const error = payload?.info?.error || payload?.error || payload?.data?.error;
      throw new Error(error?.message || (typeof error === 'string' ? error : 'OpenCode returned no text. Check the OpenCode terminal for provider errors.'));
    }
    const data = parseJSON(content);
    if (!data || typeof data !== 'object') throw new Error('Big Pickle returned an empty solution.');
    return data;
  }

  function idxFor(data, choices) {
    if (!choices.length || !data) return -1;
    const hasIndex = data.correctOptionIndex !== undefined && data.correctOptionIndex !== null && data.correctOptionIndex !== '';
    const i = hasIndex ? Number(data.correctOptionIndex) : NaN;
    // A valid DOM-index is authoritative; don't let a loose text match override it.
    if (Number.isInteger(i) && i >= 0 && i < choices.length) return i;
    const answer = norm(data.answer || data.correctOption || '');
    if (!answer) return -1;
    const exact = choices.findIndex(c => norm(c).toLowerCase() === answer.toLowerCase());
    if (exact >= 0) return exact;
    const letter = answer.match(/^(?:(?:option|choice|answer)\s*)?([A-Z])(?:[).:\s]|$)/i);
    if (letter) { const n = letter[1].toUpperCase().charCodeAt(0) - 65; if (n >= 0 && n < choices.length) return n; }
    const prefix = choices.map((c, n) => ({ c: norm(c).toLowerCase(), n })).filter(x => x.c.startsWith(answer.toLowerCase()) && answer.length >= 5);
    return prefix.length === 1 ? prefix[0].n : -1;
  }
  function safeNum(v, fallback, min = -100000, max = 100000) {
    const n = Number(v); return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
  }

  function precisionSpec(q, label = '') {
    const s = `${q.paragraphs.join(' ')} ${q.renderedText}`;
    let m = s.match(/\b(\d+)\s*(?:significant figures|significant digits|sig\.?\s*figs?\.?|s\.f\.)\b/i);
    if (m) return { kind: 'sig', digits: Math.max(1, Math.min(10, +m[1])) };
    m = s.match(/\b(\d+)\s+decimal places\b/i);
    if (m) return { kind: 'dec', digits: Math.max(0, Math.min(10, +m[1])) };
    m = s.match(/\b(?:nearest|round(?:ed)?\s+to\s+the\s+nearest)\s+(whole number|integer|tenth|hundredth|thousandth|ten|hundred|thousand)\b/i);
    if (m) return { kind: 'dec', digits: ({ 'whole number':0, integer:0, tenth:1, hundredth:2, thousandth:3, ten:-1, hundred:-2, thousand:-3 })[m[1].toLowerCase()] };
    if (/molar\s+mass|molecular\s+mass/i.test(label)) return { kind: 'dec', digits: 2 };
    if (/molar mass|limiting reactant|stoichiometr|precipitat|reaction mole ratio|g\/mol/i.test(s)) return { kind: 'sig', digits: 3 };
    return null;
  }
  function roundScalar(value, q, label = '') {
    const original = String(value ?? '').trim(), spec = precisionSpec(q, label);
    if (!original || !spec) return original;
    const match = original.match(/^\s*((?:(?:the\s+)?(?:correct\s+)?answer|final\s+answer|mass|moles|amount|product\s+mass)\s*(?:is|=|:)?\s*)?([-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?)\s*(.*?)\s*$/i);
    if (!match) return original;
    const tail = match[3] || '';
    if (tail && !/^(?:g\/mol|mmol|mol|kg|mg|µg|mcg|g|grams?|kilograms?|milligrams?|mL|ml|L|liters?|litres?|atm|kPa|Pa|°C|K|cm|mm|km|m|kJ|J|%)(?:\b|\s|\/|\^|\(|\.|,|$)/i.test(tail)) return original;
    const n = Number(match[2]); if (!Number.isFinite(n)) return original;
    let result;
    if (spec.kind === 'dec') result = n.toFixed(Math.max(0, Math.min(10, spec.digits || 0)));
    else {
      const figs = Math.max(1, Math.min(10, spec.digits || 3));
      if (n === 0) result = '0';
      else { const places = figs - 1 - Math.floor(Math.log10(Math.abs(n))); result = Number(n.toPrecision(figs)).toFixed(Math.max(0, Math.min(10, places))); if (places < 0) result = String(Number(n.toPrecision(figs))); }
    }
    return `${match[1] || ''}${result}${tail ? ` ${tail}` : ''}`.trim();
  }

  function normalizeForRender(data, q) {
    const d = data && typeof data === 'object' ? { ...data } : { answer: String(data || '') };
    // Hard gate output structures using actual exercise DOM evidence. The model cannot trigger these renderers.
    if (!(q.type === 'grid' && q.layout.explicitMatrix)) delete d.grid;
    if (!(q.type === 'graph' && q.layout.explicitGraph)) delete d.graph;
    if (!(q.type === 'table' && q.tables.some(t => t.editableCount > 0))) delete d.table;
    if (q.type !== 'drag_drop') delete d.dragDrop;
    if (q.choices.length < 2) { delete d.correctOptionIndex; delete d.correctOptionIndices; }
    if (!independentInputs(q).length) delete d.inputAnswers;
    return d;
  }

  function renderChoices(data, q) {
    const choices = q.choices, isMulti = q.type === 'multi_select';
    let selected = [];
    if (isMulti && Array.isArray(data.correctOptionIndices)) selected = data.correctOptionIndices.map(Number).filter(i => Number.isInteger(i) && i >= 0 && i < choices.length);
    else { const i = idxFor(data, choices); if (i >= 0) selected = [i]; }
    return `<div class="choice-list">${choices.map((choice, i) => {
      const ok = selected.includes(i);
      return `<div class="choice ${ok ? 'correct' : ''}"><span class="choice-mark">${ok ? '✓' : String.fromCharCode(65 + i)}</span><span class="choice-text">${escapeHTML(choice)}</span>${ok ? '<span class="choice-tag">MATCH</span>' : ''}</div>`;
    }).join('')}</div>${selected.length ? '' : '<div class="muted-note">The answer did not map cleanly to one of the visible choices. Check the option index and text.</div>'}`;
  }

  function renderInputAnswers(data, q) {
    const fields = independentInputs(q);
    const src = Array.isArray(data.inputAnswers) ? data.inputAnswers : [];
    const byIndex = new Map();
    src.forEach((item, pos) => {
      const i = Number.isInteger(Number(item?.index)) ? Number(item.index) : (fields[pos]?.index ?? pos);
      const a = typeof item === 'string' ? item : (item?.answer ?? item?.value ?? item?.text ?? '');
      if (fields.some(f => f.index === i) && norm(a)) byIndex.set(i, norm(a));
    });
    return `<div class="input-answer-list">${fields.map((f, n) => {
      const a = byIndex.has(f.index) ? roundScalar(byIndex.get(f.index), q, f.label) : '';
      return `<div class="input-answer ${a ? 'has-answer' : 'missing-answer'}"><div class="input-answer-head"><span class="input-number">${n + 1}</span><span class="input-label">${escapeHTML(f.label)}</span><span class="input-kind">${escapeHTML(f.kind)}</span></div><div class="input-answer-value">${escapeHTML(a || 'No separate answer returned for this field')}</div></div>`;
    }).join('')}</div><div class="grid-caption">${src.length ? `${Math.min(src.length, fields.length)} response item(s) returned for ${fields.length} independent field(s)` : `No field answers returned for ${fields.length} input(s)`}</div>`;
  }

  function renderTables(data, q) {
    const solution = data.table || {}, tables = q.tables.filter(t => t.editableCount > 0);
    const index = Number.isInteger(Number(solution.tableIndex)) && tables.some(t => t.index === Number(solution.tableIndex)) ? Number(solution.tableIndex) : tables[0]?.index;
    const table = q.tables.find(t => t.index === index);
    if (!table) return '';
    const fillMap = new Map();
    for (const f of (Array.isArray(solution.fills) ? solution.fills : [])) {
      const r = Number(f.row), c = Number(f.col), v = norm(f.value ?? f.answer ?? '');
      if (Number.isInteger(r) && Number.isInteger(c) && r >= 0 && c >= 0 && v) fillMap.set(`${r},${c}`, v);
    }
    const html = table.rows.map((row, r) => `<tr>${row.map((cell, c) => {
      const value = fillMap.get(`${r},${c}`) || cell.text || '';
      const tag = cell.header ? 'th' : 'td';
      return `<${tag} class="${fillMap.has(`${r},${c}`) ? 'filled' : ''}${!value ? ' empty' : ''}">${escapeHTML(value)}${fillMap.has(`${r},${c}`) ? '<span class="table-answer-tag">ANSWER</span>' : ''}</${tag}>`;
    }).join('')}</tr>`).join('');
    return `<div class="answer-table-frame"><div class="answer-table-wrap"><table class="answer-table"><tbody>${html}</tbody></table></div><div class="grid-caption">Matches the editable table detected in the question · ${fillMap.size} filled cell(s)</div></div>`;
  }

  function renderDrag(data, q) {
    const d = data.dragDrop || {}, items = q.dragDrop.items.map(x => x.label), targets = q.dragDrop.targets.map(x => x.label);
    if (q.dragDrop.mode === 'order') {
      let order = Array.isArray(d.order) ? d.order.map(x => typeof x === 'string' ? x : x?.item || x?.label || '') : [];
      if (!order.length && Array.isArray(d.placements)) order = d.placements.slice().sort((a,b) => Number(a.orderIndex ?? 999)-Number(b.orderIndex ?? 999)).map(x => x.item || x.label || '');
      return `<div class="drag-preview"><div class="drag-preview-title">Suggested order</div>${order.length ? order.map((x,i) => `<div class="drag-order-row"><span class="drag-position">${i+1}</span><span>${escapeHTML(x)}</span></div>`).join('') : '<div class="muted-note">No complete order was returned.</div>'}</div>`;
    }
    const placements = Array.isArray(d.placements) ? d.placements : [];
    const rows = targets.map((target, i) => {
      const assigned = placements.filter(p => Number(p.targetIndex) === i || norm(p.target || p.targetLabel || '').toLowerCase() === target.toLowerCase());
      return `<div class="drag-target-row"><div class="drag-target-label">${escapeHTML(target)}</div><div class="drag-drop-slot">${assigned.length ? assigned.map(p => `<span class="drag-chip placed">${escapeHTML(p.item || p.label || p.text || 'Item')}</span>`).join('') : '<span class="drag-empty">No item assigned</span>'}</div></div>`;
    }).join('');
    const assigned = new Set(placements.map(p => norm(p.item || p.label || '').toLowerCase()));
    const remaining = items.filter(x => !assigned.has(x.toLowerCase()));
    return `<div class="drag-preview"><div class="drag-preview-title">Suggested placement</div>${rows || '<div class="muted-note">No visible target labels were detected.</div>'}${remaining.length ? `<div class="drag-bank"><div class="drag-preview-title">Unassigned items</div><div class="drag-chip-list">${remaining.map(x => `<span class="drag-chip">${escapeHTML(x)}</span>`).join('')}</div></div>` : ''}</div>`;
  }

  function renderGrid(data, q) {
    if (!(q.type === 'grid' && q.layout.explicitMatrix)) return '';
    const rows = Math.max(1, Math.min(24, q.layout.gridRows || 1)), cols = Math.max(1, Math.min(24, q.layout.gridCols || q.layout.gridCells || 1));
    const selected = new Set();
    for (const cell of (data.grid?.selectedCells || [])) if (Array.isArray(cell) && cell.length >= 2) {
      const r = Number(cell[0]), c = Number(cell[1]); if (r >= 0 && r < rows && c >= 0 && c < cols) selected.add(`${r},${c}`);
    }
    let body = '';
    for (let r=0; r<rows; r++) { body += '<div class="grid-row">'; for (let c=0;c<cols;c++) { const yes=selected.has(`${r},${c}`); body += `<div class="grid-cell ${yes?'selected':''}">${yes?'✓':''}</div>`; } body += '</div>'; }
    return `<div class="grid-frame"><div class="grid-board" style="--grid-cols:${cols}">${body}</div><div class="grid-caption">Preview of the actual grid control · rows/columns start at 1 in this preview</div></div>`;
  }

  function renderGraph(data) {
    const g = data.graph || {}, xmin = safeNum(g.xMin,-5,-1000,1000), xmax = safeNum(g.xMax,5,-1000,1000), ymin=safeNum(g.yMin,-5,-1000,1000), ymax=safeNum(g.yMax,5,-1000,1000);
    const W=360,H=250,L=36,R=10,T=10,B=28, pw=W-L-R, ph=H-T-B;
    const sx=x=>L+(x-xmin)/(xmax-xmin||1)*pw, sy=y=>T+(1-(y-ymin)/(ymax-ymin||1))*ph;
    let svg=`<svg class="graph-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="Solution preview for the interactive graph present in the question">`;
    for(let i=0;i<=10;i++){ const x=xmin+(xmax-xmin)*i/10, y=ymin+(ymax-ymin)*i/10; svg+=`<line x1="${sx(x)}" y1="${T}" x2="${sx(x)}" y2="${T+ph}" class="graph-grid"/><line x1="${L}" y1="${sy(y)}" x2="${L+pw}" y2="${sy(y)}" class="graph-grid"/>`; }
    if(xmin<=0&&xmax>=0)svg+=`<line x1="${sx(0)}" y1="${T}" x2="${sx(0)}" y2="${T+ph}" class="graph-axis"/>`;
    if(ymin<=0&&ymax>=0)svg+=`<line x1="${L}" y1="${sy(0)}" x2="${L+pw}" y2="${sy(0)}" class="graph-axis"/>`;
    const f=g.function||{}; let path='';
    if(f.kind==='line'&&Number.isFinite(Number(f.slope))&&Number.isFinite(Number(f.intercept)))path=`M ${sx(xmin)} ${sy(Number(f.slope)*xmin+Number(f.intercept))} L ${sx(xmax)} ${sy(Number(f.slope)*xmax+Number(f.intercept))}`;
    if(path)svg+=`<path d="${path}" class="graph-answer-line"/>`;
    for(const p of (g.points||[]).slice(0,60))if(Number.isFinite(Number(p.x))&&Number.isFinite(Number(p.y)))svg+=`<circle cx="${sx(+p.x)}" cy="${sy(+p.y)}" r="4" class="graph-answer-point"/>`;
    svg+='</svg>';
    return `<div class="graph-frame">${svg}${g.equation?`<div class="graph-equation">${escapeHTML(g.equation)}</div>`:''}<div class="grid-caption">Illustrative solution for the interactive graph detected on the page</div></div>`;
  }

  function renderAnswer(rawData, q, verification = {}) {
    const data = normalizeForRender(rawData, q);
    const parts = [];
    const free = independentInputs(q);
    const isChoice = q.choices.length >= 2 && ['multiple_choice','multi_select','mixed'].includes(q.type);
    const isMixed = q.type === 'mixed';
    const actualEditableTable = q.type === 'table' && q.tables.some(t => t.editableCount > 0);
    const actualGrid = q.type === 'grid' && q.layout.explicitMatrix;
    const actualGraph = q.type === 'graph' && q.layout.explicitGraph;
    const actualDrag = q.type === 'drag_drop' && q.dragDrop.items.length >= 2;

    if (isChoice) parts.push(renderChoices(data, q));
    if (free.length) parts.push(renderInputAnswers(data, q));
    if (actualDrag) parts.push(renderDrag(data, q));
    if (actualEditableTable) parts.push(renderTables(data, q));
    if (actualGrid) parts.push(renderGrid(data, q));
    if (actualGraph) parts.push(renderGraph(data));

    if (!parts.length) {
      const answer = roundScalar(data.math || data.answer || 'No answer provided', q, 'final answer');
      parts.push(`<div class="answer-callout"><div class="eyebrow">ANSWER</div><div class="answer-main ${data.math?'math-answer':''}">${escapeHTML(answer)}</div></div>`);
    } else if (data.answer && !isChoice && !free.length && !actualEditableTable && !actualGrid && !actualGraph && !actualDrag) {
      parts.unshift(`<div class="answer-callout"><div class="eyebrow">ANSWER</div><div class="answer-main">${escapeHTML(roundScalar(data.answer,q,'final answer'))}</div></div>`);
    }

    const forbiddenLayoutReported = (!!rawData?.grid && !actualGrid) || (!!rawData?.graph && !actualGraph) || (!!rawData?.table && !actualEditableTable) || (!!rawData?.dragDrop && !actualDrag);
    const notes = [];
    if (verification.note) notes.push(verification.note);
    if (forbiddenLayoutReported) notes.push('Suppressed an AI-invented grid/graph/table/drag layout because the matching answer control was not detected in the actual question.');
    const confidence = ['high','medium','low'].includes(norm(data.confidence).toLowerCase()) ? norm(data.confidence).toLowerCase() : '';
    const typeLabel = isMixed ? 'mixed answer' : q.type.replace(/_/g,' ');
    const verify = verification.status === 'checked' ? '<span class="verify-tag checked">double-checked</span>' : verification.status === 'failed' ? '<span class="verify-tag failed">check unavailable</span>' : '';
    const steps = (isChoice && !free.length && !actualEditableTable && !actualGrid && !actualGraph && !actualDrag) ? [] : (Array.isArray(data.steps) ? data.steps.filter(Boolean).slice(0,5) : []);
    const explanation = (isChoice && !free.length && !actualEditableTable && !actualGrid && !actualGraph && !actualDrag) ? '' : norm(data.explanation || '');
    return `<div class="result-head"><span class="eyebrow">SOLUTION</span><span class="type-tag">${escapeHTML(typeLabel || 'answer')}</span>${confidence?`<span class="confidence ${confidence}">${confidence} confidence</span>`:''}${verify}</div>${parts.join('')}${notes.length?`<div class="verify-note">${escapeHTML(notes.join(' '))}</div>`:''}${explanation?`<section class="explanation"><div class="section-title">WHY</div><p>${escapeHTML(explanation)}</p></section>`:''}${steps.length?`<section class="steps"><div class="section-title">STEPS</div><ol>${steps.map(x=>`<li>${escapeHTML(x)}</li>`).join('')}</ol></section>`:''}`;
  }

  function buildUI() {
    host = document.createElement('div'); host.id = 'ka-visual-solver-host';
    host.style.cssText = 'all:initial;position:fixed;z-index:2147483647;left:18px;right:auto;bottom:18px;width:min(390px,calc(100vw - 28px));font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;';
    shadow = host.attachShadow({mode:'open'});
    shadow.innerHTML = `
      <style>
        :host{all:initial;color:#27243b}*{box-sizing:border-box}.panel{background:rgba(255,255,255,.98);border:1px solid #e5e0f2;border-radius:19px;box-shadow:0 16px 48px rgba(43,31,77,.22);overflow:hidden;color:#27243b;font-size:13px}.top{display:flex;align-items:center;gap:10px;padding:13px 14px;background:linear-gradient(115deg,#fff7fb,#f4f1ff);border-bottom:1px solid #ece6f6}.logo{width:34px;height:34px;border-radius:12px;background:#e9defe;color:#6741b8;display:grid;place-items:center;font-size:18px;font-weight:850;flex:none}.brand{min-width:0;flex:1}.brand b{display:block;font-size:14px;letter-spacing:-.2px}.subtitle{color:#817991;font-size:11px;margin-top:2px}.status{border-radius:999px;padding:5px 8px;font-size:10px;font-weight:800;letter-spacing:.4px;background:#eeeaf4;color:#716980;white-space:nowrap}.status.on{background:#e1f7e9;color:#197444}.icon-btn{border:0;background:transparent;color:#766c86;font-size:18px;width:25px;height:25px;cursor:pointer;border-radius:7px}.icon-btn:hover{background:#ebe5f6}.body{max-height:min(70vh,680px);overflow:auto;padding:13px}.question-block{padding:10px 11px;background:#faf8fd;border:1px solid #eee9f7;border-radius:12px;margin-bottom:11px}.eyebrow,.section-title{font-size:9px;font-weight:850;letter-spacing:1px;color:#9589a9;text-transform:uppercase}.question-text{margin-top:6px;line-height:1.5;color:#4c455e;white-space:pre-wrap;overflow-wrap:anywhere;max-height:150px;overflow:auto}.row{display:flex;gap:7px;margin:0 0 11px}button.action{flex:1;min-width:0;border:1px solid #e4dced;background:#fff;color:#5c4d71;padding:9px 10px;border-radius:10px;font-weight:750;font-size:11px;cursor:pointer}button.action.primary{color:white;background:#7553c6;border-color:#7553c6}button.action:hover{filter:brightness(.98)}button.action:disabled{opacity:.55;cursor:wait}.result{border-top:1px solid #eee8f5;padding-top:12px}.placeholder{color:#8c829b;background:#faf8fd;border:1px dashed #e3daef;border-radius:12px;padding:16px 12px;text-align:center;line-height:1.55}.result-head{display:flex;align-items:center;gap:7px;flex-wrap:wrap;margin-bottom:10px}.type-tag{border-radius:999px;padding:4px 7px;background:#f0eafb;color:#7553b4;font-size:10px;font-weight:800;text-transform:capitalize}.confidence{margin-left:auto;font-size:10px;font-weight:800;text-transform:capitalize}.confidence.high{color:#238053}.confidence.medium{color:#a86b18}.confidence.low{color:#bd4c57}.answer-callout{border:1px solid #e3d8f5;border-radius:13px;background:#faf7ff;padding:12px;margin:2px 0 10px}.answer-main{color:#392958;font-size:19px;font-weight:800;line-height:1.35;overflow-wrap:anywhere;margin-top:5px;white-space:pre-wrap}.math-answer{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:17px}.choice-list{display:grid;gap:7px;margin:5px 0 10px}.choice{display:flex;align-items:flex-start;gap:9px;padding:9px 10px;border:1px solid #e8e3ee;border-radius:11px;background:#fff;min-width:0}.choice.correct{border:1.5px solid #36a269;background:#effbf3}.choice-mark{flex:none;width:23px;height:23px;display:grid;place-items:center;border-radius:7px;background:#f0edf4;color:#777086;font-weight:850;font-size:11px}.choice.correct .choice-mark{background:#2a9b61;color:#fff}.choice-text{flex:1;line-height:1.45;overflow-wrap:anywhere;padding-top:3px}.choice-tag{flex:none;color:#258151;font-size:9px;letter-spacing:.5px;font-weight:900;padding-top:6px}.muted-note{color:#988fa4;font-size:11px;margin:5px 0 10px}.input-answer-list{display:grid;gap:8px;margin:4px 0 8px}.input-answer{border:1px solid #e8e1f0;border-radius:11px;padding:10px;background:#fff;min-width:0}.input-answer.has-answer{border-color:#a9dfbc;background:#f4fcf6}.input-answer.missing-answer{border-color:#edd9b6;background:#fffaf0}.input-answer-head{display:flex;align-items:center;gap:8px;min-width:0}.input-number{flex:none;display:grid;place-items:center;width:22px;height:22px;border-radius:7px;background:#ece5f8;color:#6846a9;font-weight:850;font-size:11px}.input-label{flex:1;min-width:0;color:#685a7a;font-size:11px;font-weight:750;overflow-wrap:anywhere}.input-kind{flex:none;color:#9a90a8;font-size:9px;text-transform:uppercase;letter-spacing:.4px}.input-answer-value{margin:8px 0 0 30px;font-size:17px;font-weight:800;color:#2a6542;line-height:1.4;white-space:pre-wrap;overflow-wrap:anywhere}.missing-answer .input-answer-value{color:#95671b;font-weight:650;font-size:12px}.drag-preview{border:1px solid #e8e1f0;border-radius:12px;padding:10px;background:#fcfbff;margin-bottom:10px}.drag-preview-title{font-size:11px;font-weight:850;color:#68527f;margin-bottom:8px}.drag-target-row{display:grid;grid-template-columns:minmax(90px,.8fr) minmax(0,1.2fr);gap:8px;align-items:center;padding:7px 0;border-top:1px solid #eee8f5}.drag-target-label{font-size:11px;font-weight:750;color:#5f536e;overflow-wrap:anywhere}.drag-drop-slot{min-height:34px;display:flex;align-items:center;gap:5px;flex-wrap:wrap;border:1px dashed #d7c9e8;border-radius:9px;padding:5px;background:#fff}.drag-empty{color:#aaa0b5;font-size:10px;font-style:italic}.drag-chip-list{display:flex;gap:6px;flex-wrap:wrap}.drag-chip{display:inline-flex;align-items:center;max-width:100%;border:1px solid #d9cfec;background:#f2edfc;color:#5b4389;border-radius:9px;padding:6px 8px;font-size:11px;font-weight:700;overflow-wrap:anywhere}.drag-chip.placed{border-color:#a9dfbc;background:#eaf8ef;color:#206942}.drag-order-row{display:flex;gap:9px;align-items:flex-start;border:1px solid #ebe5f3;border-radius:9px;background:#fff;padding:8px;margin:5px 0}.drag-position{flex:none;width:23px;height:23px;border-radius:7px;background:#e8ddfa;color:#6542a7;display:grid;place-items:center;font-weight:850;font-size:11px}.verify-tag{border-radius:999px;padding:4px 7px;font-size:9px;font-weight:850;letter-spacing:.2px}.verify-tag.checked{background:#e2f8e9;color:#197245}.verify-tag.failed{background:#fff2dc;color:#8b6019}.verify-note{color:#8d7a57;background:#fff9ec;border:1px solid #f0e2c3;border-radius:8px;padding:7px 8px;font-size:10px;line-height:1.45;margin:5px 0 10px}.answer-table-frame,.grid-frame,.graph-frame{padding:10px;border:1px solid #e9e2f2;border-radius:12px;background:#fcfbff;margin-bottom:10px;overflow:hidden}.answer-table-wrap{max-width:100%;overflow:auto;border-radius:8px}.answer-table{border-collapse:separate;border-spacing:3px;width:100%;min-width:240px;font-size:10px}.answer-table th,.answer-table td{vertical-align:middle;text-align:center;padding:8px 6px;min-width:45px;max-width:150px;overflow-wrap:anywhere;white-space:pre-wrap;border:1px solid #e1dbea;border-radius:6px;background:#fff;color:#534967}.answer-table th{background:#f2edf8;font-weight:800;color:#5c4c77}.answer-table td.empty{background:#fffdf5;border:1px dashed #c7b7a0}.answer-table td.filled{background:#e4f8eb;border:1.5px solid #2a9b61;color:#176b40;font-weight:800}.table-answer-tag{display:block;margin-top:3px;font-size:8px;letter-spacing:.3px;color:#258151}.grid-board{display:grid;grid-template-columns:repeat(var(--grid-cols,4),minmax(0,1fr));gap:4px}.grid-row{display:contents}.grid-cell{aspect-ratio:1;min-width:0;min-height:20px;border:1px solid #ded7e9;border-radius:5px;background:#fff;display:flex;align-items:center;justify-content:center;color:#6c617d;font-size:11px;overflow:hidden;text-align:center}.grid-cell.selected{background:#d9f5e4;border:1.5px solid #22975d;color:#146d40;font-weight:850}.grid-caption{margin-top:8px;color:#92879f;font-size:10px;line-height:1.4}.graph-svg{width:100%;height:auto;display:block;overflow:visible}.graph-grid{stroke:#eae5f1;stroke-width:1}.graph-axis{stroke:#7f748f;stroke-width:1.6}.graph-answer-line{fill:none;stroke:#8054d6;stroke-width:2.7}.graph-answer-point{fill:#2b9b61;stroke:#fff;stroke-width:1.5}.graph-equation{margin-top:7px;background:#f0e9fb;color:#5c3c99;padding:8px 9px;border-radius:8px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;overflow-wrap:anywhere}.explanation,.steps{margin-top:12px;padding-top:10px;border-top:1px solid #eee9f4}.explanation p{margin:6px 0 0;line-height:1.55;color:#514961;overflow-wrap:anywhere;white-space:pre-wrap}.steps ol{margin:7px 0 0;padding-left:20px;color:#514961;line-height:1.55}.steps li{padding:2px 0 4px}.footer{color:#a096ad;font-size:10px;text-align:center;line-height:1.45;padding:10px 5px 0}.error{background:#fff0f0;border:1px solid #f3d1d1;color:#9f3c46;border-radius:10px;padding:10px;line-height:1.5;margin-top:8px}.collapsed .body{display:none}@media(max-width:480px){:host{left:8px!important;right:auto!important;bottom:8px!important;width:calc(100vw - 16px)!important}.body{max-height:62vh}}
      </style>
      <div class="panel"><div class="top"><div class="logo">KA</div><div class="brand"><b>Visual Solver</b><div class="subtitle">Big Pickle · mixed tasks + double-check</div></div><span class="status" id="status">AUTO OFF</span><button class="icon-btn" id="minimize" aria-label="Minimize solver" title="Minimize">−</button></div>
      <div class="body" id="body"><div class="question-block"><div class="eyebrow">CURRENT QUESTION</div><div class="question-text" id="question">Looking for the current exercise…</div></div>
      <div class="row"><button class="action primary" id="solve">Solve question</button><button class="action" id="auto">Enable auto AI</button></div><div class="row"><button class="action" id="refresh">Refresh question</button><button class="action" id="clear">Clear solution</button></div><div class="row"><button class="action" id="settings">OpenCode settings</button></div>
      <div class="result" id="result"><div class="placeholder">The solution will show only answer layouts that match the controls detected on the Khan Academy page.</div></div><div class="footer">Big Pickle via your OpenCode server · displays solutions only; never selects or submits answers</div></div></div>`;
    document.documentElement.appendChild(host); uiRoot = shadow;
    $('#solve').addEventListener('click', () => solveCurrent(true));
    $('#auto').addEventListener('click', toggleAuto);
    $('#refresh').addEventListener('click', () => refreshQuestion(true));
    $('#clear').addEventListener('click', () => { $('#result').innerHTML = '<div class="placeholder">Solution cleared.</div>'; state.requestId++; state.loading = false; updateButtons(); });
    $('#settings').addEventListener('click', configureServer);
    $('#minimize').addEventListener('click', () => { state.minimized = !state.minimized; $('.panel').classList.toggle('collapsed', state.minimized); $('#minimize').textContent = state.minimized ? '+' : '−'; });
  }
  function setStatus(s,on=false){const el=$('#status');if(el){el.textContent=s;el.classList.toggle('on',!!on);}}
  function updateButtons(){if(!uiRoot)return;const b=$('#solve');if(b){b.disabled=state.loading||!state.question;b.textContent=state.loading?'Solving…':'Solve question';}const a=$('#auto');if(a){a.textContent=state.auto?'Pause auto AI':'Enable auto AI';a.classList.toggle('primary',state.auto);}setStatus(state.loading?'SOLVING':state.auto?'AUTO ON':'AUTO OFF',state.auto);}
  function showError(message){state.lastError=message;$('#result').innerHTML=`<div class="error">${escapeHTML(message)}</div>`;}
  function configureServer(){const value=window.prompt('OpenCode server URL. Start with: opencode serve --hostname 127.0.0.1 --port 4096',state.serverUrl);if(!value?.trim())return;try{const url=new URL(value.trim());if(!['http:','https:'].includes(url.protocol))throw new Error('Use http:// or https://');state.serverUrl=url.href.replace(/\/+$/,'');$('#result').innerHTML=`<div class="placeholder">Server set to <b>${escapeHTML(state.serverUrl)}</b>. Big Pickle will be used for the next solution.</div>`;}catch(e){showError(`Invalid server URL: ${e.message||e}`);}}
  function toggleAuto(){if(state.auto){state.auto=false;updateButtons();return;}if(!state.consented&&!window.confirm('Enable automatic AI solving? Visible question text, choices, labels, and attached question images are sent to the configured OpenCode server. The script only displays suggestions and does not touch answer controls.'))return;state.consented=true;state.auto=true;updateButtons();if(state.question)requestSolution(state.question);else refreshQuestion(true);}
  function solveCurrent(manual){if(!state.question){showError('No exercise question detected yet. Use Refresh question after the exercise appears.');return;}if(manual&&!state.consented){if(!window.confirm('Send this visible question and its visible choices/widget labels to OpenCode using Big Pickle? It will only display a solution.'))return;state.consented=true;}requestSolution(state.question);}

  function base64(buffer){const bytes=new Uint8Array(buffer);let bin='';for(let i=0;i<bytes.length;i+=0x8000)bin+=String.fromCharCode(...bytes.subarray(i,Math.min(i+0x8000,bytes.length)));return btoa(bin);}
  function loadImage(src,index){return new Promise(resolve=>{
    if(!src)return resolve(null);
    const dm=src.match(/^data:(image\/(?:png|jpe?g|webp|gif));base64,([\s\S]+)$/i);
    if(dm){const size=Math.floor(dm[2].length*.75);if(size>MAX_IMAGE_BYTES)return resolve(null);const mime=dm[1].toLowerCase().replace('image/jpg','image/jpeg');return resolve({type:'file',mime,filename:`ka-question-${index+1}.${mime.split('/')[1].replace('jpeg','jpg')}`,url:src});}
    let url;try{url=new URL(src,location.href);}catch(_){return resolve(null);}if(!['http:','https:'].includes(url.protocol))return resolve(null);
    GM.xmlHttpRequest({method:'GET',url:url.href,responseType:'arraybuffer',timeout:IMAGE_TIMEOUT,onload:r=>{try{if(r.status<200||r.status>=300||!r.response)return resolve(null);const size=r.response.byteLength;if(!size||size>MAX_IMAGE_BYTES)return resolve(null);const header=String(r.responseHeaders||'').match(/content-type\s*:\s*([^;\r\n]+)/i);let mime=(header?.[1]||'').trim().toLowerCase();if(!/^image\/(png|jpe?g|webp|gif)$/.test(mime)){const p=url.pathname.toLowerCase();mime=p.endsWith('.png')?'image/png':/\.jpe?g$/.test(p)?'image/jpeg':p.endsWith('.webp')?'image/webp':p.endsWith('.gif')?'image/gif':'';}if(!mime)return resolve(null);mime=mime.replace('image/jpg','image/jpeg');resolve({type:'file',mime,filename:`ka-question-${index+1}.${mime.split('/')[1].replace('jpeg','jpg')}`,url:`data:${mime};base64,${base64(r.response)}`});}catch(_){resolve(null);}},onerror:()=>resolve(null),ontimeout:()=>resolve(null)});
  });}
  async function imageFiles(q){
    const images=q.visuals.filter(x=>x.kind==='image'&&x.src&&(x.width>=45||x.height>=45)).sort((a,b)=>b.width*b.height-a.width*a.height).slice(0,MAX_IMAGES);
    const files=[];let total=0;
    for(let i=0;i<images.length;i++){const f=await loadImage(images[i].src,i);if(!f)continue;const bytes=Math.floor((f.url.split(',')[1]||'').length*.75);if(total+bytes>5200000)continue;total+=bytes;files.push(f);}
    // Canvas-backed diagrams often contain the only meaningful visual labels/relationships.
    if(q.root&&files.length<MAX_IMAGES){
      for(const canvas of [...q.root.querySelectorAll('canvas')].filter(visible).slice(0,2)){
        if(files.length>=MAX_IMAGES)break;
        try{const url=canvas.toDataURL('image/png');const payload=url.split(',')[1]||'';const bytes=Math.floor(payload.length*.75);if(!payload||bytes>MAX_IMAGE_BYTES||total+bytes>5200000)continue;files.push({type:'file',mime:'image/png',filename:`ka-question-canvas-${files.length+1}.png`,url});total+=bytes;}catch(_){}
      }
    }
    // Attach inline SVG diagrams as PNGs too, so the model gets pixels rather than labels alone.
    if(q.root&&files.length<MAX_IMAGES){
      for(const svg of [...q.root.querySelectorAll('svg')].filter(visible).slice(0,3)){
        if(files.length>=MAX_IMAGES)break;
        try{
          const clone=svg.cloneNode(true);if(!clone.getAttribute('xmlns'))clone.setAttribute('xmlns','http://www.w3.org/2000/svg');
          const serialized=new XMLSerializer().serializeToString(clone);const blob=new Blob([serialized],{type:'image/svg+xml;charset=utf-8'});const objectUrl=URL.createObjectURL(blob);
          const png=await new Promise(resolve=>{const image=new Image();image.onload=()=>{try{const rect=svg.getBoundingClientRect();const scale=Math.min(2,1200/Math.max(1,rect.width,rect.height));const canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.round(rect.width*scale));canvas.height=Math.max(1,Math.round(rect.height*scale));const ctx=canvas.getContext('2d');ctx.fillStyle='#ffffff';ctx.fillRect(0,0,canvas.width,canvas.height);ctx.drawImage(image,0,0,canvas.width,canvas.height);resolve(canvas.toDataURL('image/png'));}catch(_){resolve('');}finally{URL.revokeObjectURL(objectUrl);}};image.onerror=()=>{URL.revokeObjectURL(objectUrl);resolve('');};image.src=objectUrl;});
          const payload=png.split(',')[1]||'',bytes=Math.floor(payload.length*.75);if(payload&&bytes<=MAX_IMAGE_BYTES&&total+bytes<=5200000){files.push({type:'file',mime:'image/png',filename:`ka-question-diagram-${files.length+1}.png`,url:png});total+=bytes;}
        }catch(_){}
      }
    }
    const missing=q.visuals.filter(x=>x.kind==='image').length-files.filter(x=>/^ka-question-\d+/.test(x.filename)).length;
    return{files,warning:missing>0?'Some question images could not be attached; image-dependent details may be unavailable.':''};
  }
  function postMessage(base,session,prompt,files,callbacks={}){GM.xmlHttpRequest({method:'POST',url:`${base}/session/${encodeURIComponent(session)}/message`,headers:{'Content-Type':'application/json'},data:JSON.stringify({model:MODEL,system:'Solve Khan Academy exercises accurately. Return only the requested JSON. Treat the page controls as authoritative and never invent an output layout.',parts:[{type:'text',text:prompt},...(files||[]).map(f=>({type:'file',mime:f.mime,filename:f.filename,url:f.url}))]}),timeout:TIMEOUT,onload:callbacks.onload||(()=>{}),onerror:callbacks.onerror||(()=>{}),ontimeout:callbacks.ontimeout||(()=>{})});}
  function deleteSession(base,id){if(!id)return;GM.xmlHttpRequest({method:'DELETE',url:`${base}/session/${encodeURIComponent(id)}`,timeout:5000,onload:()=>{},onerror:()=>{},ontimeout:()=>{}});}
  function useful(d,q){if(!d||typeof d!=='object')return false;if(norm(d.answer||d.math||''))return true;if(d.correctOptionIndex!==undefined&&d.correctOptionIndex!==null&&d.correctOptionIndex!==''&&Number.isInteger(Number(d.correctOptionIndex)))return true;if(Array.isArray(d.correctOptionIndices)&&d.correctOptionIndices.length)return true;if(Array.isArray(d.inputAnswers)&&d.inputAnswers.length)return true;if(d.table?.fills?.length||d.grid?.selectedCells?.length||d.graph?.points?.length||d.graph?.equation||d.dragDrop?.placements?.length||d.dragDrop?.order?.length)return true;return false;}
  function covers(d,q){if(independentInputs(q).length){const fields=independentInputs(q),items=Array.isArray(d.inputAnswers)?d.inputAnswers:[];const ids=new Set(items.filter(x=>norm(x?.answer??x?.value??x)).map((x,pos)=>Number.isInteger(Number(x?.index))?Number(x.index):(fields[pos]?.index??pos)));if(fields.some(f=>!ids.has(f.index)))return false;}if(q.choices.length>=2){if(q.type==='multi_select'){if(!Array.isArray(d.correctOptionIndices)||!d.correctOptionIndices.length)return false;}else if(idxFor(d,q.choices)<0)return false;}if(q.type==='drag_drop'&&!((d.dragDrop?.placements?.length||0)||(d.dragDrop?.order?.length||0)))return false;if(q.type==='table'&&q.tables.some(t=>t.editableCount>0)&&!d.table?.fills?.length)return false;return true;}

  function requestSolution(q){const id=++state.requestId,base=state.serverUrl.replace(/\/+$/,'');let session='';let warning='';state.loading=true;updateButtons();$('#result').innerHTML='<div class="placeholder">Reading the real controls, solving with Big Pickle, then checking the answer…</div>';
    const cleanup=()=>deleteSession(base,session);const fail=msg=>{cleanup();if(id!==state.requestId)return;state.loading=false;updateButtons();showError(msg);};const finish=(d,status,note='')=>{cleanup();if(id!==state.requestId)return;state.loading=false;updateButtons();$('#result').innerHTML=renderAnswer(d,q,{status,note:[warning,note].filter(Boolean).join(' ')});};
    GM.xmlHttpRequest({method:'POST',url:`${base}/session`,headers:{'Content-Type':'application/json'},data:JSON.stringify({title:'KA Visual Solver · verified solution'}),timeout:TIMEOUT,onload:res=>{if(res.status<200||res.status>=300){fail(`OpenCode session creation failed (HTTP ${res.status}). Check the server URL and terminal.`);return;}let p;try{p=JSON.parse(res.responseText||'{}');}catch(_){fail('OpenCode returned an unreadable session response.');return;}session=getSessionId(p);if(!session){fail('OpenCode did not return a session ID. Check the local OpenCode API version.');return;}
      imageFiles(q).then(({files,warning:w})=>{if(id!==state.requestId){cleanup();return;}warning=w;$('#result').innerHTML=`<div class="placeholder">Solving with Big Pickle${files.length?` and ${files.length} question image(s)`:''} · second-pass verification…</div>`;
        const verify=(candidate,attempt=0)=>{postMessage(base,session,verificationPrompt(q,candidate),[],{onload:r=>{if(id!==state.requestId){cleanup();return;}try{let checked=parseResponse(r,'verification');checked=normalizeForRender(checked,q);if(useful(checked,q)&&covers(checked,q))finish(checked,'checked');else if(attempt<1)verify(useful(checked,q)?checked:candidate,attempt+1);else finish(candidate,'failed','The verifier did not return a complete answer for every visible part; showing the first pass.');}catch(e){finish(candidate,'failed',`Second-pass check failed; showing the first pass. ${e.message||e}`);}},onerror:()=>finish(candidate,'failed','Second-pass check could not reach OpenCode; showing the first pass.'),ontimeout:()=>finish(candidate,'failed','Second-pass check timed out; showing the first pass.')});};
        const solve=(attached,retry=0)=>{let prompt=solverPrompt(q);if(retry)prompt+='\n\nYour prior answer was incomplete. Re-read the actual UI evidence and answer every required field. Never invent a graph or grid.';if(warning)prompt+=`\n\nIMAGE NOTE: ${warning} Do not guess image-specific details.`;postMessage(base,session,prompt,attached,{onload:r=>{if(id!==state.requestId){cleanup();return;}let d;try{d=parseResponse(r,'solution');}catch(e){if(attached.length&&r.status>=400&&/image|vision|media|attachment|file|unsupported|validation/i.test(`${e.message} ${r.responseText||''}`)){warning='OpenCode could not accept attached images; continued text-only, so image-dependent answers may be unreliable.';solve([],Math.max(1,retry));return;}if(retry<1){solve(attached,retry+1);return;}fail(`Could not read Big Pickle’s response: ${e.message||e}`);return;}if(!useful(d,q)&&retry<1){solve(attached,retry+1);return;}if(!useful(d,q)){fail('Big Pickle returned an incomplete answer twice. Press Solve question to retry.');return;}verify(normalizeForRender(d,q));},onerror:()=>retry<1?solve(attached,retry+1):fail('Could not reach the OpenCode message API. Check that the server is running at the configured URL.'),ontimeout:()=>retry<1?solve(attached,retry+1):fail('Big Pickle timed out twice. Check the OpenCode server, then try again.')});};
        solve(files,0);
      }).catch(e=>fail(`Could not prepare question images: ${e.message||e}`));
    },onerror:()=>fail(`Could not connect to ${base}. Start OpenCode with: opencode serve --hostname 127.0.0.1 --port 4096`),ontimeout:()=>fail('OpenCode did not respond in time. Check that the local server is running.')});
  }

  function refreshQuestion(force=false){if(!uiRoot)return;const next=extractQuestion();if(!next){if(!state.question)$('#question').textContent='Waiting for exercise content…';return;}const changed=next.fingerprint!==state.fingerprint;state.question=next;if(!changed){if(force){const preview=next.prompt;$('#question').textContent=preview.length>1400?preview.slice(0,1400)+'…':preview;}updateButtons();return;}
    state.fingerprint=next.fingerprint;state.requestId++;state.loading=false;const preview=next.prompt;$('#question').textContent=preview.length>1400?preview.slice(0,1400)+'…':preview;state.lastError='';$('#result').innerHTML='<div class="placeholder">New question detected. Ready to solve.</div>';if(state.auto)requestSolution(next);updateButtons();}
  function observePage(){let timer=0;const schedule=()=>{clearTimeout(timer);timer=setTimeout(()=>refreshQuestion(false),480);};const observer=new MutationObserver(schedule);observer.observe(document.body,{childList:true,subtree:true,characterData:true,attributes:false});window.addEventListener('popstate',()=>setTimeout(()=>refreshQuestion(true),450));let previous=location.href;setInterval(()=>{if(location.href!==previous){previous=location.href;state.fingerprint='';setTimeout(()=>refreshQuestion(true),500);}},900);setTimeout(()=>refreshQuestion(true),1000);}

  buildUI(); observePage();
})();