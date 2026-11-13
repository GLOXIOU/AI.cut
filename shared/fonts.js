// Fonts bundled with AI.cut (SIL Open Font License / Apache 2.0, from @fontsource). Copied to resources/fonts
// by scripts/prepare-resources.mjs and declared in resources/fonts/fonts.css.
export const BUNDLED_FONTS = [
  { family: 'Inter', pkg: 'inter', weights: [400, 500, 600, 700, 800, 900], category: 'sans' },
  { family: 'Montserrat', pkg: 'montserrat', weights: [500, 600, 700, 800, 900], category: 'sans' },
  { family: 'Poppins', pkg: 'poppins', weights: [500, 600, 700, 800, 900], category: 'sans' },
  { family: 'Roboto', pkg: 'roboto', weights: [400, 500, 700, 900], category: 'sans' },
  { family: 'Rubik', pkg: 'rubik', weights: [500, 700, 900], category: 'sans' },
  { family: 'Space Grotesk', pkg: 'space-grotesk', weights: [500, 700], category: 'sans' },
  { family: 'Anton', pkg: 'anton', weights: [400], category: 'display' },
  { family: 'Bebas Neue', pkg: 'bebas-neue', weights: [400], category: 'display' },
  { family: 'Oswald', pkg: 'oswald', weights: [500, 700], category: 'display' },
  { family: 'Archivo Black', pkg: 'archivo-black', weights: [400], category: 'display' },
  { family: 'Bangers', pkg: 'bangers', weights: [400], category: 'fun' },
  { family: 'Luckiest Guy', pkg: 'luckiest-guy', weights: [400], category: 'fun' },
  { family: 'Lilita One', pkg: 'lilita-one', weights: [400], category: 'fun' },
  { family: 'Permanent Marker', pkg: 'permanent-marker', weights: [400], category: 'handwritten' },
  { family: 'Caveat', pkg: 'caveat', weights: [500, 700], category: 'handwritten' },
  { family: 'Playfair Display', pkg: 'playfair-display', weights: [400, 700, 900], category: 'serif' },
  { family: 'DM Serif Display', pkg: 'dm-serif-display', weights: [400], category: 'serif' },
  { family: 'Roboto Mono', pkg: 'roboto-mono', weights: [400, 700], category: 'mono' },
];
export const FONT_FAMILIES = BUNDLED_FONTS.map((f) => f.family);
