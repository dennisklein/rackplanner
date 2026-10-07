'use strict';

// Shared by the drawing tests: a small well-formedness check for SVG output.

const assert = require('node:assert/strict');

/**
 * Throws unless `xml` is well formed: balanced tags, one root, quoted
 * attributes without duplicates, and no bare < or & in text or values.
 */
function assertWellFormed(xml, what) {
  const doc = xml.replace(/^<\?xml[^?]*\?>\s*/, '');
  const bareAmp = /&(?!(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/;
  const tag = /<(\/?)([A-Za-z][\w:.-]*)((?:\s+[A-Za-z_:][\w:.-]*="[^"<]*")*)\s*(\/?)>/y;
  const stack = [];
  let roots = 0;
  let i = 0;
  while (i < doc.length) {
    const lt = doc.indexOf('<', i);
    const txt = doc.slice(i, lt < 0 ? doc.length : lt);
    assert.ok(!bareAmp.test(txt), `${what}: bare & in text near ${JSON.stringify(txt.slice(0, 40))}`);
    if (lt < 0) break;
    tag.lastIndex = lt;
    const m = tag.exec(doc);
    assert.ok(m, `${what}: malformed tag at ${lt}: ${JSON.stringify(doc.slice(lt, lt + 60))}`);
    const [, close, name, attrs, self] = m;
    const names = [...attrs.matchAll(/([A-Za-z_:][\w:.-]*)="([^"]*)"/g)];
    assert.equal(new Set(names.map((a) => a[1])).size, names.length, `${what}: duplicate attribute in <${name}>`);
    for (const a of names) assert.ok(!bareAmp.test(a[2]), `${what}: bare & in ${name}@${a[1]}`);
    if (close) assert.equal(stack.pop(), name, `${what}: </${name}> closes the wrong element`);
    else if (!self) {
      if (!stack.length) roots++;
      stack.push(name);
    } else if (!stack.length) roots++;
    i = tag.lastIndex;
  }
  assert.equal(stack.length, 0, `${what}: unclosed ${stack.join(' > ')}`);
  assert.equal(roots, 1, `${what}: one root element`);
}

module.exports = { assertWellFormed };
