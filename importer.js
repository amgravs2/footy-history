#!/usr/bin/env node
/**
 * footy-history importer
 *
 * Priority-tiered import — runs in order, saves progress to Neon so each
 * daily run picks up exactly where it left off.
 *
 * Tier 1 — Big 5 + MLS players, full career history (1992→)
 * Tier 2 — Trophies for Tier 1 players
 * Tier 3 — Fixture stats for Big 5 + European competitions only
 * Tier 4 — Career history for all remaining players
 * Tier 5 — Trophies for remaining players
 *
 * Manual overrides:
 *   JOB=phase2_priority  node importer.js   (Tier 1 only)
 *   JOB=phase2           node importer.js   (all remaining players)
 *   JOB=trophies         node importer.js   (all players)
 *   JOB=fixtures         node importer.js   (Tier 3)
 *   JOB=status           node importer.js
 */

import pg from 'pg';
import fetch from 'node-fetch';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Config ────────────────────────────────────────────────────────────────────
const CONFIG = {
  API_KEY:      process.env.API_KEY      || '',
  DATABASE_URL: process.env.DATABASE_URL || '',
  DAILY_BUDGET: parseInt(process.env.DAILY_BUDGET || '72000', 10),
  DELAY_MS:     parseInt(process.env.API_DELAY_MS  || '500',    10),
  CAREER_BATCH: 5,   // seasons fetched in parallel per player (phase2)
};

// Leagues that define "priority" players — Big 5 + MLS
const BIG5_MLS_LEAGUES = [
  'Premier League',
  'La Liga',
  'Bundesliga',
  'Serie A',
  'Ligue 1',
  'Major League Soccer',
];

// European club competitions included in fixture import
const PRIORITY_FIXTURE_LEAGUES = {
  39:  'Premier League',
  140: 'La Liga',
  78:  'Bundesliga',
  135: 'Serie A',
  61:  'Ligue 1',
  2:   'UEFA Champions League',
  3:   'UEFA Europa League',
  848: 'UEFA Europa Conference League',
};

// ── DB ────────────────────────────────────────────────────────────────────────
const pool = new pg.Pool({
  connectionString: CONFIG.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 5,
});

async function q(sql, params = []) {
  const client = await pool.connect();
  try { return await client.query(sql, params); }
  finally { client.release(); }
}

// ── API ───────────────────────────────────────────────────────────────────────
let callsThisRun = 0;

class BudgetError extends Error {}

async function api(path) {
  if (callsThisRun >= CONFIG.DAILY_BUDGET) {
    throw new BudgetError(`Daily budget of ${CONFIG.DAILY_BUDGET} reached.`);
  }
  await sleep(CONFIG.DELAY_MS);
  const res = await fetch(`https://v3.football.api-sports.io${path}`, {
    headers: {
      'x-rapidapi-key': CONFIG.API_KEY,
      'x-rapidapi-host': 'v3.football.api-sports.io',
    },
  });
  callsThisRun++;

  const remaining = parseInt(res.headers.get('x-ratelimit-requests-remaining') ?? '9999', 10);
  process.stdout.write(`  [${callsThisRun}] ${path.slice(0,70).padEnd(70)} remaining=${remaining}\n`);

  if (remaining <= 20) throw new BudgetError(`API reports only ${remaining} requests remaining.`);
  if (!res.ok) throw new Error(`HTTP ${res.status} on ${path}`);

  const data = await res.json();
  if (data.errors && Object.keys(data.errors).length) {
    throw new Error(`API error: ${JSON.stringify(data.errors)}`);
  }
  return data;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Progress helpers ──────────────────────────────────────────────────────────
async function getProgress(jobType) {
  const res = await q(`
    INSERT INTO import_jobs (job_type, status, progress)
    VALUES ($1, 'running', '{}')
    ON CONFLICT (job_type) DO UPDATE SET
      status = 'running', started_at = COALESCE(import_jobs.started_at, now()),
      last_heartbeat = now(), updated_at = now()
    RETURNING *
  `, [jobType]);
  return res.rows[0];
}

async function saveProgress(jobType, progress, totalProcessed) {
  await q(`
    UPDATE import_jobs
    SET progress = $1, total_processed = $2, last_heartbeat = now(), updated_at = now()
    WHERE job_type = $3
  `, [JSON.stringify(progress), totalProcessed, jobType]);
}

async function markDone(jobType) {
  await q(`
    UPDATE import_jobs SET status = 'done', updated_at = now() WHERE job_type = $1
  `, [jobType]);
}

async function isJobDone(jobType) {
  const res = await q(`SELECT status FROM import_jobs WHERE job_type = $1`, [jobType]);
  return res.rows[0]?.status === 'done';
}

// ── Upsert helpers ────────────────────────────────────────────────────────────
async function upsertClub(team) {
  const res = await q(`
    INSERT INTO clubs (api_id, name, country, logo_url)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (api_id) DO UPDATE SET
      name = EXCLUDED.name, logo_url = COALESCE(EXCLUDED.logo_url, clubs.logo_url)
    RETURNING id
  `, [String(team.id), team.name, team.country || null, team.logo || null]);
  return res.rows[0].id;
}

async function upsertPlayer(p) {
  const res = await q(`
    INSERT INTO players (api_id, name, firstname, lastname, nationality, date_of_birth, position, photo_url)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
    ON CONFLICT (api_id) DO UPDATE SET
      name = EXCLUDED.name,
      nationality = COALESCE(EXCLUDED.nationality, players.nationality),
      position    = COALESCE(EXCLUDED.position,    players.position),
      photo_url   = COALESCE(EXCLUDED.photo_url,   players.photo_url),
      updated_at  = now()
    RETURNING id
  `, [String(p.id), p.name, p.firstname||null, p.lastname||null,
      p.nationality||null, p.birth?.date||null, p.position||null, p.photo||null]);
  return res.rows[0].id;
}

async function upsertStint(playerId, clubId, stat) {
  const league = stat.league || {};
  const games  = stat.games  || {};
  const goals  = stat.goals  || {};
  if (!league.season) return;
  await q(`
    INSERT INTO player_club_stints
      (player_id, club_id, league_name, league_country, season_year, appearances, goals, assists, minutes)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
    ON CONFLICT (player_id, club_id, season_year) DO UPDATE SET
      appearances = GREATEST(player_club_stints.appearances, EXCLUDED.appearances),
      goals       = GREATEST(player_club_stints.goals,       EXCLUDED.goals),
      assists     = GREATEST(player_club_stints.assists,     EXCLUDED.assists),
      minutes     = GREATEST(player_club_stints.minutes,     EXCLUDED.minutes)
  `, [playerId, clubId, league.name||null, league.country||null, league.season,
      games.appearences||0, goals.total||0, goals.assists||0, games.minutes||0]);
}

// ── PHASE 2: career histories ─────────────────────────────────────────────────
async function fetchCareerForPlayer(player, allSeasons) {
  for (let i = 0; i < allSeasons.length; i += CONFIG.CAREER_BATCH) {
    const batch = allSeasons.slice(i, i + CONFIG.CAREER_BATCH);
    const results = await Promise.all(
      batch.map(s => api(`/players?id=${player.api_id}&season=${s}`).catch(err => {
        if (err instanceof BudgetError) throw err;
        return null;
      }))
    );
    for (const data of results) {
      if (!data?.response?.length) continue;
      for (const entry of data.response) {
        for (const stat of entry.statistics) {
          if (!stat.team?.id) continue;
          const clubId = await upsertClub(stat.team);
          await upsertStint(player.id, clubId, stat);
        }
      }
    }
  }
  await q(`UPDATE players SET career_fetched=true, updated_at=now() WHERE id=$1`, [player.id]);
}

async function runPhase2(priorityOnly = false) {
  const label = priorityOnly ? 'PHASE 2 — Career histories (Big 5 + MLS priority)' : 'PHASE 2 — Career histories (remaining players)';
  console.log(`\n════════ ${label} ════════\n`);

  const jobType = priorityOnly ? 'phase2_priority' : 'phase2';
  const job = await getProgress(jobType);
  let prog = job.progress || {};
  let total = job.total_processed || 0;

  const seasonsData = await api('/players/seasons');
  const allSeasons = (seasonsData.response || []).filter(s => s >= 1992 && s <= 2025);
  console.log(`Seasons: ${allSeasons.join(', ')}\n`);

  // Priority query: players who appeared in Big 5 or MLS leagues
  const leaguePlaceholders = BIG5_MLS_LEAGUES.map((_, i) => `$${i+1}`).join(',');
  const priorityWhere = `
    WHERE career_fetched = false
    AND id IN (
      SELECT DISTINCT player_id FROM player_club_stints
      WHERE league_name IN (${leaguePlaceholders})
    )
  `;
  const allWhere = `WHERE career_fetched = false AND id NOT IN (
    SELECT DISTINCT player_id FROM player_club_stints
    WHERE league_name IN (${leaguePlaceholders})
  )`;

  const whereClause = priorityOnly ? priorityWhere : allWhere;
  const whereParams = BIG5_MLS_LEAGUES;

  while (true) {
    const { rows } = await q(
      `SELECT id, api_id, name FROM players ${whereClause} ORDER BY id LIMIT 100`,
      whereParams
    );

    if (!rows.length) {
      await markDone(jobType);
      console.log(`✅ ${label} complete`);
      return true;
    }

    for (const player of rows) {
      console.log(`\n→ ${player.name} (${player.api_id})`);
      try {
        await fetchCareerForPlayer(player, allSeasons);
        total++;
        await saveProgress(jobType, prog, total);
        console.log(`  ✓ [${callsThisRun} calls used]`);
      } catch(err) {
        if (err instanceof BudgetError) {
          console.log(`\n⚠ Budget hit: ${err.message}`);
          await saveProgress(jobType, prog, total);
          return false;
        }
        console.error(`  ✗ ${player.name}: ${err.message}`);
      }
    }
  }
}

// ── TROPHIES ──────────────────────────────────────────────────────────────────
async function runTrophies(priorityOnly = false) {
  const label = priorityOnly ? 'TROPHIES (Big 5 + MLS priority)' : 'TROPHIES (remaining)';
  console.log(`\n════════ ${label} ════════\n`);
  const jobType = priorityOnly ? 'trophies_priority' : 'trophies';
  const job = await getProgress(jobType);
  let total = job.total_processed || 0;

  const leaguePlaceholders = BIG5_MLS_LEAGUES.map((_, i) => `$${i+1}`).join(',');
  const priorityWhere = `WHERE trophies_fetched = false AND id IN (
    SELECT DISTINCT player_id FROM player_club_stints WHERE league_name IN (${leaguePlaceholders})
  )`;
  const allWhere = `WHERE trophies_fetched = false AND id NOT IN (
    SELECT DISTINCT player_id FROM player_club_stints WHERE league_name IN (${leaguePlaceholders})
  )`;
  const whereClause = priorityOnly ? priorityWhere : allWhere;
  const whereParams = BIG5_MLS_LEAGUES;

  while (true) {
    const { rows } = await q(
      `SELECT id, api_id, name FROM players ${whereClause} ORDER BY id LIMIT 200`,
      whereParams
    );
    if (!rows.length) { await markDone(jobType); console.log(`✅ ${label} complete`); return true; }

    for (const player of rows) {
      try {
        const data = await api(`/trophies?player=${player.api_id}`);
        const trophies = data.response || [];

        for (const t of trophies) {
          await q(`
            INSERT INTO player_trophies (player_id, league, country, season, place)
            VALUES ($1,$2,$3,$4,$5)
            ON CONFLICT (player_id, league, season) DO UPDATE SET
              place = EXCLUDED.place, country = EXCLUDED.country
          `, [player.id, t.league||null, t.country||null, t.season||null, t.place||null]);
        }

        await q(`UPDATE players SET trophies_fetched=true, updated_at=now() WHERE id=$1`, [player.id]);
        total++;
        if (total % 100 === 0) {
          await saveProgress(jobType, {}, total);
          console.log(`  ${total} players done [${callsThisRun} calls]`);
        }
      } catch(err) {
        if (err instanceof BudgetError) {
          console.log(`\n⚠ Budget hit: ${err.message}`);
          await saveProgress(jobType, {}, total);
          return false;
        }
        console.error(`  ✗ ${player.name}: ${err.message}`);
        // Mark as fetched anyway so we don't retry forever on bad players
        await q(`UPDATE players SET trophies_fetched=true WHERE id=$1`, [player.id]).catch(()=>{});
      }
    }
  }
}

// ── FIXTURES ──────────────────────────────────────────────────────────────────
// Strategy: iterate league+season combos, fetch all fixture IDs, then
// fetch player stats + events for each fixture
// FIXTURE_LEAGUES now defined as PRIORITY_FIXTURE_LEAGUES in CONFIG

const FIXTURE_SEASONS = [1992,1993,1994,1995,1996,1997,1998,1999,2000,2001,2002,2003,2004,2005,2006,2007,2008,2009,2010,2011,2012,2013,2014,2015,2016,2017,2018,2019,2020,2021,2022,2023,2024];

async function runFixtures() {
  console.log('\n════════ FIXTURES ════════\n');
  const job = await getProgress('fixtures');
  let prog = job.progress || { leagueIdx: 0, seasonIdx: 0, fixtureOffset: 0 };
  let total = job.total_processed || 0;

  const leagueEntries = Object.entries(PRIORITY_FIXTURE_LEAGUES);

  for (let li = prog.leagueIdx; li < leagueEntries.length; li++) {
    const [leagueId, leagueName] = leagueEntries[li];
    for (let si = (li === prog.leagueIdx ? prog.seasonIdx : 0); si < FIXTURE_SEASONS.length; si++) {
      const season = FIXTURE_SEASONS[si];
      console.log(`\n→ ${leagueName} ${season}`);

      try {
        // Fetch all fixture IDs for this league+season
        const fixturesData = await api(`/fixtures?league=${leagueId}&season=${season}`);
        const allFixtures = (fixturesData.response || []);
        console.log(`  ${allFixtures.length} fixtures`);

        const startOffset = (li === prog.leagueIdx && si === prog.seasonIdx) ? prog.fixtureOffset : 0;

        for (let fi = startOffset; fi < allFixtures.length; fi++) {
          const fx = allFixtures[fi];
          const fxApiId = String(fx.fixture.id);

          // Upsert home/away clubs
          let homeId = null, awayId = null;
          if (fx.teams?.home?.id) homeId = await upsertClub(fx.teams.home);
          if (fx.teams?.away?.id) awayId = await upsertClub(fx.teams.away);

          // Upsert fixture
          const fxRes = await q(`
            INSERT INTO fixtures (api_id, league_name, league_country, season_year, match_date, home_team_id, away_team_id, home_score, away_score, status)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
            ON CONFLICT (api_id) DO UPDATE SET
              home_score = EXCLUDED.home_score, away_score = EXCLUDED.away_score, status = EXCLUDED.status
            RETURNING id
          `, [fxApiId, leagueName, fx.league?.country||null, season,
              fx.fixture.date||null, homeId, awayId,
              fx.goals?.home??null, fx.goals?.away??null, fx.fixture.status?.short||null]);
          const fixtureId = fxRes.rows[0].id;

          // Fetch player stats for this fixture
          try {
            const statsData = await api(`/fixtures/players?fixture=${fxApiId}`);
            for (const teamBlock of (statsData.response || [])) {
              const teamApiId = String(teamBlock.team.id);
              const teamRes = await q(`SELECT id FROM clubs WHERE api_id=$1`, [teamApiId]);
              const teamId = teamRes.rows[0]?.id;

              for (const entry of (teamBlock.players || [])) {
                const pl = entry.player;
                const st = entry.statistics?.[0] || {};
                if (!pl?.id) continue;

                // Ensure player exists
                const plRes = await q(`SELECT id FROM players WHERE api_id=$1`, [String(pl.id)]);
                let playerId = plRes.rows[0]?.id;
                if (!playerId) continue; // skip players not in our DB yet

                const games = st.games || {};
                const goals = st.goals || {};
                const shots = st.shots || {};
                const passes = st.passes || {};
                const duels = st.duels || {};
                const cards = st.cards || {};
                const isGk = games.position === 'G';
                const conceded = st.goals?.conceded ?? null;
                const cleanSheet = isGk && conceded === 0 && (games.minutes || 0) >= 60;

                await q(`
                  INSERT INTO player_fixture_stats
                    (player_id, fixture_id, team_id, minutes_played, rating, goals, assists, saves,
                     clean_sheet, yellow_cards, red_cards, shots_total, shots_on_target,
                     passes_total, pass_accuracy, duels_total, duels_won)
                  VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
                  ON CONFLICT (player_id, fixture_id) DO UPDATE SET
                    goals = EXCLUDED.goals, assists = EXCLUDED.assists,
                    saves = EXCLUDED.saves, clean_sheet = EXCLUDED.clean_sheet,
                    yellow_cards = EXCLUDED.yellow_cards, red_cards = EXCLUDED.red_cards
                `, [playerId, fixtureId, teamId,
                    games.minutes||0, parseFloat(games.rating)||null,
                    goals.total||0, goals.assists||0, st.goals?.saves||0,
                    cleanSheet,
                    cards.yellow||0, cards.red||0,
                    shots.total||0, shots.on||0,
                    passes.total||0, parseFloat(passes.accuracy)||null,
                    duels.total||0, duels.won||0]);
              }
            }
          } catch(err) {
            if (err instanceof BudgetError) throw err;
            // Non-fatal: fixture stats unavailable, continue
          }

          // Fetch match events (goals, cards, hat-tricks)
          try {
            const eventsData = await api(`/fixtures/events?fixture=${fxApiId}`);
            for (const ev of (eventsData.response || [])) {
              if (!ev.player?.id) continue;
              const plRes = await q(`SELECT id FROM players WHERE api_id=$1`, [String(ev.player.id)]);
              const playerId = plRes.rows[0]?.id;
              if (!playerId) continue;

              const teamRes = await q(`SELECT id FROM clubs WHERE api_id=$1`, [String(ev.team?.id || 0)]);
              const teamId = teamRes.rows[0]?.id || null;

              await q(`
                INSERT INTO player_match_events (player_id, fixture_id, team_id, type, detail, minute)
                VALUES ($1,$2,$3,$4,$5,$6)
              `, [playerId, fixtureId, teamId, ev.type||null, ev.detail||null, ev.time?.elapsed||null]);
            }
          } catch(err) {
            if (err instanceof BudgetError) throw err;
            // Non-fatal
          }

          total++;
          // Save progress every 10 fixtures
          if (fi % 10 === 0) {
            await saveProgress('fixtures', { leagueIdx: li, seasonIdx: si, fixtureOffset: fi }, total);
          }
        }

        // Season done — reset fixture offset
        prog = { leagueIdx: li, seasonIdx: si + 1, fixtureOffset: 0 };
        await saveProgress('fixtures', prog, total);

      } catch(err) {
        if (err instanceof BudgetError) {
          console.log(`\n⚠ Budget hit: ${err.message}`);
          await saveProgress('fixtures', { leagueIdx: li, seasonIdx: si, fixtureOffset: prog.fixtureOffset || 0 }, total);
          return false;
        }
        console.error(`  ✗ ${leagueName} ${season}: ${err.message}`);
      }
    }
  }

  await markDone('fixtures');
  console.log('✅ Fixtures complete');
  return true;
}

// ── Status ────────────────────────────────────────────────────────────────────
async function printStatus() {
  const { rows: [c] } = await q(`
    SELECT
      (SELECT COUNT(*)::int FROM players)                              AS players,
      (SELECT COUNT(*)::int FROM players WHERE career_fetched)        AS phase2_done,
      (SELECT COUNT(*)::int FROM players WHERE trophies_fetched)      AS trophies_done,
      (SELECT COUNT(*)::int FROM fixtures)                            AS fixtures,
      (SELECT COUNT(*)::int FROM player_fixture_stats)                AS fixture_stats,
      (SELECT COUNT(*)::int FROM player_match_events)                 AS match_events,
      (SELECT COUNT(*)::int FROM player_trophies)                     AS trophies
  `);

  const { rows: jobs } = await q(`SELECT job_type, status, total_processed, last_heartbeat FROM import_jobs ORDER BY job_type`);

  console.log('\n════════ Import Status ════════');
  console.log(`Players:        ${c.players.toLocaleString()}`);
  console.log(`Phase 2 done:   ${c.phase2_done.toLocaleString()} / ${c.players.toLocaleString()}`);
  console.log(`Trophies done:  ${c.trophies_done.toLocaleString()} players → ${c.trophies.toLocaleString()} trophies`);
  console.log(`Fixtures:       ${c.fixtures.toLocaleString()}`);
  console.log(`Fixture stats:  ${c.fixture_stats.toLocaleString()}`);
  console.log(`Match events:   ${c.match_events.toLocaleString()}`);
  console.log('\nJobs:');
  for (const j of jobs) {
    const last = j.last_heartbeat ? new Date(j.last_heartbeat).toLocaleString() : 'never';
    console.log(`  ${j.job_type.padEnd(12)} ${j.status.padEnd(10)} ${String(j.total_processed).padStart(8)} processed  last: ${last}`);
  }
  console.log('');
}

// ── LEAGUES: pull full API catalog ───────────────────────────────────────────
async function runLeagues() {
  console.log('\n======== LEAGUES - API catalog import ========\n');

  let total = 0;

  const data = await api('/leagues');
  const entries = data.response || [];
  console.log(`  ${entries.length} leagues returned from API`);

  {

    for (const entry of entries) {
      const league  = entry.league  || {};
      const country = entry.country || {};
      const seasons = entry.seasons || [];

      await q(`
        INSERT INTO api_leagues (api_id, name, type, country, country_code, logo_url, flag_url, seasons)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
        ON CONFLICT (api_id) DO UPDATE SET
          name         = EXCLUDED.name,
          type         = EXCLUDED.type,
          country      = EXCLUDED.country,
          country_code = EXCLUDED.country_code,
          logo_url     = EXCLUDED.logo_url,
          flag_url     = EXCLUDED.flag_url,
          seasons      = EXCLUDED.seasons,
          updated_at   = now()
      `, [
        league.id,
        league.name         || null,
        league.type         || null,
        country.name        || null,
        country.code        || null,
        league.logo         || null,
        country.flag        || null,
        JSON.stringify(seasons.map(s => s.year)),
      ]);
      total++;
    }

  }

  // Now auto-populate competition_types for any league_name in stints
  // that isn't classified yet, using api_leagues.type as a hint
  const { rows: unclassified } = await q(`
    SELECT DISTINCT s.league_name, s.league_country
    FROM player_club_stints s
    LEFT JOIN competition_types ct ON ct.league_name = s.league_name
    WHERE ct.league_name IS NULL AND s.league_name IS NOT NULL
  `);

  if (unclassified.length) {
    console.log(`
  Auto-classifying ${unclassified.length} unclassified leagues from API metadata…`);
    for (const row of unclassified) {
      const match = await q(`SELECT type FROM api_leagues WHERE name = $1 LIMIT 1`, [row.league_name]);
      const apiType = match.rows[0]?.type || 'League';
      // Map API types to our types
      const compType = apiType === 'Cup' ? 'Domestic Cup' : 'League';
      await q(`
        INSERT INTO competition_types (league_name, competition_type, country)
        VALUES ($1,$2,$3)
        ON CONFLICT (league_name) DO NOTHING
      `, [row.league_name, compType, row.league_country]);
    }
  }

  console.log(`
✅ Leagues import complete — ${total} leagues stored`);
  const { rows: [c] } = await q(`SELECT COUNT(*)::int AS total FROM api_leagues`);
  console.log('   Total in api_leagues table: ' + c.total);
}

// ── Entry point ───────────────────────────────────────────────────────────────
const JOB = process.env.JOB || 'auto';

try {
  if (JOB === 'status') {
    await printStatus();
  } else if (JOB === 'leagues') {
    await runLeagues();
  } else if (JOB === 'phase2') {
    await runPhase2();
  } else if (JOB === 'trophies') {
    await runTrophies();
  } else if (JOB === 'fixtures') {
    await runFixtures();
  } else if (JOB === 'phase2_priority') {
    await runPhase2(true);
  } else {
    // auto: tiered priority order
    await printStatus();

    // ── Tier 1: Big 5 + MLS career histories ─────────────────────────
    if (!await isJobDone('phase2_priority')) {
      console.log('\n▶ Tier 1 — Big 5 + MLS career histories...');
      const ok = await runPhase2(true);
      if (!ok) { console.log('Budget hit — will resume tomorrow.'); process.exit(0); }
    }

    // ── Tier 2: Trophies for Big 5 + MLS players ─────────────────────
    if (!await isJobDone('trophies_priority')) {
      console.log('\n▶ Tier 2 — Trophies for Big 5 + MLS players...');
      const ok = await runTrophies(true);
      if (!ok) { console.log('Budget hit — will resume tomorrow.'); process.exit(0); }
    }

    // ── Tier 3: Fixture stats for Big 5 + European competitions ──────
    if (!await isJobDone('fixtures')) {
      console.log('\n▶ Tier 3 — Fixture stats (Big 5 + European comps)...');
      const ok = await runFixtures();
      if (!ok) { console.log('Budget hit — will resume tomorrow.'); process.exit(0); }
    }

    // ── Tier 4: Career histories for remaining players ────────────────
    if (!await isJobDone('phase2')) {
      console.log('\n▶ Tier 4 — Career histories (remaining players)...');
      const ok = await runPhase2(false);
      if (!ok) { console.log('Budget hit — will resume tomorrow.'); process.exit(0); }
    }

    // ── Tier 5: Trophies for remaining players ────────────────────────
    if (!await isJobDone('trophies')) {
      console.log('\n▶ Tier 5 — Trophies (remaining players)...');
      const ok = await runTrophies(false);
      if (!ok) { console.log('Budget hit — will resume tomorrow.'); process.exit(0); }
    }

    console.log('\n🎉 All tiers complete!');
    await printStatus();
  }
} catch(err) {
  console.error('\nFatal:', err.message);
  process.exit(1);
} finally {
  await pool.end();
}
