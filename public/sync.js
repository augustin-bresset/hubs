// Calculs de synchronisation sans dépendance au navigateur (testés sous Node).

const MAX_CLOCK_DRIFT = 5e-4; // 500 ppm : au-delà, la pente estimée est du bruit

// Modèle d'horloge : heure serveur = heure locale + a + b * (heure locale - t0).
// `samples` : allers-retours { at, offset, rtt } du plus ancien au plus récent (ms).
// On ne garde que les allers-retours les plus courts (les moins asymétriques) et on y ajuste
// une droite, ce qui suit la dérive entre les deux horloges au lieu de sauter d'une mesure à l'autre.
export function fitClock(samples) {
  const byRtt = [...samples].sort((p, q) => p.rtt - q.rtt);
  const best = byRtt[0];
  const good = byRtt.slice(0, Math.max(8, Math.ceil(0.3 * byRtt.length)));
  const t0 = samples[samples.length - 1].at;
  const times = good.map((s) => s.at);
  if (good.length < 8 || Math.max(...times) - Math.min(...times) < 15000) {
    return { a: best.offset, b: 0, t0, rtt: best.rtt };
  }
  const n = good.length;
  const mx = good.reduce((sum, s) => sum + (s.at - t0), 0) / n;
  const my = good.reduce((sum, s) => sum + s.offset, 0) / n;
  let sxx = 0, sxy = 0;
  for (const s of good) {
    sxx += (s.at - t0 - mx) ** 2;
    sxy += (s.at - t0 - mx) * (s.offset - my);
  }
  const b = Math.max(-MAX_CLOCK_DRIFT, Math.min(MAX_CLOCK_DRIFT, sxy / sxx));
  return { a: my - b * mx, b, t0, rtt: best.rtt };
}

export const localToServer = (clock, local) => local + clock.a + clock.b * (local - clock.t0);
export const serverToLocal = (clock, server) => (server - clock.a + clock.b * clock.t0) / (1 + clock.b);
