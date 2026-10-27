// Bowl logos. ESPN's API doesn't include them, so these were saved into img/bowls/ from each
// bowl's Wikipedia article. Keys are bowl names as ESPN writes them plus their sponsor-free core
// names, so next year's "New Sponsor Citrus Bowl" still finds the "Citrus Bowl" logo.
// To add or replace one, use bowlLogos in config.js rather than editing this file.

const DIR = 'img/bowls/';

const LOGOS = {
  "68 Ventures Bowl": "68-ventures-bowl-logo.png",
  "Alamo Bowl": "valero-alamo-bowl-logo.svg",
  "Allstate Sugar Bowl": "sugar-bowl-logo.svg",
  "Arizona Bowl": "arizona-bowl-logo.svg",
  "Armed Forces Bowl": "lockheed-martin-armed-forces-bowl-logo.svg",
  "AutoZone Liberty Bowl": "autozone-liberty-bowl-logo.svg",
  "Bad Boy Mowers Pinstripe Bowl": "badboypinstripebowl.png",
  "Birmingham Bowl": "jlab-birmingham-bowl-logo.png",
  "Boca Raton Bowl": "boca-raton-bowl-logo-26.png",
  "Bucked Up LA Bowl": "la-bowl-logo.png",
  "Bush's Boca Raton Bowl": "boca-raton-bowl-logo-26.png",
  "Cactus Bowl": "cactus-bowl-logo.webp",
  "Capital One Orange Bowl": "orange-bowl-logo.svg",
  "Celebration Bowl": "celebration-bowl-logo.png",
  "Cheez-It Citrus Bowl": "citrus-bowl-logo-2026.png",
  "Chick-fil-A Peach Bowl": "peach-bowl-logo.svg",
  "Citrus Bowl": "citrus-bowl-logo-2026.png",
  "College Football Playoff": "college-football-playoff-logo.svg",
  "Cotton Bowl Classic": "cotton-bowl-logo.svg",
  "Cricket Celebration Bowl": "celebration-bowl-logo.png",
  "Cure Bowl": "curebowllogo24.svg",
  "Duke's Mayo Bowl": "duke-s-mayo-bowl-logo.svg",
  "Famous Idaho Potato Bowl": "famous-idaho-potato-bowl-logo.svg",
  "Fenway Bowl": "wasabifenwaybowl.png",
  "Fiesta Bowl": "fiesta-bowl-logo.svg",
  "First Responder Bowl": "servpro-first-responder-bowl-logo.svg",
  "Freedom Mortgage Military Bowl": "military-bowl-logo.png",
  "Frisco Bowl": "frisco-bowl-logo-26.png",
  "Frisco Football Classic": "frisco-football-classic.png",
  "GameAbove Sports Bowl": "gameabove-sports-bowl.png",
  "Gasparilla Bowl": "uniongasparillabowl.png",
  "Gator Bowl": "taxslayer-gator-bowl-logo.svg",
  "Go Bowling Military Bowl": "military-bowl-logo.png",
  "Goodyear Cotton Bowl Classic": "cotton-bowl-logo.svg",
  "Hawaii Bowl": "hawaii-bowl-logo.png",
  "Holiday Bowl": "holiday-bowl-26.png",
  "Independence Bowl": "radianceindependencebowl.png",
  "IS4S Salute to Veterans Bowl": "salute-to-veterans-bowl-logo.webp",
  "Isleta New Mexico Bowl": "new-mexico-bowl-logo.png",
  "JLab Birmingham Bowl": "jlab-birmingham-bowl-logo.png",
  "Kinder's Texas Bowl": "texas-bowl-logo24.png",
  "LA Bowl": "la-bowl-logo.png",
  "Las Vegas Bowl": "las-vegas-bowl-35.png",
  "Liberty Bowl": "autozone-liberty-bowl-logo.svg",
  "Liberty Mutual Music City Bowl": "music-city-bowl-logo.png",
  "Lockheed Martin Armed Forces Bowl": "lockheed-martin-armed-forces-bowl-logo.svg",
  "Military Bowl": "military-bowl-logo.png",
  "Music City Bowl": "music-city-bowl-logo.png",
  "Myrtle Beach Bowl": "myrtle-beach-bowl-logo-26.png",
  "New Mexico Bowl": "new-mexico-bowl-logo.png",
  "New Orleans Bowl": "new-orleans-bowl-logo-25.png",
  "Orange Bowl": "orange-bowl-logo.svg",
  "Peach Bowl": "peach-bowl-logo.svg",
  "Pinstripe Bowl": "badboypinstripebowl.png",
  "Poinsettia Bowl": "poinsettia-bowl-logo.svg",
  "Pop-Tarts Bowl": "pop-tarts-bowl.png",
  "Puerto Rico Bowl": "puerto-rico-bowl-logo.webp",
  "Radiance Technologies Independence Bowl": "radianceindependencebowl.png",
  "Rate Bowl": "cactus-bowl-logo.webp",
  "ReliaQuest Bowl": "reliaquest-bowl-logo.png",
  "Rose Bowl": "rose-bowl-game-logo.svg",
  "Rose Bowl Game": "rose-bowl-game-logo.svg",
  "Salute to Veterans Bowl": "salute-to-veterans-bowl-logo.webp",
  "San Diego County Credit Union Poinsettia Bowl": "poinsettia-bowl-logo.svg",
  "Scooter's Coffee Frisco Bowl": "frisco-bowl-logo-26.png",
  "SERVPRO First Responder Bowl": "servpro-first-responder-bowl-logo.svg",
  "Sheraton Hawaiʻi Bowl": "hawaii-bowl-logo.png",
  "Snoop Dogg Arizona Bowl": "arizona-bowl-logo.svg",
  "SRS Distribution Las Vegas Bowl": "las-vegas-bowl-35.png",
  "StaffDNA Cure Bowl": "curebowllogo24.svg",
  "Sugar Bowl": "sugar-bowl-logo.svg",
  "Sun Bowl": "old-el-paso-sun-bowl-logo.png",
  "TaxSlayer Gator Bowl": "taxslayer-gator-bowl-logo.svg",
  "Texas Bowl": "texas-bowl-logo24.png",
  "Tony the Tiger Sun Bowl": "old-el-paso-sun-bowl-logo.png",
  "Trust & Will Holiday Bowl": "holiday-bowl-26.png",
  "Union Home Mortgage Gasparilla Bowl": "uniongasparillabowl.png",
  "Valero Alamo Bowl": "valero-alamo-bowl-logo.svg",
  "Vrbo Fiesta Bowl": "fiesta-bowl-logo.svg",
  "Wasabi Fenway Bowl": "wasabifenwaybowl.png",
  "Xbox Bowl": "frisco-football-classic.png",
};

const norm = s => s.normalize('NFKD').toLowerCase().replace(/[\u0300-\u036f\u02bb\u2018\u2019']/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
const INDEX = new Map(Object.entries(LOGOS).map(([k, file]) => [norm(k), DIR + file]));

// Tries the full name, then drops sponsor words from the front: "Bucked Up LA Bowl" -> "LA Bowl".
export function bowlLogo(title, overrides = {}) {
  for (const [k, url] of Object.entries(overrides)) if (norm(k) === norm(title)) return url;
  const words = norm(title).split(' ');
  for (let i = 0; i < words.length - 1; i++) {
    const hit = INDEX.get(words.slice(i).join(' ')) || INDEX.get(words.slice(i).join(' ') + ' game');
    if (hit) return hit;
  }
  return '';
}

export const PLAYOFF_LOGO = DIR + LOGOS['College Football Playoff'];
