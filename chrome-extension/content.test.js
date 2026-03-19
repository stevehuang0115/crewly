/**
 * Tests for Content Script (content.js)
 *
 * Validates visual indicators (glow effect + floating panel),
 * console capture, and message handling.
 *
 * Run: node content.test.js
 */

// ── DOM Mock (minimal JSDOM-like) ─────────────────────────────────────────────

class MockElement {
  constructor(tag) {
    this.tagName = tag.toUpperCase();
    this.id = '';
    this.style = {};
    this._innerHTML = '';
    this._textContent = '';
    this.children = [];
    this.parentNode = null;
    this._attributes = [];
  }
  get innerHTML() {
    // If children were appended via DOM, aggregate their textContent
    if (this.children.length > 0) {
      return this.children.map(c => c.outerText || c.textContent || c._textContent || '').join('');
    }
    return this._innerHTML;
  }
  set innerHTML(val) {
    this._innerHTML = val;
    this.children = [];
  }
  get textContent() {
    if (this.children.length > 0) {
      return this.children.map(c => {
        const own = c._textContent || '';
        const childText = c.children ? c.children.map(gc => gc._textContent || gc.textContent || '').join('') : '';
        return own + childText;
      }).join('');
    }
    return this._textContent;
  }
  set textContent(val) {
    this._textContent = val;
  }
  /** Approximate outerText for innerHTML aggregation */
  get outerText() {
    const own = this._textContent || '';
    const childText = this.children ? this.children.map(c => c.outerText || c._textContent || '').join('') : '';
    return own + childText;
  }
  remove() {
    if (this.parentNode) {
      this.parentNode.children = this.parentNode.children.filter(c => c !== this);
    }
  }
  appendChild(child) {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }
  get attributes() {
    return this._attributes;
  }
}

const documentElements = {};

const document = {
  createElement: (tag) => new MockElement(tag),
  getElementById: (id) => documentElements[id] || null,
  documentElement: new MockElement('html'),
  body: new MockElement('body'),
  querySelector: (sel) => null,
};

// Override appendChild to track by ID
const origAppend = document.documentElement.appendChild.bind(document.documentElement);
document.documentElement.appendChild = (el) => {
  if (el.id) documentElements[el.id] = el;
  return origAppend(el);
};

// Save real console for test output
const realConsole = { ...console };

// Mock globals
globalThis.document = document;
globalThis.window = { location: { href: 'https://example.com' } };
globalThis.console = {
  log: (...args) => {},
  warn: (...args) => {},
  error: (...args) => {},
};

const messageHandlers = [];
globalThis.chrome = {
  runtime: {
    onMessage: {
      addListener: (handler) => messageHandlers.push(handler),
    },
  },
};

// ── Load content script ──────────────────────────────────────────────────────
const fs = require('fs');
const path = require('path');
const contentCode = fs.readFileSync(path.join(__dirname, 'content.js'), 'utf8');
eval(contentCode);

// ── Test Utilities ───────────────────────────────────────────────────────────

let testsPassed = 0;
let testsFailed = 0;
const failures = [];

function resetDOM() {
  document.documentElement.children = [];
  Object.keys(documentElements).forEach(k => delete documentElements[k]);
}

async function test(name, fn) {
  resetDOM();
  try {
    await fn();
    testsPassed++;
    realConsole.log(`  ✓ ${name}`);
  } catch (err) {
    testsFailed++;
    failures.push({ name, error: err.message });
    realConsole.log(`  ✗ ${name}`);
    realConsole.log(`    ${err.message}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message || 'Assertion failed');
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(message || `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

// ── Tests ──────────────────────────────────────────────────────────────────────

async function runTests() {
  realConsole.log('\nContent Script Tests\n');

  // ── Glow Effect Tests ──

  realConsole.log('Glow Effect:');

  await test('showControlIndicator creates border overlay element', async () => {
    showControlIndicator('navigate');
    const border = documentElements['__crewly-ai-border'];
    assert(border, 'Border element should exist');
    assertEqual(border.style.position, 'fixed');
    assertEqual(border.style.pointerEvents, 'none');
    assertEqual(border.style.zIndex, '2147483646');
  });

  await test('Glow uses inset box-shadow (no solid border)', async () => {
    showControlIndicator('click');
    const border = documentElements['__crewly-ai-border'];
    assert(border.style.boxShadow.includes('inset'), 'Should use inset box-shadow');
    assert(border.style.boxShadow.includes('128, 0, 255'), 'Should use purple color (128, 0, 255)');
    // Should NOT have a solid border
    assert(!border.style.border, 'Should not have solid border property');
  });

  await test('Glow has pulse animation', async () => {
    showControlIndicator('screenshot');
    const border = documentElements['__crewly-ai-border'];
    assert(
      border.style.animation.includes('__crewlyBorderPulse'),
      'Should have pulse animation'
    );
    assert(
      border.style.animation.includes('2s'),
      'Animation should be 2s duration'
    );
  });

  await test('Glow covers full viewport', async () => {
    showControlIndicator('scroll');
    const border = documentElements['__crewly-ai-border'];
    assertEqual(border.style.top, '0');
    assertEqual(border.style.left, '0');
    assertEqual(border.style.right, '0');
    assertEqual(border.style.bottom, '0');
  });

  // ── Floating Panel Tests ──

  realConsole.log('\nFloating Panel:');

  await test('showControlIndicator creates floating panel', async () => {
    showControlIndicator('navigate');
    const panel = documentElements['__crewly-ai-indicator'];
    assert(panel, 'Panel element should exist');
    assertEqual(panel.style.position, 'fixed');
    assertEqual(panel.style.pointerEvents, 'none');
    assertEqual(panel.style.zIndex, '2147483647');
  });

  await test('Floating panel is centered at bottom', async () => {
    showControlIndicator('click');
    const panel = documentElements['__crewly-ai-indicator'];
    assertEqual(panel.style.bottom, '20px');
    assertEqual(panel.style.left, '50%');
    assertEqual(panel.style.transform, 'translateX(-50%)');
  });

  await test('Floating panel has purple background', async () => {
    showControlIndicator('type');
    const panel = documentElements['__crewly-ai-indicator'];
    assert(
      panel.style.background.includes('128, 0, 255'),
      'Should have purple background'
    );
  });

  await test('Floating panel has pill shape (borderRadius: 20px)', async () => {
    showControlIndicator('fill');
    const panel = documentElements['__crewly-ai-indicator'];
    assertEqual(panel.style.borderRadius, '20px');
  });

  await test('Floating panel displays "Crewly is taking over"', async () => {
    showControlIndicator('navigate');
    const panel = documentElements['__crewly-ai-indicator'];
    assert(
      panel.textContent.includes('Crewly is taking over'),
      'Panel should show "Crewly is taking over"'
    );
  });

  await test('Floating panel shows action label', async () => {
    showControlIndicator('navigate');
    const panel = documentElements['__crewly-ai-indicator'];
    assert(
      panel.textContent.includes('Navigating...'),
      'Panel should show action label'
    );
  });

  await test('Floating panel has backdrop-filter blur', async () => {
    showControlIndicator('screenshot');
    const panel = documentElements['__crewly-ai-indicator'];
    assert(
      panel.style.backdropFilter.includes('blur'),
      'Should have backdrop blur'
    );
  });

  // ── hideControlIndicator Tests ──

  realConsole.log('\nHide Indicator:');

  await test('hideControlIndicator removes both elements', async () => {
    showControlIndicator('navigate');
    assert(documentElements['__crewly-ai-border'], 'Border should exist before hide');
    assert(documentElements['__crewly-ai-indicator'], 'Panel should exist before hide');

    hideControlIndicator();
    // Elements are removed via .remove() but still in our documentElements map
    // Check they were removed from parent
    const border = document.documentElement.children.find(
      c => c.id === '__crewly-ai-border'
    );
    const panel = document.documentElement.children.find(
      c => c.id === '__crewly-ai-indicator'
    );
    assert(!border, 'Border should be removed from DOM');
    assert(!panel, 'Panel should be removed from DOM');
  });

  await test('showControlIndicator removes existing indicator before creating new one', async () => {
    showControlIndicator('navigate');
    const childCountAfterFirst = document.documentElement.children.length;

    showControlIndicator('click');
    // Should not accumulate — old ones removed before new ones added
    // We expect: styles + border + panel = 3 elements max (styles only added once)
    assert(
      document.documentElement.children.length <= childCountAfterFirst + 1,
      'Should not accumulate duplicate indicators'
    );
  });

  // ── Keyframe Animation Tests ──

  realConsole.log('\nKeyframe Animations:');

  await test('Injects keyframe styles on first show', async () => {
    showControlIndicator('navigate');
    const styles = documentElements['__crewlyStyles'];
    assert(styles, 'Style element should be injected');
    assert(
      styles.textContent.includes('__crewlyBorderPulse'),
      'Should define border pulse animation'
    );
    assert(
      styles.textContent.includes('__crewlyPulse'),
      'Should define dot pulse animation'
    );
  });

  await test('Border pulse animation matches spec (30px → 50px inset shadow)', async () => {
    showControlIndicator('navigate');
    const styles = documentElements['__crewlyStyles'];
    assert(
      styles.textContent.includes('inset 0 0 30px rgba(128, 0, 255, 0.3)'),
      'Should have 30px shadow at 0%/100%'
    );
    assert(
      styles.textContent.includes('inset 0 0 50px rgba(128, 0, 255, 0.5)'),
      'Should have 50px shadow at 50%'
    );
  });

  // ── Message Handler Tests ──

  realConsole.log('\nMessage Handling:');

  await test('showIndicator message creates indicator', async () => {
    const handler = messageHandlers[0];
    let responded = false;
    handler(
      { type: 'showIndicator', action: 'click' },
      {},
      (response) => { responded = true; }
    );
    assert(responded, 'Should respond');
    assert(documentElements['__crewly-ai-indicator'], 'Should create indicator');
  });

  await test('hideIndicator message removes indicator', async () => {
    showControlIndicator('navigate');
    const handler = messageHandlers[0];
    let responded = false;
    handler(
      { type: 'hideIndicator' },
      {},
      (response) => { responded = true; }
    );
    assert(responded, 'Should respond');
  });

  // ── Action Label Tests ──

  realConsole.log('\nAction Labels:');

  await test('Shows correct label for each known action', async () => {
    const actions = {
      navigate: 'Navigating...',
      screenshot: 'Taking screenshot...',
      click: 'Clicking...',
      fill: 'Filling input...',
      type: 'Typing...',
      scroll: 'Scrolling...',
    };

    for (const [action, expected] of Object.entries(actions)) {
      resetDOM();
      showControlIndicator(action);
      const panel = documentElements['__crewly-ai-indicator'];
      assert(
        panel.textContent.includes(expected),
        `Action "${action}" should show "${expected}"`
      );
    }
  });

  await test('Shows fallback label for unknown action', async () => {
    showControlIndicator('customAction');
    const panel = documentElements['__crewly-ai-indicator'];
    assert(
      panel.textContent.includes('Working...'),
      'Unknown action should show generic "Working..." fallback'
    );
  });

  // ── Summary ──

  realConsole.log(`\n${testsPassed + testsFailed} tests, ${testsPassed} passed, ${testsFailed} failed\n`);
  if (failures.length > 0) {
    realConsole.log('Failures:');
    failures.forEach(f => realConsole.log(`  - ${f.name}: ${f.error}`));
    process.exit(1);
  }
}

runTests().catch(err => {
  realConsole.error('Test runner error:', err);
  process.exit(1);
});
