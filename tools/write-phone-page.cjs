'use strict';

// Writes the bundled phone page to out/phone/index.html so campPhonePagePath can point at it.

const { mkdirSync, writeFileSync } = require('node:fs');
const { dirname, join } = require('node:path');

const DEFAULT_DEST = join(__dirname, '..', 'out', 'phone', 'index.html');

function writePhonePage(dest = DEFAULT_DEST) {
  const { PHONE_PAGE } = require('../test-support/load-ts.cjs')('src/main/phonePage.ts');
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, PHONE_PAGE, 'utf8');
  return dest;
}

module.exports = { writePhonePage };

if (require.main === module) console.log(`[write-phone-page] ${writePhonePage()}`);
