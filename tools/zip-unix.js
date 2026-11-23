#!/usr/bin/env node
// Writes a ZIP that keeps Unix permissions (for macOS packages built on Windows, where Compress-Archive
// records none): directories 0755, listed executables 0755, everything else 0644. Entries are sorted and
// dated by their file times; no symlinks, no ZIP64 (fails above 4 GB or 65535 entries).
//   node tools/zip-unix.js <source-directory> <output.zip> <executable-relative-path>...
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const [source, output, ...executables] = process.argv.slice(2);
if (!source || !output) { console.error('Usage: node tools/zip-unix.js <source-directory> <output.zip> [executable...]'); process.exit(64); }
if (typeof zlib.crc32 !== 'function') { console.error('Node 22.2 or newer is required (zlib.crc32).'); process.exit(1); }
if (fs.existsSync(output)) { console.error('Output exists; choose a new path.'); process.exit(1); }
const root = path.resolve(source), exec = new Set(executables.map(p => p.replaceAll('\\', '/')));

const entries = [];
(function walk(dir, rel) {
  for (const name of fs.readdirSync(dir).sort()) {
    const full = path.join(dir, name), relative = rel ? `${rel}/${name}` : name, stat = fs.lstatSync(full);
    if (stat.isSymbolicLink()) throw new Error('Symbolic links are not packaged: ' + relative);
    if (stat.isDirectory()) { entries.push({ name: relative + '/', dir: true, stat }); walk(full, relative); }
    else if (stat.isFile()) entries.push({ name: relative, dir: false, stat, full });
  }
})(root, '');
for (const name of exec) if (!entries.some(e => !e.dir && e.name === name)) throw new Error('Executable not found in the package: ' + name);
if (entries.length >= 0xffff) throw new Error('Too many entries for a non-ZIP64 archive.');

function dosTime(date) {
  const year = Math.min(2107, Math.max(1980, date.getFullYear()));
  return { time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate() };
}
const out = fs.openSync(output, 'wx'), central = [];
let offset = 0;
const write = buffer => {
  for (let done = 0; done < buffer.length;) done += fs.writeSync(out, buffer, done, buffer.length - done);   // writeSync may write less
  offset += buffer.length;
  if (offset >= 0xffffffff) throw new Error('Archive exceeds 4 GB.');
};
try {
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8'), raw = e.dir ? Buffer.alloc(0) : fs.readFileSync(e.full);
    const deflated = e.dir ? raw : zlib.deflateRawSync(raw, { level: 9 });
    const stored = e.dir || deflated.length >= raw.length, data = stored ? raw : deflated;
    const crc = zlib.crc32(raw), { time, date } = dosTime(e.stat.mtime), method = stored ? 0 : 8;
    const mode = e.dir ? 0o40755 : exec.has(e.name) ? 0o100755 : 0o100644;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10); local.writeUInt16LE(date, 12); local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18); local.writeUInt32LE(raw.length, 22); local.writeUInt16LE(name.length, 26); local.writeUInt16LE(0, 28);
    const at = offset;
    write(local); write(name); write(data);
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50, 0); record.writeUInt16LE((3 << 8) | 20, 4); record.writeUInt16LE(20, 6); record.writeUInt16LE(0x0800, 8);
    record.writeUInt16LE(method, 10); record.writeUInt16LE(time, 12); record.writeUInt16LE(date, 14); record.writeUInt32LE(crc, 16);
    record.writeUInt32LE(data.length, 20); record.writeUInt32LE(raw.length, 24); record.writeUInt16LE(name.length, 28);
    record.writeUInt16LE(0, 30); record.writeUInt16LE(0, 32); record.writeUInt16LE(0, 34); record.writeUInt16LE(0, 36);
    record.writeUInt32LE(((mode << 16) | (e.dir ? 0x10 : 0)) >>> 0, 38); record.writeUInt32LE(at, 42);
    central.push(record, name);
  }
  const start = offset;
  for (const part of central) write(part);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(offset - start, 12); end.writeUInt32LE(start, 16);
  write(end);
} catch (error) { fs.closeSync(out); fs.rmSync(output, { force: true }); throw error; }
fs.closeSync(out);
console.log(`Wrote ${output} (${entries.length} entries, executables: ${[...exec].join(', ') || 'none'})`);
