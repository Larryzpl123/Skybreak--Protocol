// js/config.js: every tunable number lives here, so balancing never means digging through code.
// Set the tiers first, then fine-tune per unit.

export const CFG = {

  // Build id: the self-check in index.html compares against this. A mismatch means the browser is running stale cached JS.
  // Whenever the code changes, bump this AND __EXPECT_BUILD in index.html.
  build: '2026-11-04b',


  // ---------- Online leaderboard ----------
  // URL of the Cloudflare Worker in leaderboard/ (see leaderboard/SETUP.md), e.g. 'https://skybreak-lb.you.workers.dev'.
  // Empty = no leaderboard: the button and the rank line stay hidden and nothing is ever sent.
  leaderboard: {
    url: '',
  },

  // ---------- World ----------
  world: {
    // 6000 -> 10000 (2026-10-06): players kept hitting the edge. Segments 220 -> 360 keeps the same detail (28 m a cell).
    size: 10000,         // map edge length (square arena; you get pushed back at the edge)
    segments: 360,       // terrain grid segments (130k vertices, built once per map)
    ceiling: 2500,       // highest you can fly (it was 1500); the last ceilingSoft below it gets harder to climb
    ceilingSoft: 400,
    maxHeight: 420,      // tallest peak
    seaLevel: 0,
    fogNear: 900,
    fogFar: 4200,
    treeCount: 900,      // for a 6000 map; scaled with the area (instanced, so a large count doesn't hurt frame rate)
    spawnClearRadius: 700, // flatten the area around spawn so you don't start inside a mountain
  },

  // ---------- Player plane (stock template) ----------
  plane: {
    hp: 150,             // measured: 93% of damage came from enemy fire with no healing at all; 100 hp didn't survive wave 3
    speedMin: 90,        // minimum speed (no real stall model, just clamped)
    speedMax: 320,
    speedBase: 170,      // starting / cruise speed
    throttleAccel: 110,  // throttle acceleration (units/s^2)
    throttleDrag: 40,    // how fast speed returns to cruise when the throttle is released

    pitchRate: 1.6,      // pitch rate (rad/s). Turning around mostly relies on this, so keep it generous.
    rollRate: 2.2,       // roll rate (rad/s)
    yawRate: 0.55,       // direct yaw (for fine trim, deliberately weak)

    // Bank-to-turn coupling: banking automatically yaws the plane. This is what makes arcade flight feel like a plane.
    bankTurn: 1.9,       // bank angle -> yaw rate factor
    maxBank: 1.31,       // max bank of about 75 deg: holding A/D banks to here and stops, so you can't roll past inverted

    radius: 12,          // hit sphere radius
    groundClearance: 14, // closer to the ground than this counts as hitting it
    respawnInvuln: 2.0,  // invulnerability after respawn

    // Ground = crash (see plane.js crash). Tree = lose hull + slow down + the tree gets knocked over, and you keep flying.
    treeDamage: 30,
    treeSlow: 0.75,

    // Collisions need a cooldown, otherwise staying inside the boss applies damage every frame (1800 DPS, instant death).
    ramDamage: 14,       // hitting a small enemy (it explodes too)
    bossRamDamage: 26,   // hitting the boss (you get pushed out)
    ramCooldown: 0.9,
  },

  // ---------- Camera ----------
  camera: {
    fov: 72,
    dist: 46,            // distance behind the tail
    height: 14,          // height above the plane
    lookAhead: 60,       // look-ahead distance in front of the nose
    lerp: 6.5,           // follow smoothing (higher = stiffer)
    rollFollow: 0.35,    // follow only 35% of the roll. Full roll-follow is nauseating; this is the key anti-motion-sickness setting.
    fovSpeedGain: 14,    // wider field of view at higher speed (sense of speed)
  },

  // ---------- Cannon ----------
  gun: {
    damage: 16,          // 12→16
    speed: 900,
    cooldown: 0.09,      // seconds
    life: 2.1,           // 1.6 -> 2.1: measured that 70% of bullets were expiring in flight rather than missing
    spread: 0.006,       // spread (radians)
    radius: 3,
    // Aim assist. Whether 3D shooting is fun depends almost entirely on these numbers.
    // Measured: doubling these took the test bot's accuracy from 5% to 29% and wave clears from 48s to 20s.
    // A human at 14% accuracy deals only 1/7 of nominal damage. That was the real reason players got stuck on wave 3.
    assistRange: 1700,
    assistCone: 0.25,
    // Bullet bending = 0. Playtesting flagged the assist as too visible twice:
    //   first as full homing (bullets could turn 157 deg), then even limited to the first 0.15s it could still bend 30 deg.
    //   The chase camera sits right behind the tail, so that bend is plainly visible. Bending less doesn't fix being visible,
    //   so bullets now fly perfectly straight. Measured wave-clear time went from 24s to 25s: combat pacing barely changed.
    assistTurn: 0,
    assistWindow: 0.15,
    // All forgiveness now comes from the hit sphere padding, the part that is actually invisible.
    // It is very sensitive: 22 -> bot hits 6%, 24 -> 9%, 30 -> 15%. A few units make a cliff, so stay well away from the edge.
    hitPad: 31,
  },

  // ---------- Missiles (from drops) ----------
  missile: {
    damage: 90,
    speed: 420,
    turnRate: 2.2,       // homing turn rate
    life: 5.0,
    cooldown: 0.4,       // 0.8 -> 0.4: missile builds had 30+ missiles they couldn't get off fast enough
    lockRange: 1400,
    lockCone: 0.5,
    startAmmo: 4,
    maxAmmo: 12,
    // Each pylon reloads one missile every reloadPerPylon seconds (up to the rack's capacity).
    // Playtest feedback: pylons were "dead weight" because missiles only came back from rare drops.
    reloadPerPylon: 11,
    // 2026-11-03: pure-missile planes were far weaker than pure-cannon ones at the same load (same frame, 4 seeds of
    // the AI Test: 10 waves vs 22, 10 % duels vs 94 %). With the three changes marked 2026-11-03 (this reload 15 -> 11,
    // bossMul/bossScale below, versus.missileDamage 45 -> 90): 20 vs 22 waves, 74 % vs 94 % duels; a mix of both is
    // as strong as cannons. The AI Ladder keeps the old reload (ladder.reloadPerPylon).
    // A missile used to do 90 at every wave while enemy hp grows 9% a wave, so past wave ~15 a fighter needed two and
    // missile builds hit a ceiling (a player's serious runs: missiles wave 8-11, four cannons wave 35). Now missile
    // damage grows with the wave exactly like enemy hp, so one missile is always worth the same share of an enemy.
    // Bosses are the exception: they take the plain 90 (boss hp grows with the boss level, and with scaled missiles
    // a full rack would erase a late boss in seconds).
    damagePerWave: 0.09,
    // ...and what a missile does to a boss (2026-11-03): damage x bossMul, growing with the boss level like its hull
    // (bossScale), so each boss takes about 6 missiles. A flat 90 meant 12 missiles for the first boss and 31 for the
    // fourth: missile-only planes died at the wave-5 boss every time.
    bossMul: 2,
    bossScale: true,
    radius: 6,
    hitPad: 14,
  },

  // ---------- Enemies ----------
  enemy: {
    fighter: {
      hp: 40,
      speed: 150,
      turnRate: 1.1,
      radius: 14,
      gunDamage: 7,       // 9→7
      gunSpeed: 430,      // 520 -> 430, slow enough to dodge
      gunCooldown: 1.9,   // 1.5→1.9
      gunRange: 1100,
      leadAccuracy: 0.6,  // lead accuracy 0..1 (1 = perfect lead, which gets annoying fast)
      breakOffDist: 260,  // break away when this close
      standoffDist: 360,  // orbit radius for idle enemies (620 -> 360: too far away turns fights into long chases)
      score: 100,
    },

    // ---- Special enemies. `from` = first wave they can appear in (composition: waves.js composeWave). ----
    // Kamikaze drone: small, fast, fragile, never shoots. Dives straight at you and explodes on contact.
    // It uses an attacker slot while diving, so drones can't all dive at once.
    drone: {
      hp: 18, speed: 235, radius: 9,
      ramDamage: 22,      // the explosion when it reaches you
      blastRadius: 45,    // proximity fuse: explodes when this close, so near misses count
      turnRate: 2.6,
      // Inside commitDist it commits and barely steers. Tuned with a timing sweep (40 drones each):
      // flying straight = always hit; constant turning or zigzag = hit about 55%; hard break at 330 = hit 20%;
      // breaking too early (500) or too late (200) = 45 to 50%. Timing the dodge is the skill, shooting it first is the answer.
      commitDist: 150, commitTurn: 0.8,
      score: 80, from: 3,
    },
    // Heavy bomber: slow, tough, big target. A tail turret fires short bursts in any direction.
    // Always drops a power-up. Solid like the boss: ramming it pushes you off instead of trading planes.
    bomber: {
      hp: 170, speed: 95, turnRate: 0.45, radius: 30, orbitDist: 520,
      gunDamage: 6, gunSpeed: 380, gunRange: 950, burst: 3, burstGap: 0.18, burstCooldown: 2.8,
      score: 300, from: 4,
    },
    // Ace: turns hard, leads its shots well, and rolls out of the way when you hold it in your sights.
    ace: {
      hp: 60, speed: 205, turnRate: 1.9, radius: 14,
      // Playtest (wave 12): "harder than the boss". It dodged every 2.6 s, while turning back onto it takes 2 to 3 s,
      // so it was never catchable. Now: a dodge buys you a real window, the dodge is a sidestep rather than an escape,
      // and it only dodges when you are close enough to actually hit it.
      gunDamage: 7, gunSpeed: 470, gunCooldown: 1.4, gunRange: 1200, leadAccuracy: 0.78,
      jinkCone: 0.14,     // it notices you aiming when it sits within this angle (rad) of your nose
      jinkTime: 0.9, jinkCooldown: 5.0, jinkRange: 1000, jinkStrength: 1.1,
      score: 250, from: 6,
    },
    // Shield carrier: never shoots. Keeps its distance and shields every enemy near it
    // (they take only shieldFactor of the damage), so it should be the first thing you kill.
    carrier: {
      hp: 90, speed: 120, turnRate: 0.9, radius: 16, standoffDist: 720,
      shieldRange: 450, shieldFactor: 0.2,
      score: 200, from: 8,
    },

    boss: {
      // WARNING: don't tune this against the test bot. The bot flies straight at the boss, never stops firing and never dodges,
      // so it spends about twice as long on target as a human and systematically overestimates player DPS.
      // Assuming a human spends half the time maneuvering: 37% accuracy x 178 DPS x 0.5 = about 33 effective DPS,
      // so a ~30 second boss fight means roughly 1000 to 1400 hp.
      // Human-style measurement (UPTIME=0.5): 900 -> 22s, 86 hp left / 1100 -> 28s, 67 left / 1300 -> 44s, 27 left / 1800 -> always dies.
      // 1000 gives about a 25 second fight, with margin for the two escorts you also have to deal with.
      hp: 1000,
      // Each later boss is tougher and fires faster (the first boss, the one new players meet, is unchanged).
      // Playtest: the wave-10 boss felt too easy. Boss k: hp x (1 + (k-1) x levelHp), fire rate x (1 + (k-1) x levelFire)
      levelHp: 0.6, levelFire: 0.15,
      halfHealthSupply: true,  // drop supplies at half health, to give a comeback moment
      speed: 55,
      radius: 70,
      hoverHeight: 520,
      standoffDist: 700,  // the distance it keeps. It used to close in to 260, which put a 70-radius disc right in your face.
      score: 2500,
      // three attack patterns, matching the original UFO's bullets / rockets / blades
      // Boss damage has to leave room for an actual fight. At 12 damage a player only survived about 10 seconds in front of it,
      // so going past 1150 hp dropped straight from 12/12 wins to 0/12: a difficulty cliff with no middle ground.
      volleyCooldown: 2.6,
      ringCooldown: 6.0,
      homingCooldown: 4.2,
      bulletDamage: 7,
      bulletSpeed: 300,
    },
  },

  // ---------- Waves ----------
  wave: {
    baseCount: 2,        // enemies in wave 1 (3 -> 2, a gentler start)
    countPerWave: 0.8,   // added per wave (1.1 -> 0.8, a slower ramp)
    maxCount: 14,
    bossEvery: 5,        // a boss every 5 waves
    hpScale: 0.09,       // enemy hp +9% per wave
    spawnDist: 1600,     // spawn distance from the player
    breakTime: 3.0,      // pause between waves (a breather)
    clearHeal: 25,       // heal on wave clear: gives the game a rhythm, and it's the only reliable source of healing

    // Max simultaneous attackers: there can be many enemies, but only this many may fire; the rest circle outside.
    // This decouples enemy count from bullet density. Without it, difficulty grows linearly and explodes.
    maxAttackers: 2,
    attackerEveryWaves: 3,  // +1 attacker slot every 3 waves
    maxAttackersCap: 5,
  },

  // ---------- Drops ----------
  // ---------- Versus (PvP): 2 to 4 players, every pilot for themselves ----------
  // No AI enemies. First to killsToWin, or the most kills when the time runs out. Everyone respawns after a short
  // wait. Weapons are toned down against players (a plane has 150 hull, a PvE missile does 90), so a fight lasts
  // long enough to out-fly someone instead of being decided by one missile.
  versus: {
    killsToWin: 5,
    timeLimit: 300,        // seconds
    respawnDelay: 3,
    spawnRadius: 1100,     // spawn points on a circle around the middle of the map, facing inward
    gunMul: 0.6,           // cannon damage x0.6 against players
    missileDamage: 90,     // 45 -> 90 (2026-11-03): a missile-only plane could hardly win a duel (10 %). Missiles homing
                           // on you now show a warning (MISSILE + distance + an arrow): a hard turn when you see it
                           // shakes one off (tested: breaking even at 300 m dodged every launch from 300 to 1400 m)
    missileTurnMul: 0.6,   // missiles turn slower: a hard break can shake them off
    ramDamage: 30,
    creditWindow: 8,       // crash within 8 s of being hit = the last one who hit you gets the kill
    // A game in a background tab stops running, and since only your own game counts hits on your plane, a hidden
    // tab made you unhittable (reported by a player: it was used to force draws). Now: a pilot whose game is quiet
    // for quietAfter seconds pauses the match for everyone; back within awayLimit seconds and it goes on (a phone
    // that slipped out of a hand is fine), otherwise they left (a loss). pauseBudget caps the total pause one pilot
    // can cause in a match, so nobody can stall the game with pause after pause.
    quietAfter: 2,
    awayLimit: 30,
    pauseBudget: 60,
    dropEvery: 12,         // a power-up appears near the fight every 12 s (at most maxDrops at a time)
    maxDrops: 3,
    dropWeights: { heal: 4, missile: 2, shield: 2, rapid: 2, double: 2, afterburner: 1 },
  },

  // ---------- AI Ladder: 1v1 against an AI pilot, level after level ----------
  // First to killsToWin wins the level. A loss just means trying that level again (progress is kept).
  // The AI's skill (aim, reactions, turning, dodging, flares, missiles) grows up to skillCap; past it, only its hull
  // and gun damage keep growing (see js/ladder.js aiSkill). Each kill is a round: both planes start fresh.
  ladder: {
    killsToWin: 3,
    roundDelay: 2.5,       // seconds between a kill and the next round
    roundTime: 60,         // a round still going after this long is a draw and is flown again (only kills win rounds)
    startDist: 900,        // the AI starts this far to one side, flying the same way as you
    ramDamage: 30,
    // How far along its skill the AI is at each level: [level, 0..1], straight lines in between, 1 from skillCap on.
    // First playtest (the best pilot on the board): levels 1-15 all 3-0, level 16 the first real fight. So the early
    // levels now climb faster (old level 14 is about level 10) and the skill keeps growing to level 30, not 20.
    skillAt: [[1, 0], [5, 0.4], [10, 0.7], [15, 0.84], [20, 0.92], [25, 0.97], [30, 1]],
    // level 1 -> skillCap (tuned with test/ladder_sim.mjs)
    hp: [117, 273],         // (x0.65 on 2026-10-06: since flares beat missile salvos, the stock plane's missiles count for less)
    turn: [1.0, 2.0],
    gunEvery: [0.22, 0.09],
    react: [0.9, 0.15],    // seconds to settle on a new heading: by far the strongest knob
    gunDmg: [4, 6],
    // Top speed. It used to reach 260 (a stock fighter cruises at 170): the AI kept pulling away and chasing it
    // with the camera was tiring. Now at most 215; the higher levels are hard through aim and reactions instead.
    speed: [170, 215],
    reloadPerPylon: 15,    // missile reload in the ladder: the pre-2026-11-03 value its levels were tuned with
    flareBurn: 1.0,        // seconds a flare keeps decoying missiles that come close (one decoys all of a salvo)
    missileMul: 0.8,         // missile damage in the ladder (x the normal 90)
    skillCap: 30,
    hpPerLevel: 0.08,      // past skillCap: +8 % hull per level
    dmgPerLevel: 0.04,     // past skillCap: +4 % gun damage per level
  },

  drop: {
    chance: 0.28,        // drop chance per kill
    life: 22,            // seconds before it disappears
    pickupRadius: 55,    // generous pickup radius, just fly through it
    fallSpeed: 55,

    // Drops must rest at a SAFE flying height. They used to stop 30 above the ground while a crash triggers at 26,
    // so collecting a supply meant flying below the crash line first: trading your life for health, a self-contradicting design.
    hoverAboveGround: 170,
    magnetRange: 420,    // drifts toward the player when close, so you don't need to aim at it
    magnetSpeed: 130,
    // Drop table as weights. Repair is kept at exactly 1/3 of all drops (5 of 15): healing matters most,
    // so adding new power-ups must never make repairs rarer.
    weights: { heal: 5, missile: 2, double: 2, rapid: 2, shield: 2, emp: 1, afterburner: 1 },
    doubleDuration: 12,  // twin cannon duration in seconds
    healAmount: 35,
  },

  // ---------- Power-up effects ----------
  power: {
    shieldHp: 60, shieldTime: 10,       // absorbs up to 60 damage (bullets, collisions, trees), for 10 s
    rapidTime: 10, rapidMul: 0.5,       // cooldown x0.5 = double fire rate (cannon, or missiles for a missile plane); stacks with twin cannon
    empRadius: 700, empDamage: 60,      // damages every enemy within 700 (the carrier shield still applies)
    empClearRadius: 1200,               // and deletes every enemy bullet within 1200
    burnTime: 8, burnMul: 1.3,          // afterburner: top speed, cruise speed and turn rates x1.3
  },
};
