// Curates the "real sounds" pack: searches Freesound CC0 recordings through the Openverse API, downloads a few
// candidates per wanted sound, measures them with ffmpeg (noise floor, clipping, level) and keeps the best one.
// Output: scripts/packs/sfx.json (the catalog used by scripts/fetch-packs.mjs). Run once by a maintainer:
//   node scripts/packs/curate-sfx.mjs <tmpDir> [onlyId,...]
// Anonymous Openverse limits: 20 requests/min, 200/day → one query per sound, paced.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(here, 'sfx.json');
const TMP = process.argv[2] || path.join(here, '.tmp');
const ONLY = process.argv[3] ? new Set(process.argv[3].split(',')) : null;
fs.mkdirSync(TMP, { recursive: true });

// [id, fr, en, category, query, [minDur, maxDur], tags, replaces-builtin?]
const WANT = [
  // realistic sounds that replace weak synthesized ones (same ids → every existing use gets the real recording)
  ['camera-shutter', 'Déclencheur photo', 'Camera shutter', 'foley', 'camera shutter', [0.15, 1.6], 'photo appareil camera shutter snap clic', 1],
  ['applause', 'Applaudissements', 'Applause', 'crowd', 'applause', [3, 10], 'applause applaudissements bravo public audience clapping', 1],
  ['cash-register', 'Caisse enregistreuse', 'Cash register', 'meme', 'cash register', [0.5, 3.5], 'cash ka-ching argent money caisse vente sale', 1],
  ['keyboard-typing', 'Frappe clavier', 'Keyboard typing', 'foley', 'keyboard typing', [1.5, 7], 'clavier keyboard typing ordinateur computer hacker', 1],
  ['typewriter-key', 'Touche machine à écrire', 'Typewriter key', 'foley', 'typewriter', [0.05, 1.5], 'typewriter machine a ecrire touche key', 1],
  ['explosion', 'Explosion', 'Explosion', 'impact', 'explosion', [1.5, 7], 'explosion boom bombe blast kaboom', 1],
  ['thunder', 'Tonnerre', 'Thunder', 'impact', 'thunder', [2.5, 12], 'tonnerre thunder orage storm', 1],
  ['punch-heavy', 'Coup de poing', 'Punch', 'impact', 'punch', [0.15, 1.2], 'punch coup poing frappe fight bagarre', 1],
  ['hit-punch', 'Coup sec', 'Punch hit', 'impact', 'punch hit', [0.1, 1.0], 'punch hit coup impact', 1],
  ['whistle', 'Sifflet d\'arbitre', 'Referee whistle', 'foley', 'referee whistle', [0.4, 3], 'sifflet whistle arbitre referee sport', 1],
  ['page-turn', 'Page tournée', 'Page turn', 'foley', 'page turn', [0.3, 2], 'page livre book papier paper flip', 1],
  ['pop-cork', 'Bouchon de champagne', 'Cork pop', 'foley', 'cork pop', [0.2, 2], 'bouchon champagne cork pop fete celebration', 1],
  ['clock-ticking', 'Horloge tic-tac', 'Clock ticking', 'foley', 'clock ticking', [3, 12], 'horloge clock tic tac tick temps suspense', 1],
  ['snap', 'Claquement de doigts', 'Finger snap', 'foley', 'finger snap', [0.1, 1.2], 'claquement doigts snap finger magie', 1],
  ['sword-unsheath', 'Épée dégainée', 'Sword unsheath', 'foley', 'sword unsheath', [0.4, 2.5], 'epee sword lame blade schwing metal', 1],
  ['record-scratch', 'Scratch de vinyle', 'Record scratch', 'meme', 'record scratch', [0.3, 2.5], 'scratch vinyle record stop dj meme', 1],
  ['crickets', 'Criquets (silence gênant)', 'Crickets (awkward silence)', 'meme', 'cricket', [2.5, 15], 'criquets crickets silence gene awkward meme', 1],
  ['airhorn', 'Klaxon (airhorn)', 'Air horn', 'meme', 'air horn', [0.8, 4.5], 'airhorn klaxon mlg meme horn fete', 1],
  ['sad-trombone', 'Trombone triste', 'Sad trombone', 'meme', 'sad trombone', [1.5, 6], 'trombone triste fail echec wah wah rate meme', 1],
  ['rimshot', 'Ba-dum-tss', 'Rimshot', 'meme', 'rimshot', [0.5, 3.5], 'rimshot ba dum tss blague joke batterie', 1],
  ['boxing-bell', 'Cloche de boxe', 'Boxing bell', 'meme', 'boxing bell', [0.8, 5], 'cloche boxe boxing bell ring round combat', 1],
  ['drumroll', 'Roulement de tambour', 'Drum roll', 'drums', 'drum roll', [2, 7], 'roulement tambour drumroll suspense revelation', 1],
  ['water-drop', 'Goutte d\'eau', 'Water drop', 'foley', 'water drop', [0.1, 1.2], 'goutte eau water drop bloop', 1],
  ['heartbeat', 'Battements de cœur', 'Heartbeat', 'ambience', 'heartbeat', [2, 9], 'coeur heartbeat battement stress suspense', 1],
  ['phone-vibrate', 'Téléphone qui vibre', 'Phone vibrate', 'ui', 'phone vibrate', [0.8, 4], 'telephone phone vibreur vibrate notification', 1],
  ['alarm', 'Réveil', 'Alarm clock', 'ui', 'alarm clock', [1.5, 7], 'reveil alarme alarm clock matin', 1],
  // new real sounds
  ['glass-break', 'Verre brisé', 'Glass break', 'foley', 'glass break', [0.5, 4], 'verre glass casse break shatter'],
  ['door-knock', 'On frappe à la porte', 'Door knock', 'foley', 'door knock', [0.5, 4], 'porte door toc toc knock'],
  ['door-creak', 'Porte qui grince', 'Creaky door', 'foley', 'door creak', [1, 6], 'porte grince creak door horreur'],
  ['door-slam', 'Porte claquée', 'Door slam', 'foley', 'door slam', [0.3, 2.5], 'porte claque slam door'],
  ['footsteps', 'Bruits de pas', 'Footsteps', 'foley', 'footsteps', [2, 8], 'pas footsteps marche walking'],
  ['zipper', 'Fermeture éclair', 'Zipper', 'foley', 'zipper', [0.3, 2.5], 'fermeture eclair zip zipper'],
  ['paper-crumple', 'Papier froissé', 'Paper crumple', 'foley', 'paper crumple', [0.5, 4], 'papier froisse paper crumple'],
  ['pencil-writing', 'Écriture au crayon', 'Pencil writing', 'foley', 'pencil writing', [1, 6], 'crayon ecrire pencil writing'],
  ['mouse-click', 'Clic de souris', 'Mouse click', 'ui', 'mouse click', [0.05, 0.8], 'souris clic mouse click ordinateur'],
  ['soda-open', 'Canette ouverte', 'Soda can open', 'foley', 'soda can open', [0.3, 2.5], 'canette soda can ouvrir boisson'],
  ['crunch', 'Croc (manger)', 'Crunch', 'human', 'crunch', [0.2, 2], 'croc crunch manger eat chips'],
  ['glass-clink', 'Trinquer', 'Glass clink', 'foley', 'glass clink', [0.2, 2.5], 'trinquer cheers verre glass clink sante'],
  ['elevator-ding', 'Ding d\'ascenseur', 'Elevator ding', 'ui', 'elevator ding', [0.5, 3], 'ascenseur elevator ding cloche'],
  ['coins', 'Pièces de monnaie', 'Coins', 'meme', 'coins', [0.4, 3], 'pieces monnaie coins argent money'],
  ['money-count', 'Billets comptés', 'Money counting', 'meme', 'money counting', [1, 6], 'billets argent money compter riche'],
  ['laugh-track', 'Rires enregistrés', 'Laugh track', 'crowd', 'audience laughing', [2, 9], 'rires public laugh track sitcom drole lol'],
  ['crowd-aww', 'Public « Ooooh » attendri', 'Crowd aww', 'crowd', 'crowd aww', [1, 5], 'aww public attendri mignon cute'],
  ['crowd-ooh', 'Public « Ooh » surpris', 'Crowd ooh', 'crowd', 'audience reaction', [1, 6], 'ooh wow public surpris impressionne'],
  ['crowd-cheer', 'Foule en liesse', 'Crowd cheering', 'crowd', 'crowd cheering', [3, 10], 'foule cheer acclamation victoire fete'],
  ['crowd-boo', 'Huées', 'Crowd booing', 'crowd', 'booing', [1.5, 8], 'huees boo booing public mecontent'],
  ['kids-yay', 'Enfants « Yay ! »', 'Kids yay', 'crowd', 'kids yay', [1, 5], 'enfants yay kids hourra joie'],
  ['gasp', 'Souffle surpris', 'Gasp', 'human', 'gasp', [0.3, 2.5], 'souffle surprise gasp choc oh'],
  ['scream', 'Cri', 'Scream', 'human', 'scream', [0.5, 3.5], 'cri scream hurlement peur'],
  ['evil-laugh', 'Rire maléfique', 'Evil laugh', 'human', 'evil laugh', [1, 6], 'rire malefique evil laugh mechant villain'],
  ['baby-laugh', 'Rire de bébé', 'Baby laugh', 'human', 'baby laugh', [1, 6], 'bebe rire baby laugh mignon'],
  ['fart', 'Pet', 'Fart', 'human', 'fart', [0.3, 3], 'pet prout fart meme drole'],
  ['burp', 'Rot', 'Burp', 'human', 'burp', [0.3, 2.5], 'rot burp'],
  ['kiss', 'Bisou', 'Kiss', 'human', 'kiss', [0.2, 1.5], 'bisou kiss smack amour love'],
  ['wolf-whistle', 'Sifflement admiratif', 'Wolf whistle', 'human', 'wolf whistle', [0.5, 2.5], 'sifflement wolf whistle wow'],
  ['sneeze', 'Éternuement', 'Sneeze', 'human', 'sneeze', [0.3, 2.5], 'eternuement sneeze atchoum'],
  ['yawn', 'Bâillement', 'Yawn', 'human', 'yawn', [1, 5], 'baillement yawn fatigue ennui'],
  ['snore', 'Ronflement', 'Snoring', 'human', 'snoring', [2, 8], 'ronflement snore dormir sleep'],
  ['slap', 'Gifle', 'Slap', 'impact', 'slap', [0.1, 1.2], 'gifle claque slap'],
  ['body-fall', 'Chute', 'Body fall', 'impact', 'body fall', [0.3, 2.5], 'chute tomber fall body'],
  ['metal-pipe', 'Tuyau en métal (mème)', 'Metal pipe falling', 'meme', 'metal pipe', [0.5, 4], 'metal pipe tuyau clang meme chute'],
  ['deep-boom', 'Boom grave', 'Deep boom', 'meme', 'deep boom', [0.6, 4], 'boom grave bass vine meme impact revelation'],
  ['dramatic-sting', 'Effet dramatique', 'Dramatic sting', 'meme', 'dramatic sting', [1, 6], 'dramatique dramatic sting choc revelation'],
  ['horror-sting', 'Effet horreur', 'Horror sting', 'meme', 'horror sting', [1, 6], 'horreur horror peur scary jump scare'],
  ['angel-choir', 'Chœur céleste', 'Angelic choir', 'magic', 'choir', [1.5, 7], 'choeur ange angel celeste heaven divin ahh'],
  ['harp-gliss', 'Harpe (rêve)', 'Harp glissando', 'magic', 'harp glissando', [1, 6], 'harpe harp reve dream flashback'],
  ['magic-wand', 'Baguette magique', 'Magic wand', 'magic', 'magic wand', [0.5, 4], 'magie magic baguette wand sort spell'],
  ['gong', 'Gong', 'Gong', 'meme', 'gong', [2, 9], 'gong annonce asie'],
  ['party-horn', 'Langue de belle-mère', 'Party horn', 'meme', 'party horn', [0.4, 3], 'fete party horn anniversaire'],
  ['party-popper', 'Canon à confettis', 'Party popper', 'meme', 'party popper', [0.2, 2.5], 'confettis party popper fete'],
  ['fireworks', 'Feu d\'artifice', 'Fireworks', 'meme', 'fireworks', [2, 9], 'feu artifice fireworks fete celebration'],
  ['wrong-buzzer', 'Buzzer mauvaise réponse', 'Wrong answer buzzer', 'meme', 'wrong buzzer', [0.4, 3], 'faux wrong buzzer erreur mauvaise reponse quiz'],
  ['correct-ding', 'Bonne réponse', 'Correct answer', 'ui', 'correct answer', [0.3, 2.5], 'correct bonne reponse vrai quiz ding'],
  ['boing-real', 'Boing (guimbarde)', 'Boing', 'cartoon', 'boing', [0.3, 2.5], 'boing ressort spring rebond cartoon'],
  ['slide-whistle', 'Sifflet à coulisse', 'Slide whistle', 'cartoon', 'slide whistle', [0.5, 3.5], 'sifflet coulisse slide whistle cartoon'],
  ['cartoon-fall', 'Chute cartoon', 'Cartoon fall', 'cartoon', 'falling whistle', [1, 5], 'chute cartoon fall sifflement'],
  ['cartoon-run', 'Course cartoon', 'Cartoon running', 'cartoon', 'cartoon running', [0.5, 4], 'course cartoon run fuite'],
  ['squeaky-toy', 'Jouet qui couine', 'Squeaky toy', 'cartoon', 'squeaky toy', [0.2, 2], 'couine squeak jouet toy canard'],
  ['cartoon-slip', 'Glissade', 'Slip', 'cartoon', 'slip', [0.3, 2.5], 'glissade slip banane chute'],
  ['bonk-real', 'Bonk (coup sur la tête)', 'Bonk', 'cartoon', 'bonk', [0.1, 1.2], 'bonk coup tete head'],
  ['duck-quack', 'Canard', 'Duck quack', 'animals', 'duck quack', [0.2, 2.5], 'canard duck coin coin quack'],
  ['goat', 'Chèvre', 'Goat', 'animals', 'goat', [0.5, 3.5], 'chevre goat beee meme'],
  ['chicken', 'Poule', 'Chicken', 'animals', 'chicken', [0.5, 4], 'poule chicken cot cot'],
  ['rooster', 'Coq', 'Rooster', 'animals', 'rooster', [1, 5], 'coq rooster cocorico matin'],
  ['cat-meow', 'Miaulement', 'Cat meow', 'animals', 'cat meow', [0.3, 2.5], 'chat cat miaou meow'],
  ['dog-bark', 'Aboiement', 'Dog bark', 'animals', 'dog bark', [0.2, 2.5], 'chien dog ouaf aboiement bark'],
  ['cow-moo', 'Vache', 'Cow moo', 'animals', 'cow moo', [0.8, 4], 'vache cow meuh moo'],
  ['car-horn', 'Klaxon de voiture', 'Car horn', 'foley', 'car horn', [0.3, 2.5], 'klaxon voiture car horn honk'],
  ['bike-bell', 'Sonnette de vélo', 'Bicycle bell', 'foley', 'bicycle bell', [0.3, 2.5], 'sonnette velo bike bell'],
  ['rocket-launch', 'Décollage de fusée', 'Rocket launch', 'impact', 'rocket launch', [2, 9], 'fusee rocket decollage launch'],
  ['sword-clash', 'Choc d\'épées', 'Sword clash', 'impact', 'sword clash', [0.2, 2.5], 'epee sword clash combat'],
  ['whoosh-real', 'Whoosh (réel)', 'Whoosh (real)', 'transition', 'whoosh', [0.3, 1.5], 'whoosh souffle air transition'],
  ['swoosh-real', 'Swish (réel)', 'Swish (real)', 'transition', 'swish', [0.2, 1.2], 'swish swoosh rapide transition'],
  ['impact-real', 'Impact cinéma', 'Cinematic impact', 'impact', 'cinematic impact', [0.5, 4], 'impact cinema trailer hit boom'],
  ['pop-mouth', 'Pop (bouche)', 'Mouth pop', 'ui', 'mouth pop', [0.05, 0.8], 'pop bouche mouth apparition'],
  ['heart-monitor', 'Moniteur cardiaque', 'Heart monitor', 'foley', 'heart monitor', [1, 6], 'hopital moniteur cardiaque heart monitor bip'],
  ['texting', 'Écrire un SMS', 'Phone typing', 'ui', 'phone typing', [1, 5], 'sms texto message telephone typing'],
  ['rain', 'Pluie', 'Rain', 'ambience', 'rain', [6, 20], 'pluie rain ambiance meteo'],
  ['city', 'Ville', 'City ambience', 'ambience', 'city ambience', [6, 20], 'ville city rue traffic ambiance'],
  ['forest', 'Forêt et oiseaux', 'Forest birds', 'ambience', 'forest birds', [6, 20], 'foret oiseaux birds nature ambiance'],
  ['ocean', 'Vagues', 'Ocean waves', 'ambience', 'waves beach', [6, 25], 'mer ocean vagues waves plage beach'],
  ['fire-crackle', 'Feu de camp', 'Campfire', 'ambience', 'fire crackling', [6, 20], 'feu fire camp crepitement'],
  ['restaurant', 'Brouhaha', 'Crowd chatter', 'ambience', 'crowd chatter', [6, 20], 'brouhaha foule chatter restaurant bar ambiance'],
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let lastReq = 0;
async function openverse(q) {
  const wait = 3300 - (Date.now() - lastReq);
  if (wait > 0) await sleep(wait);
  lastReq = Date.now();
  const u = `https://api.openverse.org/v1/audio/?${new URLSearchParams({ q, license: 'cc0,pdm', source: 'freesound', page_size: '20', mature: 'false' })}`;
  for (let i = 0; i < 4; i++) {
    const res = await fetch(u, { headers: { 'User-Agent': 'AI.cut pack curation (open-source video editor)' } });
    if (res.status === 429) { console.log('  rate limited, waiting 65s'); await sleep(65000); continue; }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()).results || [];
  }
  throw new Error('rate limited');
}

function measure(file) {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-nostats', '-i', file, '-af', 'astats=measure_perchannel=none', '-f', 'null', '-'], { encoding: 'utf8' });
  const s = r.stderr || '';
  const num = (re) => { const m = re.exec(s); return m ? Number(m[1]) : null; };
  return {
    peak: num(/Peak level dB:\s*(-?[\d.]+|-inf)/), rms: num(/RMS level dB:\s*(-?[\d.]+)/), floor: num(/Noise floor dB:\s*(-?[\d.]+|-inf)/),
    flat: num(/Flat factor:\s*([\d.]+)/), dur: num(/Duration:\s*\d+:\d+:([\d.]+)/),
  };
}

function relevance(r, q) {
  const words = q.toLowerCase().split(/\s+/);
  const text = `${r.title} ${(r.tags || []).map((t) => t.name).join(' ')}`.toLowerCase();
  return words.filter((w) => text.includes(w)).length / words.length;
}

const catalog = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : { sounds: [] };
const byId = new Map(catalog.sounds.map((x) => [x.id, x]));
for (const [id, fr, en, cat, q, [d0, d1], tags, replaces] of WANT) {
  if (ONLY ? !ONLY.has(id) : byId.has(id)) continue;
  try {
    const results = await openverse(q);
    const cands = results
      .filter((r) => r.duration && r.duration / 1000 >= d0 * 0.8 && r.duration / 1000 <= d1 * 1.25 && r.url)
      .filter((r) => !/loop/i.test(r.title) || cat === 'ambience')
      .map((r, rank) => ({ r, rank, rel: relevance(r, q) }))
      .filter((x) => x.rel > 0)
      .slice(0, 5);
    if (!cands.length) { console.log(`✗ ${id}: no candidate (${results.length} results)`); continue; }
    const scored = [];
    for (const c of cands) {
      const f = path.join(TMP, `${id}__${c.r.id}.mp3`);
      if (!fs.existsSync(f)) {
        const res = await fetch(c.r.url);
        if (!res.ok) continue;
        fs.writeFileSync(f, Buffer.from(await res.arrayBuffer()));
      }
      const m = measure(f);
      let score = c.rel * 2 - c.rank * 0.12;
      const dur = c.r.duration / 1000, mid = (d0 + d1) / 2;
      score -= Math.min(1, Math.abs(dur - mid) / Math.max(0.5, d1 - d0));
      if (m.floor !== null) score += m.floor < -70 ? 1 : m.floor < -60 ? 0.6 : m.floor < -50 ? 0.2 : -0.5;
      if (m.flat !== null && m.flat > 1) score -= 0.8; // clipped (flat tops)
      if (m.rms !== null && m.rms < -45) score -= 0.8; // almost inaudible
      if ((c.r.sample_rate || 44100) < 32000) score -= 0.5;
      scored.push({ c, m, score });
    }
    if (!scored.length) { console.log(`✗ ${id}: downloads failed`); continue; }
    scored.sort((a, b) => b.score - a.score);
    const best = scored[0];
    const r = best.c.r;
    byId.set(id, {
      id, fr, en, cat, tags: tags.split(' '), ...(replaces ? { replaces: id } : {}),
      title: r.title, author: r.creator, license: `${String(r.license).toUpperCase()}${r.license_version ? ` ${r.license_version}` : ''}`,
      licenseUrl: r.license_url, landing: r.foreign_landing_url, url: r.url, duration: r.duration / 1000, openverseId: r.id,
      measure: best.m, alternates: scored.slice(1, 3).map((s) => ({ title: s.c.r.title, url: s.c.r.url, author: s.c.r.creator, landing: s.c.r.foreign_landing_url })),
    });
    console.log(`✓ ${id}: "${r.title}" by ${r.creator} (${(r.duration / 1000).toFixed(1)}s, floor ${best.m.floor}, score ${best.score.toFixed(2)})`);
    catalog.sounds = WANT.map((w) => byId.get(w[0])).filter(Boolean);
    fs.writeFileSync(OUT, JSON.stringify(catalog, null, 1));
  } catch (e) { console.log(`✗ ${id}: ${e.message}`); }
}
catalog.sounds = WANT.map((w) => byId.get(w[0])).filter(Boolean);
fs.writeFileSync(OUT, JSON.stringify(catalog, null, 1));
console.log(`done: ${catalog.sounds.length}/${WANT.length}`);
