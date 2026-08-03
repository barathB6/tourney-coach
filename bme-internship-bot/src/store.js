// Flat-file seen-set so each run only emails what's genuinely new.

import fs from 'node:fs';
import path from 'node:path';

export class Store {
  constructor(file) {
    this.file = file;
    this.data = { seen: {}, lastRun: null };
    if (fs.existsSync(file)) {
      try {
        this.data = JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch {
        // Corrupt state file shouldn't kill the run — start clean, keep a copy.
        fs.renameSync(file, `${file}.corrupt-${Date.now()}`);
      }
    }
    this.data.seen ||= {};
  }

  isNew(job) {
    return !this.data.seen[job.id];
  }

  record(job, firstSeen) {
    this.data.seen[job.id] = {
      title: job.title,
      company: job.company,
      url: job.url,
      source: job.source,
      score: job.score,
      firstSeen,
    };
  }

  /** Drop entries older than `days` so the file doesn't grow forever. */
  prune(days = 180) {
    const cutoff = Date.now() - days * 86_400_000;
    for (const [id, entry] of Object.entries(this.data.seen)) {
      if (entry.firstSeen && new Date(entry.firstSeen).getTime() < cutoff) {
        delete this.data.seen[id];
      }
    }
  }

  save(lastRun) {
    this.data.lastRun = lastRun;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2));
  }

  get size() {
    return Object.keys(this.data.seen).length;
  }
}
