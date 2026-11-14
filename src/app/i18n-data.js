// English names for data that is authored in French (motion templates, their settings, caption styles).
// UI only: the data itself (and what the AI sees and produces) is unchanged.

/** Built-in motion template id → English name. */
export const TEMPLATE_NAMES_EN = {
  text: 'Text', 'title-kinetic': 'Kinetic title', 'title-neon': 'Neon', 'title-glitch': 'Glitch', typewriter: 'Typewriter',
  'kinetic-words': 'Punchy words', quote: 'Quote', chapter: 'Chapter', 'bullet-list': 'Bullet list',
  'lower-third-modern': 'Modern lower third', 'lower-third-minimal': 'Minimal lower third', 'lower-third-glass': 'Glass lower third',
  subscribe: 'Subscribe button', 'social-handle': 'Social handle', 'like-share': 'Like · Comment · Share', 'end-screen': 'End screen',
  'arrow-callout': 'Arrow + caption', 'circle-highlight': 'Circle highlight', 'location-pin': 'Location', 'emoji-burst': 'Emoji burst',
  counter: 'Counter', 'progress-bar': 'Progress bar', 'bar-chart': 'Bar chart', countdown: 'Countdown', confetti: 'Confetti',
  'light-leak': 'Light leak', 'film-grain': 'Film grain', letterbox: 'Letterbox', 'rec-frame': 'Camcorder REC', flash: 'Flash',
  'shape-wipe': 'Shape wipe', 'image-pop': 'Image / logo pop', lottie: 'Lottie animation', 'title-minimal': 'Minimal title',
  'title-reveal': 'Masked title', 'title-box': 'Boxed title', 'title-stack': 'Stacked words', 'lower-third-line': 'Line lower third',
  'lower-third-tag': 'Live tag', 'callout-box': 'Box + label', spotlight: 'Spotlight', 'arrow-pointer': 'Drawn arrow',
  checklist: 'Checklist', steps: 'Steps', 'stat-card': 'Key figure card', 'pie-chart': 'Donut chart', 'line-chart': 'Line chart',
  'emoji-sticker': 'Giant emoji', notification: 'Notification', 'post-card': 'Social post', 'chat-bubbles': 'Chat',
  'search-bar': 'Search bar', timer: 'Stopwatch', 'cta-link': 'Link in description', 'circle-wipe': 'Circle wipe',
  'glitch-transition': 'Glitch transition', 'film-burn': 'Film burn', 'frame-border': 'Rounded frame',
  'scribble-underline': 'Marker underline', 'promo-badge': 'Promo badge', 'sound-wave': 'Sound wave',
  'track-label': 'Tracking label',
};

/** French setting label of a motion template → English. */
export const PARAM_LABELS_EN = {
  'Direction (°)': 'Direction (°)', 'Distance': 'Distance', 'Couleur du texte': 'Text color', 'Couleur du trait': 'Line color',
  'Point sur la cible': 'Dot on target',
  'Texte': 'Text', 'Police': 'Font', 'Taille': 'Size', 'Graisse': 'Weight', 'Couleur': 'Color', 'Contour': 'Outline',
  'Épaisseur contour': 'Outline width', 'Fond (couleur ou none)': 'Background (color or none)', 'Position': 'Position',
  'Entrée': 'In', 'Sortie': 'Out', 'Majuscules': 'Uppercase', 'Ombre': 'Shadow', 'Alignement': 'Alignment', 'Espacement': 'Spacing',
  'Titre': 'Title', 'Sous-titre': 'Subtitle', 'Accent': 'Accent', 'Lueur': 'Glow', 'Caractères/s': 'Characters/s', 'Curseur': 'Cursor',
  'Fond': 'Background', 'Vertical': 'Vertical', 'Couleur accent': 'Accent color', 'Citation': 'Quote', 'Auteur': 'Author',
  'Étiquette': 'Label', 'Éléments': 'Items', 'Puces': 'Bullets', 'Délai entre éléments': 'Delay between items', 'Nom': 'Name',
  'Rôle': 'Role', 'Côté': 'Side', 'Ligne': 'Line', 'Initiales (auto)': 'Initials (auto)', 'Avatar': 'Avatar', 'Après clic': 'After click',
  'Position bas (%)': 'Bottom position (%)', 'Pseudo': 'Handle', 'Plateforme': 'Platform', 'Position haut (%)': 'Top position (%)',
  'Like': 'Like', 'Commenter': 'Comment', 'Partager': 'Share', 'Case gauche': 'Left box', 'Case droite': 'Right box',
  "Appel à l'action": 'Call to action', 'Légende': 'Caption', 'Cible X (0-1)': 'Target X (0-1)', 'Cible Y (0-1)': 'Target Y (0-1)',
  'Légende X': 'Caption X', 'Légende Y': 'Caption Y', 'Taille texte': 'Text size', 'Centre X': 'Center X', 'Centre Y': 'Center Y',
  'Largeur': 'Width', 'Hauteur': 'Height', 'Épaisseur': 'Thickness', 'Lieu': 'Place', 'Détail': 'Detail', 'Emojis': 'Emoji',
  'Nombre': 'Count', 'Dispersion': 'Spread', 'De': 'From', 'À': 'To', 'Préfixe': 'Prefix', 'Suffixe': 'Suffix', 'Décimales': 'Decimals',
  'Durée du comptage': 'Count duration', 'Données': 'Data', 'Barres': 'Bars', 'Depuis': 'From', 'Mot final': 'Final word',
  'Anneau': 'Ring', 'Mode': 'Mode', 'Couleurs': 'Colors', 'Couleur 1': 'Color 1', 'Couleur 2': 'Color 2', 'Couleur 3': 'Color 3',
  'Intensité': 'Intensity', 'Rayures': 'Scratches', 'Ratio': 'Ratio', 'Timecode départ (s)': 'Start timecode (s)', 'Image': 'Image',
  'Taille max (%)': 'Max size (%)', 'Arrondi': 'Corner radius', 'Bordure': 'Border', 'Inclinaison': 'Tilt', 'Fichier Lottie': 'Lottie file',
  'Boucle': 'Loop', 'Vitesse': 'Speed', 'Échelle': 'Scale', 'Ajustement': 'Fit', 'Ligne 1': 'Line 1', 'Ligne 2': 'Line 2',
  'Cadre': 'Frame', 'Point': 'Dot', 'Rayon': 'Radius', 'Opacité': 'Opacity', 'Départ X': 'Start X', 'Départ Y': 'Start Y',
  'Cible X': 'Target X', 'Cible Y': 'Target Y', 'Coches': 'Checkmarks', 'Intervalle (s)': 'Interval (s)', 'Étapes': 'Steps',
  'Libellé': 'Label', 'Valeur': 'Value', 'Badge': 'Badge', 'Texte badge': 'Badge text', 'Courbe': 'Line', 'Emoji': 'Emoji',
  'Fond légende': 'Caption background', 'Appli': 'App', 'Initiale': 'Initial', 'Heure': 'Time', 'Message': 'Message', 'Icône': 'Icon',
  'Initiales': 'Initials', 'J’aime': 'Likes', "J'aime": 'Likes', 'Commentaires': 'Comments', 'Partages': 'Shares', 'Messages': 'Messages',
  'Bulle reçue': 'Received bubble', 'Texte reçu': 'Received text', 'Bulle envoyée': 'Sent bubble', 'Texte envoyé': 'Sent text',
  'Recherche': 'Search', 'Lettres / s': 'Letters / s', 'De (s)': 'From (s)', 'À (s)': 'To (s)', 'Bas (%)': 'Bottom (%)',
  'Marge (%)': 'Margin (%)', 'Sous-texte': 'Subtext',
};

/** Caption style id → English name (and hint). */
export const SUBTITLE_PRESETS_EN = {
  bold: 'Bold TikTok', punch: ['Color punch', 'Hormozi style'], highlight: 'Active word box', pill: 'Moving highlight', bubble: 'Bubbles',
  beast: 'Beast', reveal: 'Word by word', karaoke: 'Karaoke', glow: 'Glow', keywords: 'Keywords only', 'keywords-pop': 'Keywords + emoji',
  emphasis: 'Key words', editorial: 'Mixed editorial', podcast: 'Podcast', classic: 'Classic', streaming: 'Streaming', minimal: 'Minimal',
  box: 'Box', documentary: 'Documentary', underline: 'Underline', cascade: 'Cascade', cinematic: 'Cinema', typewriter: 'Typewriter',
  neon: 'Neon', gaming: 'Gaming', comic: 'Comic', wave: 'Wave', marker: 'Highlighter', split: 'Two-tone', outline: 'Outline', retro: 'Retro VHS',
};
