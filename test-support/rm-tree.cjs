'use strict';
// Teardown for a temp hive. The hive appends log.jsonl asynchronously, so an append
// queued by the test can recreate a file after rmSync emptied the folder; another pass
// removes it.
const fs = require('node:fs');

module.exports = function rmTree(dir) {
  for (let i = 0; i < 20; i++) {
    try { fs.rmSync(dir, { recursive: true, force: true }); return; } catch (e) {
      if (e.code !== 'ENOTEMPTY' && e.code !== 'EBUSY') throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
};
