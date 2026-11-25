// Headshots from ESPN's public site API: NFL team rosters, and the player search for everyone else (free agents,
// college prospects). Answers and photos are cached on disk, so a second run only fetches what is new.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

export interface Athlete { id: string; name: string; team: string; headshot: string }
const UA = { 'User-Agent': 'Mozilla/5.0 (madden25-ps3-draft-patch)' };

export class Espn {
  failedSearches = 0;
  constructor(private cache: string) { mkdirSync(join(cache, 'api'), { recursive: true }); mkdirSync(join(cache, 'img'), { recursive: true }); }
  private async get(url: string, binary: boolean, file: string): Promise<Buffer> {
    if (existsSync(file)) return readFileSync(file);
    for (let attempt = 0; ; attempt++) {
      try {
        const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(30000) });
        if (r.status === 404) { const b = Buffer.from(binary ? '' : 'null'); writeFileSync(file, b); return b; }
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const b = Buffer.from(await r.arrayBuffer()); writeFileSync(file, b); return b;
      } catch (e) { if (attempt >= 4) throw new Error(`${url}: ${(e as Error).message}`); await new Promise((res) => setTimeout(res, 3000 * 2 ** attempt)); }
    }
  }
  async json(url: string): Promise<any> { return JSON.parse((await this.get(url, false, join(this.cache, 'api', createHash('sha1').update(url).digest('hex') + '.json'))).toString('utf8')); }
  async image(url: string): Promise<Buffer | null> { const b = await this.get(url, true, join(this.cache, 'img', createHash('sha1').update(url).digest('hex') + '.png')); return b.length ? b : null; }

  // every player on the 32 NFL team rosters, team = ESPN nickname ("Bears")
  async nflRosters(): Promise<Athlete[]> {
    const teams = (await this.json('https://site.api.espn.com/apis/site/v2/sports/football/nfl/teams')).sports[0].leagues[0].teams as any[];
    const out: Athlete[] = [];
    for (const { team } of teams) {
      const r = await this.json(`https://site.api.espn.com/apis/site/v2/sports/football/nfl/teams/${team.id}/roster`);
      for (const g of r.athletes ?? []) for (const a of g.items ?? []) if (a.headshot?.href) out.push({ id: String(a.id), name: a.fullName ?? `${a.firstName} ${a.lastName}`, team: team.name, headshot: a.headshot.href });
    }
    return out;
  }
  // the player search: league 'nfl' or 'college-football'; team = the team's location ("Montana") for college players
  async search(name: string, league: 'nfl' | 'college-football'): Promise<Athlete[]> {
    // a refused search (rate limit) just skips this player; it is not cached, so the next run asks again
    let r: any; try { r = await this.json(`https://site.web.api.espn.com/apis/common/v3/search?query=${encodeURIComponent(name)}&limit=10&type=player`); } catch { this.failedSearches++; return []; }
    return ((r?.items ?? []) as any[]).filter((i) => i.league === league && i.headshot?.href).map((i) => {
      const t = i.teamRelationships?.[0]?.core ?? {};
      return { id: String(i.id), name: i.displayName, team: league === 'nfl' ? (t.name ?? '') : (t.location ?? t.displayName ?? ''), headshot: i.headshot.href };
    });
  }
}

// names compared without case, punctuation or suffixes ("Clark Phillips III" = "clark phillips")
export function normName(s: string): string {
  return s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[.'`’-]/g, '').replace(/\b(jr|sr|ii|iii|iv|v)\b/g, '').replace(/(jr|sr|iii|ii|iv)$/, '').replace(/\s+/g, ' ').trim();
}
export const normTeam = (s: string) => s.toLowerCase().replace(/[^a-z]/g, '');
// Madden roster nicknames that changed since 2013
export const TEAM_ALIASES: Record<string, string> = { redskins: 'commanders' };

// run fn over items with a few requests in flight
export async function pool<T>(items: T[], n: number, fn: (t: T, i: number) => Promise<void>, progress?: (done: number) => void): Promise<void> {
  let next = 0, done = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (next < items.length) { const i = next++; await fn(items[i]!, i); done++; if (progress && done % 25 === 0) progress(done); } }));
}
