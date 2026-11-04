// js/rand.js: the random source of the flight simulation (enemies, waves, weapons, power-ups).
// In play it is just Math.random. The AI Test (planetest.js) swaps in a seeded one for itself only, so the same plane
// always gets the same grade. It used to swap Math.random itself, but three.js calls Math.random for the id of every
// object it creates, and some are created only the first time they are needed: those calls ate into the seeded
// sequence, so a plane's grade depended on what had been played before the test.
// (null = whatever Math.random is at the moment of the call, so code and tests that replace Math.random still work)
let source = null;
export const rand = () => (source ? source() : Math.random());
// fn: the new source (null = Math.random again) -> the previous one
export function setRand(fn) {
  const old = source;
  source = fn || null;
  return old;
}
