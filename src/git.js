// The git side: does the commit exist, which paths does it hold, and an exact
// copy of its files with no history attached.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

// The caller's GIT_* variables never reach these git calls. Run from inside a
// git hook, GIT_DIR or GIT_INDEX_FILE would otherwise point git at a different
// repository or index than the one named on the command line.
function gitEnvironment() {
  const env = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (!name.startsWith('GIT_')) env[name] = value;
  }
  env.GIT_TERMINAL_PROMPT = '0';
  env.GIT_NO_LAZY_FETCH = '1'; // a partial clone must not fetch missing objects mid-check
  return env;
}

export function git(repo, args, input = '') {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['-C', repo, ...args], { env: gitEnvironment() });
    const out = [];
    const err = [];
    child.stdout.on('data', (chunk) => out.push(chunk));
    child.stderr.on('data', (chunk) => err.push(chunk));
    child.stdin.on('error', () => {}); // git may exit before reading its input
    child.on('error', (error) => reject(error.code === 'ENOENT' ? new Error('git is not installed, or not on PATH') : error));
    child.on('close', (code) => resolve({ code, stdout: Buffer.concat(out), stderr: Buffer.concat(err).toString().trim() }));
    child.stdin.end(input);
  });
}

// null when dir is not inside a git repository.
export async function repositoryInfo(dir) {
  if (!fs.existsSync(dir)) return null;
  const probe = await git(dir, ['rev-parse', '--git-dir']);
  if (probe.code !== 0) return null;
  const shallow = await git(dir, ['rev-parse', '--is-shallow-repository']);
  return { shallow: shallow.stdout.toString().trim() === 'true' };
}

// The type of the object a full id names ('commit', 'tree', ...), or null.
export async function objectType(repo, id) {
  const r = await git(repo, ['cat-file', '-t', id]);
  return r.code === 0 ? r.stdout.toString().trim() : null;
}

// For each path, whether it exists (as a file, folder or link) at the commit.
export async function pathsExist(repo, commit, paths) {
  if (paths.length === 0) return [];
  const r = await git(repo, ['cat-file', '--batch-check'], paths.map((p) => `${commit}:${p}\n`).join(''));
  if (r.code !== 0) throw new Error(`git cat-file failed: ${r.stderr}`);
  const lines = r.stdout.toString().split('\n');
  return paths.map((_, n) => /^[0-9a-f]+ (blob|tree|commit) [0-9]+$/.test(lines[n] ?? ''));
}

// Writes the commit's files into an empty folder exactly as git stores them:
// each blob's bytes, the executable bit, symlinks as symlinks, and no .git.
//
// This deliberately avoids `git archive`, which applies the commit's own
// .gitattributes: an `export-ignore` line can drop a failing test from the
// copy, `export-subst` rewrites file contents, and eol or filter attributes
// change bytes. A receipt must not be able to edit the evidence against it.
// Returns the number of files written.
export async function exportCommit(repo, commit, dest) {
  const listing = await git(repo, ['ls-tree', '-r', '-z', '--full-tree', commit]);
  if (listing.code !== 0) throw new Error(`git ls-tree failed: ${listing.stderr}`);
  const files = [];
  const submodules = [];
  for (const record of listing.stdout.toString('utf8').split('\0')) {
    if (!record) continue;
    const tab = record.indexOf('\t');
    const [mode, type, oid] = record.slice(0, tab).split(' ');
    const name = record.slice(tab + 1);
    if (type === 'commit') {
      submodules.push(name);
      continue;
    }
    if (type !== 'blob') throw new Error(`unexpected ${type} at ${name}`);
    const issue = unsafePath(name);
    if (issue) throw new Error(`the commit holds a path that is unsafe to write, ${JSON.stringify(name)} (${issue})`);
    files.push({ mode, oid, name });
  }
  if (submodules.length) {
    throw new Error(`the commit has submodules (${submodules.join(', ')}), and this version does not copy their contents`);
  }

  fs.mkdirSync(dest, { recursive: true });
  const links = [];
  await streamBlobs(repo, files, (file, bytes) => {
    const target = path.join(dest, file.name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (file.mode === '120000') links.push({ target, to: bytes.toString('utf8') });
    // 'wx' never overwrites: two paths that collide on a case-insensitive disk
    // fail loudly instead of leaving one file where the commit has two.
    else fs.writeFileSync(target, bytes, { flag: 'wx', mode: file.mode === '100755' ? 0o755 : 0o644 });
  });
  // Links go last, so no file is ever written through one.
  for (const link of links) fs.symlinkSync(link.to, link.target);
  return files.length;
}

function unsafePath(name) {
  if (name.startsWith('/')) return 'absolute';
  for (const part of name.split('/')) {
    if (part === '' || part === '.' || part === '..') return `contains "${part || '//'}"`;
    if (part.toLowerCase() === '.git') return 'contains .git';
  }
  return null;
}

// One `git cat-file --batch` streams every blob; each is handed to onBlob as
// soon as all of its bytes have arrived.
function streamBlobs(repo, files, onBlob) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['-C', repo, 'cat-file', '--batch'], { env: gitEnvironment() });
    let chunks = [];
    let buffered = 0;
    let next = 0;
    let pending = null; // the file whose bytes are arriving, and its size
    let failure = null;
    const stderr = [];

    const flatten = () => {
      if (chunks.length > 1) chunks = [Buffer.concat(chunks, buffered)];
      return chunks[0] ?? Buffer.alloc(0);
    };
    const keep = (rest) => {
      chunks = rest.length ? [rest] : [];
      buffered = rest.length;
    };

    child.stdout.on('data', (chunk) => {
      if (failure) return;
      chunks.push(chunk);
      buffered += chunk.length;
      try {
        for (;;) {
          if (!pending) {
            const all = flatten();
            const newline = all.indexOf(10);
            if (newline === -1) return;
            const header = all.subarray(0, newline).toString();
            keep(all.subarray(newline + 1));
            const file = files[next++];
            const match = /^([0-9a-f]+) blob ([0-9]+)$/.exec(header);
            if (!file || !match || match[1] !== file.oid) {
              throw new Error(`git cat-file answered "${header}"${file ? ` for ${file.name}` : ''}`);
            }
            pending = { file, size: Number(match[2]) };
          }
          if (buffered < pending.size + 1) return;
          const all = flatten();
          onBlob(pending.file, all.subarray(0, pending.size));
          keep(all.subarray(pending.size + 1)); // and the newline after the bytes
          pending = null;
        }
      } catch (error) {
        failure = error;
        child.kill();
      }
    });
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.stdin.on('error', () => {});
    child.on('error', reject);
    child.on('close', (code) => {
      if (failure) reject(failure);
      else if (code !== 0 || pending || next !== files.length) {
        reject(new Error(`git cat-file stopped early: ${Buffer.concat(stderr).toString().trim() || `exit ${code}`}`));
      } else resolve();
    });
    child.stdin.end(files.map((f) => `${f.oid}\n`).join(''));
  });
}
