import { execFile, spawn } from 'node:child_process';
import { access, readlink } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { inBackgroundPriority } from './agentScope';

const exec = promisify(execFile);
const packageName = /^Camp-([a-f0-9]{40})\.AppImage$/;

type Options = {
  repo: string;
  /** The Camp repo's integration branch; its tip is what gets packaged. */
  branch: string;
  installDir: string;
  settleMs?: number;
  packageTip?: (sha: string) => Promise<string | null>;
  log: (event: Record<string, unknown>) => void;
  mailBoss: (subject: string, body: string) => void;
};

export class CampBuildQueue {
  private pending: { sha: string; since: number } | undefined;
  private attempted: string | undefined;
  private building = false;
  private readonly packageTip: NonNullable<Options['packageTip']>;

  constructor(private readonly options: Options) {
    this.packageTip = options.packageTip ?? ((sha) => this.build(sha));
  }

  isBuilding(): boolean {
    return this.building;
  }

  async poll(now = Date.now()): Promise<void> {
    if (this.building) return;
    this.building = true;
    try {
      const sha = await this.readTip();
      if (sha !== this.pending?.sha) {
        this.pending = sha ? { sha, since: now } : undefined;
        this.attempted = undefined;
      }
      if (!this.pending || this.pending.sha === this.attempted) return;
      if (now - this.pending.since < (this.options.settleMs ?? 10_000)) return;
      const tip = this.pending.sha;
      this.attempted = tip;
      try {
        if (await this.installedSha() === tip) return;
        const path = await this.packageTip(tip);
        if (path) this.options.log({ kind: 'build-done', sha: tip, path });
      } catch (error) {
        const tail = String(error instanceof Error ? error.message : error).slice(-8192);
        this.options.log({ kind: 'build-error', sha: tip, tail });
        this.options.mailBoss(`Camp build failed at ${tip.slice(0, 8)}`,
          `Build of ${tip} failed. The launcher keeps its last good package.\n\n${tail}`);
      }
    } finally {
      this.building = false;
    }
  }

  private async readTip(): Promise<string | undefined> {
    try {
      const { stdout } = await exec('git', ['-C', this.options.repo, 'rev-parse', '--verify', `refs/heads/${this.options.branch}`]);
      const sha = stdout.trim();
      return /^[a-f0-9]{40}$/.test(sha) ? sha : undefined;
    } catch {
      return undefined;
    }
  }

  private async installedSha(): Promise<string | undefined> {
    const launcher = join(this.options.installDir, 'current.AppImage');
    try {
      const image = resolve(this.options.installDir, await readlink(launcher));
      await access(image);
      return packageName.exec(basename(image))?.[1];
    } catch {
      return undefined;
    }
  }

  private async build(sha: string): Promise<string | null> {
    const { repo, installDir, branch } = this.options;
    const { stdout: script } = await exec('git', ['-C', repo, 'show', `${sha}:local-build.sh`]);
    const status = await new Promise<number | null>((resolve, reject) => {
      const run = inBackgroundPriority('bash', ['-s', '--', 'autobuild', repo, sha, installDir, branch]);
      const child = spawn(run.file, run.args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, MD_DRY: '' }
      });
      let tail = '';
      const collect = (chunk: Buffer): void => { tail = (tail + chunk.toString()).slice(-8192); };
      child.stdout.on('data', collect);
      child.stderr.on('data', collect);
      child.on('error', reject);
      child.stdin.on('error', (error: NodeJS.ErrnoException) => {
        if (error.code !== 'EPIPE') reject(error);
      });
      child.on('close', (code, signal) => {
        if (code === 0 || code === 75) resolve(code);
        else reject(new Error(`local-build.sh exited with ${code ?? signal}\n${tail}`));
      });
      child.stdin.end(script);
    });
    return status === 75 ? null : join(installDir, 'builds', `Camp-${sha}.AppImage`);
  }
}
