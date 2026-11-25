// Priority is editorial preference, not a measured image success rate.
export const SOURCES=Object.freeze([
  {name:'Gematsu',url:'https://www.gematsu.com/feed',hosts:['www.gematsu.com','gematsu.com'],media:['gematsu.com'],priority:2},
  {name:'PlayStation Blog',url:'https://blog.playstation.com/feed/',hosts:['blog.playstation.com'],media:['playstation.com'],priority:4},
  {name:'PC Gamer',url:'https://www.pcgamer.com/feeds.xml',hosts:['www.pcgamer.com','pcgamer.com'],media:['pcgamer.com','futurecdn.net'],priority:2},
  {name:'Video Games Chronicle',url:'https://www.videogameschronicle.com/feed/',hosts:['www.videogameschronicle.com','videogameschronicle.com'],media:['videogameschronicle.com','gnwcdn.com'],priority:1},
  {name:'Steam',url:'https://store.steampowered.com/feeds/news/collection/steam',extraFeeds:['https://store.steampowered.com/feeds/news/collection/featured/'],hosts:['store.steampowered.com','steamcommunity.com','www.steamcommunity.com'],media:['steamstatic.com','steamusercontent.com','steamcdn-a.akamaihd.net','steampowered.com'],priority:5},
  {name:'IGN',url:'https://www.ign.com/rss/v2/articles/feed',hosts:['www.ign.com','ign.com'],media:['ign.com','ignimgs.com'],priority:2},
  {name:'GameSpot',url:'https://www.gamespot.com/feeds/news/',hosts:['www.gamespot.com','gamespot.com'],media:['gamespot.com','gamespot1.cbsistatic.com','gamespot2.cbsistatic.com'],priority:2},
  {name:'PCGamesN',url:'https://www.pcgamesn.com/mainrss.xml',hosts:['www.pcgamesn.com','pcgamesn.com'],media:['pcgamesn.com'],priority:1},
  {name:'Eurogamer',url:'https://www.eurogamer.net/feed',hosts:['www.eurogamer.net','eurogamer.net'],media:['eurogamer.net','gnwcdn.com'],priority:1},
  {name:'GamesRadar+',url:'https://www.gamesradar.com/feeds.xml',hosts:['www.gamesradar.com','gamesradar.com'],media:['gamesradar.com','futurecdn.net'],priority:1},
  {name:'Xbox Wire',url:'https://news.xbox.com/en-us/feed/',hosts:['news.xbox.com'],media:['xbox.com','xboxwire.thesourcemediaassets.com'],priority:2},
  {name:'Nintendo Life',url:'https://www.nintendolife.com/feeds/latest',hosts:['www.nintendolife.com','nintendolife.com'],media:['nintendolife.com'],priority:1},
  {name:'Pocket Gamer',url:'https://www.pocketgamer.com/index.rss',hosts:['www.pocketgamer.com','pocketgamer.com'],media:['pocketgamer.com'],priority:1},
  {name:'TechPowerUp',url:'https://www.techpowerup.com/rss/news',hosts:['www.techpowerup.com','techpowerup.com'],media:['techpowerup.com'],priority:1},
  {name:'Dexerto',url:'https://www.dexerto.com/feed/',hosts:['www.dexerto.com','dexerto.com'],media:['dexerto.com'],priority:1}
]);
export const FEEDS=Object.freeze(SOURCES.flatMap(s=>[s.url,...(s.extraFeeds||[])].map(url=>({...s,url}))));
export const sourceByName=name=>SOURCES.find(s=>s.name===name);
