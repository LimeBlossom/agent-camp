const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { setTimeout: delay } = require('node:timers/promises')
const test = require('node:test')

const root = path.join(__dirname, '..')

function runLocalBuild(args, env) {
  const result = spawnSync('bash', [path.join(root, 'local-build.sh'), ...args], {
    encoding: 'utf8',
    env,
    timeout: 15000,
  })
  assert.ifError(result.error)
  assert.equal(result.status, 0, result.stderr)
  return result
}

test('the local launcher follows the current AppImage and returns while it runs detached', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'camp-launcher-'))
  const bin = path.join(home, '.local/bin')
  const share = path.join(home, '.local/share/camp')
  const ready = path.join(home, 'ready')
  const released = path.join(home, 'release')
  const finished = path.join(home, 'finished')
  const env = { ...process.env, HOME: home, MD_ROOT: root, PATH: bin + ':/usr/bin:/bin' }
  t.after(() => {
    fs.writeFileSync(released, '')
    fs.rmSync(home, { recursive: true, force: true })
  })
  fs.mkdirSync(bin, { recursive: true })
  fs.mkdirSync(share, { recursive: true })
  fs.writeFileSync(path.join(bin, 'systemd-run'), `#!/bin/sh
set -eu
[ "$1 $2 $3 $4" = "--user --scope --slice=camp-ui.slice -q" ]
shift 4
exec "$@"
`, { mode: 0o755 })
  const image = path.join(share, 'Build with spaces.AppImage')
  fs.writeFileSync(image, `#!/bin/sh
set -eu
readlink /proc/$$/fd/0 > "$HOME/stdin"
printf 'detached output\n'
printf 'detached error\n' >&2
sid=$(ps -o sid= -p "$$")
printf '%s\n' "$1" "$CAMP_REPO_PATH" "$$" "$sid" > "$HOME/ready.tmp"
mv "$HOME/ready.tmp" "$HOME/ready"
for i in $(seq 1 600); do
  if [ -f "$HOME/release" ]; then
    touch "$HOME/finished"
    exit
  fi
  sleep 0.05
done
`, { mode: 0o755 })
  fs.symlinkSync(image, path.join(share, 'current.AppImage'))

  runLocalBuild(['install-launcher'], env)
  fs.accessSync(path.join(bin, 'munder-difflin'), fs.constants.X_OK)
  const launch = runLocalBuild(['launch', 'argument with spaces'], env)
  assert.equal(launch.stdout, '')
  assert.equal(launch.stderr, '')

  for (let i = 0; i < 400 && !fs.existsSync(ready); i++) await delay(25)
  const [arg, repo, pid, sid] = fs.readFileSync(ready, 'utf8').trim().split('\n')
  assert.equal(arg, 'argument with spaces')
  assert.equal(repo, root)
  assert.equal(sid.trim(), pid)
  assert.equal(fs.readFileSync(path.join(home, 'stdin'), 'utf8').trim(), '/dev/null')
  assert.equal(fs.existsSync(finished), false)
  fs.writeFileSync(released, '')
  for (let i = 0; i < 400 && !fs.existsSync(finished); i++) await delay(25)
  assert.equal(fs.existsSync(finished), true)
})
