// "Smart subtitles": scores every word of a transcript (0..1) so subtitles can show only the important words or
// emphasise them. Offline heuristics — stop-words (fr/en/es/de/it/pt), numbers, proper nouns, intensity lexicon,
// rarity in the transcript, prosody (stretched words, pauses) and loudness when available.
// An AI (MCP tool set_subtitle_keywords) or the user can override the choice per word: word.k = 1 (keyword) / 0 (not).

export const normWord = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\p{L}\p{N}]/gu, '');

const W = (s) => s.split(/\s+/).filter(Boolean);
const STOP = {
  fr: W(`le la les l un une des du de d au aux a et ou mais donc or ni car que qu qui quoi dont ce cet cette ces c ca cela ceci
    se s sa son ses leur leurs mon ma mes ton ta tes notre nos votre vos il ils elle elles on je j tu nous vous me m te t moi toi
    lui eux y en ne n pas plus moins tres trop bien aussi alors puis comme si sur sous dans par pour avec sans entre vers chez
    est sont etait etaient etre ete ai as avons avez ont avait avaient aura suis es sommes etes fait fais faire faut va vais vas
    allez aller vont peut peux pouvez pourrait dois doit voila ben bah euh heu hein bon ok okay ouais oui quand comment
    pourquoi tout tous toute toutes meme deja encore juste vraiment genre truc trucs chose choses fois ici la-bas voici
    celui celle ceux celles quel quelle quels quelles autre autres chaque peu beaucoup assez enfin bref voila sinon apres
    avant pendant depuis jusqu jusque ainsi cest jai ya quil quils quelle dun dune lui leurs`),
  en: W(`the a an and or but so of to in on at for with from by as is are was were be been being am do does did done have has
    had having i you he she it we they me him her us them my your his its our their mine yours this that these those there
    here what which who whom whose when where why how all any both each few more most other some such nor not only own same
    than too very can could will would shall should may might must just don now um uh uhm like yeah yes okay ok gonna wanna
    gotta got get gets getting go goes going went it's im i'm youre you're thats that's dont don't really actually basically
    thing things stuff kind sort about into over then also well because if else up down out off again further once
    let lets let's say said much many lot lots`),
  es: W(`el la los las un una unos unas de del al y o pero que qui en con por para sin sobre es son era fue ser estar esta
    estan este esto eso ese esa lo le les se su sus mi mis tu tus nos vos yo ella ellos ellas nosotros muy mas menos ya
    tambien como cuando donde porque si no hay ha he han tiene tengo pues bueno entonces asi todo toda todos todas`),
  de: W(`der die das den dem des ein eine einen einem einer und oder aber dass ist sind war waren sein bin bist hat haben
    habe ich du er sie es wir ihr mich dich sich mir dir uns euch mein dein sein ihr unser nicht kein keine auch noch schon
    so wie wenn dann als mit von zu zum zur auf aus bei nach fur uber unter vor durch um an in im am also ja nein doch mal`),
  it: W(`il lo la i gli le un uno una di del della dei degli delle a al alla ai da dal in nel nella con su sul per tra fra e
    o ma che chi cui non si ci vi mi ti ne lui lei noi voi loro mio tuo suo nostro vostro sono sei e era erano essere ho hai
    ha abbiamo avete hanno anche come quando dove perche se piu meno molto poi gia ancora tutto tutti cosi questo quello`),
  pt: W(`o a os as um uma uns umas de do da dos das no na nos nas em ao aos e ou mas que quem com por para sem sobre e sao
    era foi ser estar esta estao este isso esse essa eu tu ele ela nos vos eles elas me te se lhe meu minha seu sua nosso
    muito mais menos ja tambem como quando onde porque se nao ha tem tenho entao assim tudo todos`),
};
const STOP_SETS = Object.fromEntries(Object.entries(STOP).map(([k, v]) => [k, new Set(v.map(normWord))]));
const ALL_STOP = new Set(Object.values(STOP_SETS).flatMap((s) => [...s]));

// Words that carry emphasis (prefix stems, accents removed).
const INTENSE = W(`incroyabl enorm jamais toujours gratuit secret attention meilleur pire million milliard argent erreur probleme
  solution important simple facile rapid puissant exactement interdit danger urgent nouveau nouvelle premier premiere dernier
  derniere absolument totalement completement fou folle dingue ouf choqu impossibl parfait genial magnifiq horribl terribl
  gagn perdu perdre mort vie amour peur reussi echec succes record uniqu rare special exclusi garanti prouv revolution astuce
  hack conseil strategi methode resultat objectif reve liberte riche pauvre crise guerre victoire champion stop wow
  urgence alerte vrai faux mensonge verite enfin surtout jamais personne rien tout
  amazing incredibl never always free secret best worst million billion money mistake problem solution important easy fast
  powerful crazy insane huge massive exactly forbidden danger urgent new first last final absolutely totally complete
  shock impossibl perfect awesome terribl win lose lost death life love fear success fail record unique rare exclusive
  guarantee proven hack tip strategy method result goal dream freedom rich poor crisis war victory champion stop wow truth
  lie nothing everything everyone nobody
  increibl nunca siempre gratis secreto mejor peor dinero error problema importante facil rapido loco
  unglaublich niemals immer kostenlos geheim beste schlimmste geld fehler wichtig einfach schnell verruckt
  incredibil mai sempre gratis segreto migliore peggiore soldi errore problema importante facile veloce pazzo
  incrivel nunca sempre gratis segredo melhor pior dinheiro erro problema importante facil rapido louco`).map(normWord);

const NUMBER_WORDS = new Set(W(`un deux trois quatre cinq six sept huit neuf dix onze douze vingt trente quarante cinquante
  soixante cent cents mille million millions milliard milliards one two three four five six seven eight nine ten eleven
  twelve twenty thirty forty fifty hundred thousand million millions billion dos tres cuatro cinco cien mil zwei drei vier
  funf hundert tausend due tre quattro cinque cento mille dois tres quatro cinco cem mil`).map(normWord));

const CURRENCY = new Set(W('euro euros dollar dollars livre livres pesos peso yen yens bitcoin bitcoins franc francs pourcent percent').map(normWord));
const isStop = (t, lang) => (lang && STOP_SETS[lang] ? STOP_SETS[lang].has(t) : ALL_STOP.has(t));
const intense = (t) => t.length >= 3 && INTENSE.some((s) => (s.length >= 4 ? t.startsWith(s) : t === s));

/**
 * Score words (0..1). words: [{text, start, end, e?}] in time order (e = loudness 0..1, optional).
 * opts: { language }
 */
export function scoreWords(words, { language } = {}) {
  const lang = language && STOP_SETS[String(language).slice(0, 2)] ? String(language).slice(0, 2) : null;
  const toks = words.map((w) => normWord(w.text));
  const freq = new Map();
  for (const t of toks) if (t) freq.set(t, (freq.get(t) || 0) + 1);
  // loudness → rank 0..1 among words that have it
  const withE = words.map((w, i) => [i, w.e]).filter(([, e]) => Number.isFinite(e));
  const rank = new Map();
  if (withE.length > 8) {
    withE.sort((a, b) => a[1] - b[1]);
    withE.forEach(([i], r) => rank.set(i, r / (withE.length - 1)));
  }
  return words.map((w, i) => {
    const t = toks[i];
    const raw = String(w.text || '');
    if (!t) return 0;
    const hasDigit = /\d/.test(raw);
    const numWord = NUMBER_WORDS.has(t);
    let s;
    if (hasDigit) s = 2.2;
    else if (isStop(t, lang)) s = numWord ? 0.9 : 0.08;
    else {
      s = 1;
      s += Math.min(1, Math.max(0, (t.length - 3) / 6)) * 0.5;
      if (numWord) s += 0.9;
    }
    if (s > 0.5) {
      if (intense(t)) s += 1.2;
      const prev = words[i - 1];
      const sentenceStart = !prev || /[.!?…:]$/.test(String(prev.text || ''));
      if (/^\p{Lu}/u.test(raw) && !sentenceStart) s += 0.8;
      if (raw.length >= 2 && raw === raw.toUpperCase() && /\p{L}/u.test(raw)) s += 0.4;
      if (/[%€$£¥]/.test(raw)) s += 0.6;
      if (CURRENCY.has(t)) s += 0.8;
      const f = freq.get(t) || 1;
      if (f >= 2 && f <= 5) s += 0.3;
      else if (f > 8) s -= 0.4;
    }
    if (/!$/.test(raw)) s += 0.6;
    else if (/\?$/.test(raw)) s += 0.25;
    // prosody
    const dur = Math.max(0, (w.end ?? 0) - (w.start ?? 0));
    const expected = 0.08 + 0.06 * t.length;
    const ratio = expected > 0 ? dur / expected : 1;
    if (s > 0.5 && ratio > 1.5) s += Math.min(0.6, (ratio - 1.5) * 0.6);
    const next = words[i + 1], prev = words[i - 1];
    if (next && next.start - w.end > 0.3) s += 0.35;
    if (prev && w.start - prev.end > 0.3) s += 0.15;
    if (rank.has(i) && s > 0.5) s += (rank.get(i) - 0.5) * 1.1;
    return Math.max(0, Math.min(1, s / 4));
  });
}

/**
 * Pick keyword indices from scores. opts: { density (0..1 share of words), minGap (s), minScore }
 * Adjacent strong words (e.g. "10 000 euros") may be kept together.
 */
export function pickKeywords(words, scores, { density = 0.25, minGap = 0.22, minScore = 0.3 } = {}) {
  const n = words.length;
  const target = Math.max(n ? 1 : 0, Math.round(n * Math.min(1, Math.max(0, density))));
  const order = scores.map((s, i) => [s, i]).filter(([s]) => s >= minScore).sort((a, b) => b[0] - a[0]);
  const chosen = new Set();
  for (const [s, i] of order) {
    if (chosen.size >= target) break;
    const w = words[i];
    let ok = true;
    for (const j of chosen) {
      const v = words[j];
      const gap = w.start >= v.end ? w.start - v.end : v.start >= w.end ? v.start - w.end : 0;
      const adjacent = Math.abs(i - j) === 1;
      if (gap < minGap && !(adjacent && s >= 0.45 && scores[j] >= 0.45)) { ok = false; break; }
    }
    if (ok) chosen.add(i);
  }
  return chosen;
}

// Emoji suggestions for keywords (stems, accents removed).
const EMOJI = [
  ['argent money dinero geld soldi dinheiro cash euro euros dollar dollars riche rich payer paid paye', '💰'],
  ['feu fire chaud hot brul burn', '🔥'], ['amour love aime coeur heart', '❤️'], ['idee idea astuce tip hack', '💡'],
  ['temps time heure hour minute seconde horloge', '⏰'], ['attention warning danger alerte alert', '⚠️'],
  ['question pourquoi why comment how', '❓'], ['meilleur best top champion gagn win victoire victory record', '🏆'],
  ['rire drole funny lol mdr blague', '😂'], ['peur fear scary effray horreur', '😱'],
  ['incroyabl incredib amazing wow dingue ouf fou crazy insane choqu shock', '🤯'], ['cerveau brain intellig smart genie', '🧠'],
  ['telephone phone smartphone', '📱'], ['ordinateur computer laptop code', '💻'], ['voiture car auto', '🚗'],
  ['maison house home', '🏠'], ['monde world planete planet terre earth', '🌍'], ['travail work job boulot business entreprise', '💼'],
  ['sport muscle force strong fitness', '💪'], ['musique music son chanson song', '🎵'], ['video film cinema camera', '🎬'],
  ['photo picture image', '📸'], ['livre book lire read', '📚'], ['ecole school etudi student cours', '🎓'],
  ['manger eat food nourriture repas burger pizza', '🍔'], ['cafe coffee', '☕'], ['nuit night dormir sleep', '🌙'],
  ['soleil sun ete summer', '☀️'], ['eau water mer ocean', '💧'], ['fete party celebr anniversaire birthday', '🎉'],
  ['cadeau gift offert', '🎁'], ['objectif goal cible target but', '🎯'], ['croissance growth hausse augment monte', '📈'],
  ['baisse chute drop perte loss', '📉'], ['rapide fast vite quick vitesse speed', '⚡'], ['stop arret interdit forbidden', '🛑'],
  ['oui yes vrai true exact correct', '✅'], ['non no faux false erreur mistake wrong', '❌'], ['secret cache hidden', '🤫'],
  ['gratuit free', '🆓'], ['nouveau new nouvelle', '✨'], ['roi king reine queen', '👑'], ['million millions milliard billion', '💸'],
  ['star etoile famous celebr', '⭐'], ['ami friend equipe team ensemble', '🤝'], ['merci thanks thank', '🙏'],
  ['regard look voir see yeux eye', '👀'], ['bebe baby enfant kid', '👶'], ['chien dog chat cat animal', '🐶'],
  ['voyage travel avion plane', '✈️'], ['fusee rocket lancer launch', '🚀'], ['diamant diamond precieux', '💎'],
  ['mort death dead tuer kill', '💀'], ['sante health medecin doctor', '🩺'], ['clef cle key', '🔑'], ['cerise bonus', '🍒'],
];
const EMOJI_INDEX = EMOJI.flatMap(([stems, e]) => W(stems).map((s) => [normWord(s), e]));
export function emojiFor(text) {
  const t = normWord(text);
  if (t.length < 2) return null;
  for (const [s, e] of EMOJI_INDEX) if (s.length >= 4 ? t.startsWith(s) : t === s) return e;
  return null;
}
