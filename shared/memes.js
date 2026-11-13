// One-click meme combos ("mode mème"): a real meme sound (MyInstants, downloaded once) + a quick visual effect,
// placed at a given time. Used by the Mèmes panel (UI) and the add_meme MCP tool.
// sfx: candidate sound ids, the first one available is used (myinstants:… = meme bank, others = bundled CC0 sounds).
//   zoom:   punch = instant zoom on the main video then back after `dur` · slow = progressive zoom during `dur`
//   freeze: freeze frame of `dur` seconds (inserts time) · flash: white flash · confetti: confetti overlay
export const MEMES = [
  { id: 'vine-boom', glyph: '💥', fr: 'Vine boom + zoom', en: 'Vine boom + zoom', sfx: ['myinstants:vine-boom.mp3', 'deep-boom'], zoom: { style: 'punch', amount: 0.3, dur: 1 } },
  { id: 'bruh', glyph: '😐', fr: 'Bruh', en: 'Bruh', sfx: ['myinstants:movie_1.mp3'], zoom: { style: 'punch', amount: 0.18, dur: 1.2 } },
  { id: 'sad-violin', glyph: '🎻', fr: 'Violon triste', en: 'Sad violin', sfx: ['myinstants:tf_nemesis.mp3'], zoom: { style: 'slow', amount: 0.12, dur: 3.5 }, sfxDur: 5 },
  { id: 'mlg', glyph: '📯', fr: 'MLG air horn', en: 'MLG air horn', sfx: ['myinstants:mlg-airhorn.mp3', 'airhorn'], flash: { dur: 0.25 }, zoom: { style: 'punch', amount: 0.15, dur: 0.8 } },
  { id: 'anime-wow', glyph: '✨', fr: 'Anime wow', en: 'Anime wow', sfx: ['myinstants:anime-wow-sound-effect.mp3'], zoom: { style: 'punch', amount: 0.25, dur: 1.3 } },
  { id: 'oof', glyph: '💀', fr: 'Roblox oof', en: 'Roblox oof', sfx: ['myinstants:roblox-death-sound_1.mp3'], zoom: { style: 'punch', amount: 0.12, dur: 0.7 } },
  { id: 'fail', glyph: '🫠', fr: 'Échec (Bob l’éponge)', en: 'SpongeBob fail', sfx: ['myinstants:spongebob-fail.mp3', 'sad-trombone'] },
  { id: 'among-us', glyph: '🔪', fr: 'Imposteur (Among Us)', en: 'Among Us reveal', sfx: ['myinstants:among-us-role-reveal-sound.mp3'], zoom: { style: 'slow', amount: 0.15, dur: 2.5 } },
  { id: 'metal-pipe', glyph: '🔩', fr: 'Tuyau en métal', en: 'Metal pipe', sfx: ['myinstants:metal-pipe-clang.mp3', 'metal-pipe'], zoom: { style: 'punch', amount: 0.1, dur: 0.5 } },
  { id: 'fahh', glyph: '😩', fr: 'Fahhh', en: 'Fahhh', sfx: ['myinstants:fahhhhhhhhhhhhhh.mp3'], zoom: { style: 'punch', amount: 0.2, dur: 1.2 } },
  { id: 'taco-bell', glyph: '🔔', fr: 'Taco Bell bong', en: 'Taco Bell bong', sfx: ['myinstants:taco-bell-bong-sfx.mp3'], zoom: { style: 'punch', amount: 0.15, dur: 0.9 } },
  { id: 'rizz', glyph: '😏', fr: 'Rizz', en: 'Rizz', sfx: ['myinstants:rizz-sound-effect.mp3'], zoom: { style: 'slow', amount: 0.12, dur: 1.8 } },
  { id: 'wrong', glyph: '❌', fr: 'Mauvaise réponse', en: 'Wrong buzzer', sfx: ['myinstants:wrong-answer-sound-effect.mp3', 'wrong-buzzer'] },
  { id: 'discord', glyph: '🔔', fr: 'Notif Discord', en: 'Discord ping', sfx: ['myinstants:discord-notification.mp3'] },
  { id: 'awkward', glyph: '🦗', fr: 'Silence gênant', en: 'Awkward silence', sfx: ['crickets'], zoom: { style: 'slow', amount: 0.1, dur: 2.6 }, sfxDur: 3 },
  { id: 'freeze', glyph: '⏸️', fr: 'Arrêt sur image + scratch', en: 'Record scratch freeze', sfx: ['record-scratch'], freeze: { dur: 2.2 } },
  { id: 'explosion', glyph: '💣', fr: 'Explosion', en: 'Explosion', sfx: ['explosion'], flash: { dur: 0.35 }, zoom: { style: 'punch', amount: 0.12, dur: 0.6 } },
  { id: 'win', glyph: '🏆', fr: 'Victoire', en: 'Win', sfx: ['myinstants:mlg-airhorn.mp3', 'airhorn'], confetti: { dur: 3 } },
];

export const MEME_IDS = MEMES.map((m) => m.id);

/** Quick searches of the meme bank (sounds / green-screen videos). */
export const MEME_SOUND_QUICK = ['vine boom', 'bruh', 'sad violin', 'emotional damage', 'oh no', 'airhorn', 'among us', 'anime wow', 'fahh', 'windows error', 'rizz', 'sus', 'metal pipe', 'oof', 'nani', 'boom'];
export const MEME_VIDEO_QUICK = ['to be continued', 'wasted', 'coffin dance', 'oh no no no', 'deal with it', 'thug life', 'mlg', 'windows error', 'surprised pikachu', 'explosion', 'sad violin', 'jumpscare'];

/** Sticker placement presets → centre offset (px) for a sticker of side `side` px in a W×H frame. */
export function stickerOffset(pos, side, W, H) {
  const k = Math.min(W, H);
  const m = 0.05 * k + side / 2;
  const x = /left/.test(pos) ? -W / 2 + m : /right/.test(pos) ? W / 2 - m : 0;
  const y = /top/.test(pos) ? -H / 2 + m : /bottom/.test(pos) ? H / 2 - m : 0;
  return { x: Math.round(x), y: Math.round(y) };
}
export const STICKER_POSITIONS = ['center', 'top', 'bottom', 'left', 'right', 'top-left', 'top-right', 'bottom-left', 'bottom-right'];
