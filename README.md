# Skybreak Protocol

A 3D air-combat shooter where you **build your own plane out of blocks**, and the plane flies the way you built it.

Endless waves of five enemy types, seven kinds of power-ups, and a boss every five waves.
Runs in the browser. No build step, no install beyond Python 3 (already on every Mac).

---

## ▶️ Play

**macOS:** double-click `start.command`. It starts a small local server and opens the game in your browser.

**Any system:**

```bash
python3 server.py 8765
```

then open <http://localhost:8765>.

> Opening `index.html` directly (as a `file://` page) will not work: three.js ships as ES modules,
> which browsers block on `file://`. The local server fixes that, and it also writes your `save.txt`.

**First time?** The game starts with a short **flight training**: each step waits until you have actually done it
(climb, turn, shoot a target, fire a missile, grab a power-up). `Esc` skips it; the hangar's **Training** button replays it.

---

## 🛠️ The Hangar

After training, the game opens in the hangar. Build a plane, or start from one of **10 sample planes**, then hit **SORTIE**.
Feeling lucky? **Random sample plane** picks one of the 10 at random and loads it into the hangar, so you can fly it as is or modify it first.
Press **SORTIE (PLAY)** to take off.

| Input | Action |
|---|---|
| Left-click | Place the selected part on the face you're pointing at |
| Right-click | Remove a part |
| Drag / Wheel | Rotate / zoom the view |
| `1`-`7` | Pick a part |
| `M` | Mirror mode (on by default: builds both sides at once) |
| `T` | Test flight: fly the plane with no enemies, crashes are free, nothing is recorded (`H` to come back) |
| `Enter` | Sortie |

### How building works

Two limits keep builds honest:

1. **Load budget.** The Core gives you 120 load and every part costs some. You can't just keep building bigger.
2. **The shape decides the stats.** Nothing is picked from a menu. The game reads your plane:

| What you build | What it does |
|---|---|
| Thrust ÷ weight | Top speed and acceleration |
| Weight ÷ wing area (*wing loading*) | How tight you turn, and how slow you can fly |
| Center of mass vs. center of lift | Too much weight at the back and the nose keeps rising; too much at the front and it keeps dropping |
| Weight far out on the wings | Slower rolls |
| Heavier on one side | The plane leans and drifts that way |
| Size | A bigger plane is a bigger target |
| Number of cannons | More firepower, with diminishing returns |

**Creative mode** (button under the load bar) removes the load budget and the build area, so you can build with many
more parts (up to 300) and as big as you like (zoom out further to see it all). Physics still applies: too heavy for
the engines or the wings and it won't take off. Creative planes over the normal budget or outside the normal build area
fly normal games, but those runs are **not ranked or saved**.

**Share a plane:** **Share / import plane** (under My planes) gives a **6-letter code** and a short link. A friend types
the code under **Load a shared plane** (or just opens the link) and your plane is in their hangar; **Save as...** keeps
it. Each pilot keeps up to 10 shared codes (sharing an 11th retires the oldest).

The **Flight Data** panel shows every number live, as a percentage of the Stock Fighter.
The gold dot is your center of mass and the cyan ring is your center of lift. Keep the dot slightly ahead of the ring.

### Parts

| Part | Load | What it's for |
|---|---|---|
| Core | 0 | Cockpit. Sets the load budget. Every plane has exactly one. |
| Frame | 3 | Light structure that connects things |
| Wing | 4 | Wing area: turning and slow-speed flight |
| Propeller | 8 | Cheap, light thrust; runs out of push at high speed |
| Jet Engine | 16 | Heavy, but keeps pushing at high speed |
| Cannon | 14 | One more gun |
| Missile Pylon | 8 | +4 missile capacity, and reloads missiles in flight (each pylon: one every 11 s; 15 s in the AI Ladder). Missile damage grows with the wave like enemy hull does, so one missile always downs a fighter; against a boss it grows with the boss level, so every boss takes about 6 missiles |
| Armor | 6 | Lots of hull, lots of weight |

### Sample planes

| Plane | Character |
|---|---|
| Stock Fighter | The all-rounder, and the 100% baseline everything is compared to |
| Interceptor | Twin jets. Fastest in the hangar, light on guns |
| Gunship | Three cannons and armor. Hits hard, turns wide |
| Prop Trainer | Cheap propeller plane, nimble and forgiving |
| Biplane | Stacked wings. The tightest turner, and slow |
| Missile Boat | Four pylons, twenty missiles |
| Flying Fortress | Heavily armored, twin wing-mounted propellers |
| Strike Fighter | Wing-pod jets and two guns |
| Long-Wing Scout | The longest wings and twin guns: the tightest-turning jet, but rolls slowly |
| Delta Dart | Delta wing, two guns, a sharp all-rounder |

---

## ✈️ Flight

| Key | Action |
|---|---|
| `W` / `S` | Pull up / dive |
| `A` / `D` | Bank (**hold to turn**) |
| `Q` / `E` | Yaw trim |
| `Shift` / `Ctrl` | Throttle up / down |
| `Space` | Cannon |
| `F` | Missile (needs a lock). Hold it to fire a salvo: each missile picks a target the ones already in the air won't kill |
| `Esc` / `P` | Pause. **Resume** comes back after a 3-2-1 countdown; **Restart** and **End run** need two clicks and count like being shot down (the run is saved and counts for the leaderboard like any other). The game also pauses when you switch away from it. Multiplayer has no pause button: the others are still playing |
| `R` | Fly again, same plane |
| `N` | Fly again with a random plane |
| `H` | Hangar (change / edit / rebuild your plane) |

### On a phone or tablet

**Best: add it to your Home Screen** so it opens full screen, with its own icon and no address bar
(the game shows these steps once; the hangar's **Full screen** button shows them again):

| iPhone / iPad (Safari) | Android (Chrome) |
|---|---|
| 1. Tap **···** next to the address bar (or the **Share** button), then **Share** | 1. Tap **⋮** (top right) |
| 2. Scroll down, tap **Add to Home Screen** | 2. Tap **Add to Home screen** (or **Install app**) |
| 3. Keep **Open as Web App** on, tap **Add** | 3. Tap **Install** / **Add** |

Play sideways. **Rotation lock can stay on**: the game turns itself, so just hold the phone sideways. It uses the motion
sensor to tell which way you are holding it; if it is upside down, tap **Flip**.

A **stick** (bottom left) flies the plane: up = pull up, sideways = bank. On the right: **FIRE** (hold),
**MISSILE** (shows how many are left), and **FASTER / SLOWER** for the throttle. **Pause** is at the top. **Tilt: ON** (top) switches to
steering with the phone: turn it like a steering wheel to bank, pull the top toward you to climb (**Climb** flips
that), and **Recenter** makes the way you hold it now "level". In the hangar, tap a face to add a part, turn on
**Remove** to tap parts away, drag to rotate and pinch to zoom.

**Shoot the gold ring, not the enemy.** It shows where the target *will be* when your bullets arrive.

**Turning hard:** hold `A` or `D` to bank, then hold `W` to pull through the turn.

**The ground is fatal.** Trees aren't: you'll plough through them, but they cost hull and slow you down.
Watch for the **PULL UP** warning.

### Sound and graphics

- **Sound** is made in the browser (nothing to download): engine, cannon, missiles, explosions, hits, power-ups,
  and a beep when a missile is homing on you in Versus. It starts with your first click or key press (browsers
  require that). **Sound: ON/OFF** in the hangar's top bar and on the pause screen.
- **Graphics: Auto / High / Low** in the hangar. High adds a gradient sky, clouds, the sun, smoke from explosions
  and longer missile trails. Auto uses High, measures the frame rate a few seconds into a flight, and switches this
  device to Low if it runs under 45 fps or stutters. The pause screen shows the frame rate and what Auto picked.
- Explosions, muzzle flashes and warnings are kept modest on purpose: no bright flashes, and nothing blinks more
  than twice a second (fast flashing can trigger photosensitive epilepsy).

### Maps and weather

Six kinds of terrain, each generated fresh from a seed: **Forest**, **Desert** (dunes), **Snow Peaks** (tall and steep),
**Islands** (open sea: the water is as solid as the ground), **Canyon** (a high plateau cut by deep canyons) and
**City** (street grid with parks, towers up to about 650 m downtown; flying into a building is a crash).
Each map grows its own trees: pines in the forest, snowy firs on the peaks, cacti in the desert, palms on the
islands, junipers on the canyon floors and utility poles along the city streets (all of them cost hull if you hit them).
Each map is 10 km across. You can climb to 2500 m: in the last 400 m the plane climbs less and less, then stops.
The whole plane touches the ground, not just its middle: a wing tip, the nose or the tail in the ground (or a building) is a crash.
Each comes with its own weather:

| Weather | Where | Effect |
|---|---|---|
| Clear | Forest, Desert, Canyon, City | - |
| Fog | Forest, City | Visibility drops: enemies (and your missile lock) reach 60% as far |
| Rain / Snow | Forest, Islands, City / Snow Peaks | Slightly shorter visibility, light wind |
| Thunderstorm | Islands | Wind, plus lightning: a glowing pillar and rings mark where a bolt lands 1.3 s later. Fly out of the rings |
| Sandstorm | Desert, Canyon | Strong gusting wind pushes you sideways, visibility 60% |
| Blizzard | Snow Peaks | Strong wind, low visibility |

Weather affects you and the enemies equally. **Today's map** (picked from the date, the same for everyone, changes at
midnight UTC, never the same map type as the two days before or yesterday's weather) is the ranked one; in the hangar you can also pick a random map or a map type just for fun.

### Enemies

New types join as the waves go on. The first time one appears, the game tells you what it does.

| Enemy | From wave | What to do |
|---|---|---|
| Fighter | 1 | Chases you and leads its shots. Only a few enemies may fire at once; the rest circle and wait |
| Kamikaze Drone | 3 | Fast, fragile, dives at you and explodes. Its marker blinks while it dives: shoot it on the way in, or break hard at the last moment |
| Heavy Bomber | 4 | Slow and tough, with a tail turret. Always drops a power-up |
| Ace | 6 | Turns hard and aims well. Rolls out of your sights when you line up on it, so lead generously |
| Shield Carrier | 8 | Never shoots, but enemies near it take only 20% damage (blue bubble). Kill it first |
| UFO Boss | 5, 10, 15... | Three attack patterns. Drops supplies at half health |

### Power-ups

Shot-down enemies sometimes drop a spinning crystal. Fly through it (it drifts toward you when close).
Repair is always one third of all drops.

| Color | Power-up | Effect |
|---|---|---|
| Green | Repair | +35 hull |
| White | Missiles | +3 missiles |
| Gold | Twin Cannon | Two bullets per shot, 12 s. A plane with missile pylons and no cannon gets **Missile Pairs** instead: every other missile launch fires two (the second one is free). Cannons and pylons: either one, 50/50 |
| Orange | Rapid Fire | Double fire rate, 10 s (stacks with Twin Cannon). Pylons and no cannon: **Rapid Missiles** (half the time between missiles) instead. Cannons and pylons: either one, 50/50 |
| Blue | Shield | Absorbs 60 damage, 10 s (not the ground) |
| Purple | EMP | Wipes nearby enemy bullets and damages nearby enemies |
| Red | Afterburner | +30% speed and turn rate, 8 s |

Active power-ups show under your hull bar; power-ups on the radar are small colored squares.

---

## 💾 Saving

Progress is written to **`save.txt`** in the game folder: best score, best wave, stats for each plane you've flown,
and the planes you've saved in the hangar (**Save as…**).

It's plain, readable JSON. Back it up, or send it to a friend to share your planes.
When the game is played from a website (GitHub Pages, itch.io...), progress is saved in the browser instead,
separately for every player. A `save.txt` uploaded to the website by mistake is ignored.

### Online leaderboard

When the game is set up with a leaderboard server, every run on **today's map** lasting 30 seconds or more (with at
least one kill) is sent to a shared **Top 100**, with two boards: **Today's map** (everyone on the same map) and
**All time**, plus **Week**, **Month** and **Year** (best runs on the daily maps in that period, Monday to Sunday for
the week, everything since the first day counts). Each pilot appears once per board, with their best run: score, wave,
plane, time survived and date.

Nobody types a name. Each browser gets a pilot number in order of arrival (#1, #2, #3...) and a random callsign
such as *Crimson Falcon*, which you can reroll as often as you like and never write yourself, so the board can't
contain anything rude. The first time you open the hangar you pick one; when you like it, **lock it in**: from then on it is yours and
can't change. Only locked-in pilots are listed, so a name on the board never changes. Runs you fly before locking in
are kept and show up the moment you lock.
**By plane:** one more tab with a board for each sample plane and one for planes of their own (Custom): every pilot's
best run in that plane, runs from before the tab existed included. The hangar card also says how many more points
pass the pilot just above you on the all-time board.

**Backup code:** your pilot lives in this browser. The leaderboard window's **Backup code** button shows a code to keep
(privately: whoever has it can fly as you); paste it on another browser or device to keep the same pilot, number and
board places. A private / incognito window forgets its pilot when it closes, so save the code first.

Training and test flights never count. The server is a single Cloudflare Worker (free tier); its code is not in
this repository, since its checks are what keeps the boards fair. With no server URL in `js/config.js` the feature
simply stays hidden.

**Copy a plane from the board:** runs on the score boards (today, week, month, year, all time) keep the plane they
were flown in, and a **Copy** button next to it loads that plane into your hangar (named after its pilot; Save as...
keeps it). Only the parts are stored, never the name the pilot gave it, so no typed text reaches the board.

**Creative board** (just for fun): a plane over the load budget or the build area never goes on the boards above,
but its runs on today's map go on their own **Creative** tab, with the **load** the plane carried. No points-per-second
limit there; the same checks otherwise.

Every ranked run asks the server for a take-off ticket when it starts and sends it with the score, so a run
offline at take-off is not ranked (the death panel says so).

### AI Test and Design Duel

In the hangar, under FLIGHT DATA:

- **AI test**: a computer pilot flies the plane you are building, with its real handling, guns, missiles and hull.
  It flies the normal waves, and duels against each of the 10 sample planes (the same pilot flying both sides, versus
  rules). Two grades come out, from F to SSS: **Waves** and **Duels**. The stock fighter is a C on both. It takes a few
  seconds, always gives the same plane the same grades, and is local only: nothing is sent and nothing is ranked.
- **Design duel**: pick any two planes (this one, your saved planes, the sample planes, or a plane code) and they
  fight 20 duels, both flown by the same computer pilot, so the designs decide.

The computer pilot aims better and never panics, so it gets a little more out of heavy firepower than a person does,
and a little less out of agility (it never dodges on purpose).

### AI Ladder

The **AI Ladder** button (next to Sortie) is a 1v1 against an AI pilot, in your own plane:

- **First to 3 kills** wins the level. Every kill is a round; both planes start fresh for the next one, side by side. A round still
  going after 60 seconds is a draw and is flown again: only kills win rounds.
- **Win: the next level unlocks. Lose: just try that level again**, as often as you like. The button always carries
  on from the highest level you have cleared.
- Every level the AI flies better: it aims and leads its shots better, reacts faster, turns harder, and works its way
  onto your tail. From level 3 it drops **flares**: one flare decoys every missile chasing it close by, so spread your
  missiles out instead of firing a whole rack at once (your missiles refill only after a round you lost). From level 4 it dodges when you
  hold it in your sights, from level 7 it fires missiles of its own. Its plane and rank change too (Rookie in a Prop
  Trainer at level 1, Phantom in a Delta Dart from level 28). Past level 30 its skill stays the same but its hull
  and guns keep getting stronger, so the ladder never ends.
- Each level has its own map, always in clear weather. No power-ups: just you and the AI.
- The **AI Ladder** tab on the leaderboard ranks pilots by the highest level cleared (who got there first breaks a
  tie). It never touches your Elo. At most 15 levels a day count on the board.

**Copy stats** (in the hangar) copies your last 20 runs as plain text: plane, layout, wave, score, time, accuracy,
cause of death and where the damage came from. Runs shorter than 30 seconds are left out, so quick test crashes
don't skew the numbers. Handy for comparing builds, or for sending feedback.

---

## 📁 Structure

```
index.html        page shell, HUD, hangar UI
start.command     macOS launcher
server.py         local server: serves the game, writes save.txt
js/main.js        game loop, hangar ⇄ flight
js/hangar.js      the hangar (view + input only)
js/parts.js       part catalog, stats derived from the build
js/spec.js        build stats → flight parameters
js/blueprint.js   sample planes, placing/removing parts
js/struts.js      auto-generated struts, so parts never float
js/partMesh.js    turns a blueprint into a 3D model
js/plane.js       flight model
js/weapons.js     cannon, missiles, enemy fire
js/effects.js     explosions, missile trails, muzzle flashes
js/sound.js       all sound (Web Audio, generated in the browser)
js/sky.js         gradient sky, clouds and sun (high graphics)
js/quality.js     graphics setting and the frame-rate check
js/rand.js        the simulation's random source (fixed for the AI Test)
js/enemies.js     all enemy types and the UFO boss
js/waves.js       waves and drops
js/terrain.js     the six terrain types (seeded heightmaps, city blocks), water and trees
js/hud.js         HUD, radar, off-screen markers
js/save.js        save.txt + browser fallback
js/powerups.js    power-up table, effects, shield/EMP visuals
js/tutorial.js    flight training + hangar tips
js/leaderboard.js online leaderboard client
js/weather.js     weather: particles, fog, wind, lightning
js/maps.js        today's map, random maps
js/config.js      every tunable number in one place
```

No dependencies besides [three.js](https://threejs.org), loaded from a CDN. No build step.

*Inspired by UFO Attack, an earlier 2D shooter by the same author. The first boss is that UFO.*

---

## 👥 Multiplayer (2 to 4 players)

In the hangar, press **Multiplayer (2-4)** next to the map. Three ways in:

- **Quick match**: a rated 1v1 versus match against whoever else is searching. Close ratings are paired first; the
  longer you wait the wider it looks (anyone after 30 seconds). The window shows how many pilots are searching right
  now. Once paired, the match starts by itself.
- **Create a room**, **Team (co-op)** or **Versus (PvP)**. It is listed in **Open rooms** for anyone to join (untick
  the box to keep it private); friends can also type its 4-letter code. When everyone is in, the host presses **Start**.
- **Open rooms**: rooms waiting for players, one tap to join.

Everyone flies the plane that is in their own hangar, on the map the host picked.
`Esc` twice leaves (on a phone: **Leave**, top right; while you are down there is also a **Leave** button).
If the host leaves, the game ends for everyone.

### Team (co-op)

- One team, one score. Each wave has as many enemies as a solo wave times the number of players, and every enemy
  goes after whichever player is closest.
- Go down and you watch a teammate until the next wave starts, then you are back at full hull. When the whole team
  is down, the run is over; the host can **Play again** with the same team.
- Co-op runs are not ranked or saved.

### Versus (PvP)

- Every pilot for themselves, no AI enemies. **First to 5 kills** wins, or the most kills when the **5 minutes** are up
  (fewer deaths breaks a tie).
- Shot down: you watch whoever got you, and you are back in the air 3 seconds later, away from the others.
  Crashing within 8 seconds of being hit gives the kill to whoever hit you last.
- Against players the cannon does 60% damage and a missile does 90. A missile homing on you shows a warning: **MISSILE**
  and its distance under the crosshair, an arrow around the crosshair pointing to it, and a red dot on the radar. A hard
  break when you see it shakes it off. A power-up appears near the fight every 12 seconds.
- **Rating (Elo):** everyone starts at 1000. A 1v1 between equals moves 16 points each way; beating someone rated
  higher gains more. With 3 or 4 pilots every pair counts as one game. A match is rated when every pilot has a
  pilot number and flies a normal plane (no Creative plane over the limits); the room says whether it is.
  Both games send the final table and the server counts it once two of them agree. The leaderboard has a
  **Versus (Elo)** tab.
- **Leaving a rated match counts as a loss.** A browser can always be closed, so leaving can't be blocked; instead
  whoever leaves (button, `Esc`, closing the tab, losing the connection, or the host quitting) is placed last, and the
  pilots who stayed confirm the result on their own. The game warns before you leave. Leaving co-op or an unrated
  match costs nothing.
- Hiding the game (switching tabs or apps, locking the phone) stops it, so the match **pauses for everyone** with a
  countdown: nobody moves, shoots or gets hit, and the clock stops. Back within **30 seconds** and it goes on (a phone
  that slipped out of your hand is fine); otherwise that pilot counts as having left. One pilot can pause for at most
  60 seconds in total per match, so nobody can stall the game.

The host's browser runs the enemies (co-op) and keeps the score (versus), so the host should keep the game tab in
front. Players connect directly to the host (WebRTC); the leaderboard server only passes the connection details.
Some strict networks (certain school or phone networks) block direct connections, and then joining fails with a
message saying so.

