// RSS feeds from gaming publishers; if one fails, other feeds still work.
export const SOURCES = Object.freeze([
  { name: 'Gematsu', url: 'https://www.gematsu.com/feed', hosts: ['www.gematsu.com', 'gematsu.com'] },
  { name: 'PlayStation Blog', url: 'https://blog.playstation.com/feed/', hosts: ['blog.playstation.com'] },
  { name: 'PC Gamer', url: 'https://www.pcgamer.com/feed/', hosts: ['www.pcgamer.com', 'pcgamer.com'] },
  { name: 'Video Games Chronicle', url: 'https://www.videogameschronicle.com/feed/', hosts: ['www.videogameschronicle.com', 'videogameschronicle.com'] }
]);
