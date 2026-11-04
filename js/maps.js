// js/maps.js: which map a run is flown on. A map = { biome, seed, weather, daily, day }.
// Ranked runs always use today's map (same for everyone, picked from the UTC date), so leaderboard scores compare
// like with like. Every other choice in the hangar (random map, a specific map type) is for fun and never ranked.

import { BIOMES, BIOME_KEYS, OLD_BIOME_KEYS } from './terrain.js';
import { WEATHER, pickWeather } from './weather.js';

// FNV-1a: turns the date string into a well mixed 32-bit number
function hashStr(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}

export const dayString = (d = new Date(Date.now())) => d.toISOString().slice(0, 10);   // UTC, e.g. "2026-09-29"

// The first rule picked each day's map type at random, so the same type could come up two days running
// (players saw Desert two days in a row and didn't want to). From NEW_RULE_FROM on, a day never repeats the map type
// of the two days before it, nor yesterday's weather. Days before that keep the map they had (scores were set on them).
export const NEW_RULE_FROM = '2026-10-01';
// The city joins the daily maps from this day (earlier days keep the maps they had: their scores were set on them)
export const CITY_FROM = '2026-10-07';
const typesOn = day => (day >= CITY_FROM ? BIOME_KEYS : OLD_BIOME_KEYS);

function firstRule(day) {
  const h = hashStr('skybreak:' + day);
  const biome = OLD_BIOME_KEYS[h % OLD_BIOME_KEYS.length];
  const seed = 1 + ((h >>> 4) % 99991);
  const weather = pickWeather(biome, ((h >>> 12) % 1000) / 1000);
  return { biome, seed, weather, daily: true, day };
}
const nextDay = d => new Date(Date.parse(d + 'T00:00:00Z') + 86400000).toISOString().slice(0, 10);
const prevDay = d => new Date(Date.parse(d + 'T00:00:00Z') - 86400000).toISOString().slice(0, 10);

// one day under the new rule, given the two days before it
function newRule(day, prev1, prev2) {
  let h = hashStr('skybreak:' + day);
  if (day >= CITY_FROM) {
    // FNV's low bits are weak: with 4 map types to pick from (6 minus the last two), h % 4 gave Forest and City
    // nearly twice the days of the others. Mixed first, it is even. (Earlier days keep their maps.)
    h = (h ^ (h >>> 16)) >>> 0; h = Math.imul(h, 0x45d9f3b) >>> 0; h = (h ^ (h >>> 16)) >>> 0; h = Math.imul(h, 0x45d9f3b) >>> 0; h = (h ^ (h >>> 16)) >>> 0;
  }
  const types = typesOn(day).filter(b => b !== prev1.biome && b !== prev2.biome);
  const biome = types[h % types.length];
  const seed = 1 + ((h >>> 4) % 99991);
  const r = ((h >>> 12) % 1000) / 1000;
  let weather = pickWeather(biome, r);
  // not the same weather as yesterday (a sandstorm in the canyon right after one in the desert), if this map type has another
  for (let k = 1; k < 8 && weather === prev1.weather; k++) weather = pickWeather(biome, (r + k * 0.37) % 1);
  return { biome, seed, weather, daily: true, day };
}

// every day depends on the two before it, so days are worked out in order from NEW_RULE_FROM and remembered
const days = new Map();
export function mapForDay(day = dayString()) {
  if (day < NEW_RULE_FROM) return firstRule(day);
  if (!days.has(day)) {
    let d = NEW_RULE_FROM, p2 = firstRule(prevDay(prevDay(d))), p1 = firstRule(prevDay(d));
    for (let i = 0; i < 20000; i++) {             // (20000 days = 55 years; just a guard against bad input)
      if (!days.has(d)) days.set(d, newRule(d, p1, p2));
      if (d >= day) break;
      p2 = p1; p1 = days.get(d); d = nextDay(d);
    }
  }
  return { ...days.get(day) };
}

export function randomMap(biome = null, rand = Math.random) {
  const b = biome && BIOMES[biome] ? biome : BIOME_KEYS[Math.floor(rand() * BIOME_KEYS.length)];
  return { biome: b, seed: 1 + Math.floor(rand() * 99991), weather: pickWeather(b, rand()), daily: false, day: null };
}

// training is always the original forest in clear weather
export const TRAINING_MAP = { biome: 'forest', seed: 0, weather: 'clear', daily: false, day: null };

export const mapLabel = m => `${BIOMES[m.biome].name} · ${WEATHER[m.weather].name}`;
