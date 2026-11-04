/**
 * Club colours (factual, public information) used to render AthosBet's generated crest when no
 * licensed logo is available. This deliberately does NOT reproduce any club's registered crest:
 * official crests are trademarks and are displayed only from a licensed source (the data feed's
 * logo, e.g. API-Football, or an asset uploaded by an operator holding the rights).
 * [primary, secondary, pattern]
 */
export type CrestPattern = 'solid' | 'stripes' | 'hoops' | 'sash' | 'halves';
export const CLUB_COLORS: Record<string, [string, string, CrestPattern]> = {
  // Brasileirão Série A
  Flamengo: ['#C8102E', '#111111', 'hoops'], Palmeiras: ['#006437', '#FFFFFF', 'solid'], Botafogo: ['#111111', '#FFFFFF', 'stripes'],
  'São Paulo': ['#FFFFFF', '#D50000', 'hoops'], Corinthians: ['#FFFFFF', '#111111', 'solid'], Fluminense: ['#7A1E3A', '#00613C', 'stripes'],
  Internacional: ['#D50000', '#FFFFFF', 'solid'], 'Grêmio': ['#0D80BF', '#111111', 'stripes'], 'Atlético Mineiro': ['#111111', '#FFFFFF', 'stripes'],
  Cruzeiro: ['#003DA5', '#FFFFFF', 'solid'], Bahia: ['#0055A4', '#D50000', 'halves'], 'Vasco da Gama': ['#111111', '#FFFFFF', 'sash'],
  Fortaleza: ['#0B4EA2', '#D50000', 'hoops'], 'Red Bull Bragantino': ['#FFFFFF', '#D50000', 'solid'], Santos: ['#FFFFFF', '#111111', 'solid'],
  'Athletico Paranaense': ['#C8102E', '#111111', 'stripes'], 'Vitória': ['#D50000', '#111111', 'hoops'], Mirassol: ['#F6D600', '#00843D', 'solid'],
  'Ceará': ['#111111', '#FFFFFF', 'stripes'], 'Sport Recife': ['#D50000', '#111111', 'hoops'],
  // Série B
  Coritiba: ['#00544D', '#FFFFFF', 'hoops'], 'Goiás': ['#00843D', '#FFFFFF', 'solid'], Novorizontino: ['#F6D600', '#111111', 'solid'],
  'América Mineiro': ['#00843D', '#111111', 'solid'], Chapecoense: ['#00843D', '#FFFFFF', 'solid'], 'Criciúma': ['#F6D600', '#111111', 'stripes'],
  'Avaí': ['#0055A4', '#FFFFFF', 'stripes'], 'Cuiabá': ['#00843D', '#F6D600', 'halves'], Paysandu: ['#5BB4E5', '#FFFFFF', 'stripes'],
  'Operário': ['#111111', '#FFFFFF', 'stripes'], CRB: ['#D50000', '#FFFFFF', 'stripes'], 'Botafogo-SP': ['#D50000', '#111111', 'stripes'],
  'Atlético Goianiense': ['#D50000', '#111111', 'stripes'], 'Vila Nova': ['#D50000', '#FFFFFF', 'solid'], Remo: ['#0B2A5B', '#FFFFFF', 'solid'],
  'Ferroviária': ['#7A1E3A', '#FFFFFF', 'solid'], Amazonas: ['#F6D600', '#111111', 'stripes'], 'Volta Redonda': ['#F6D600', '#111111', 'stripes'],
  'Athletic Club': ['#111111', '#FFFFFF', 'stripes'], Juventude: ['#00843D', '#FFFFFF', 'stripes'],
  // Premier League
  Arsenal: ['#EF0107', '#FFFFFF', 'solid'], 'Manchester City': ['#6CABDD', '#FFFFFF', 'solid'], Liverpool: ['#C8102E', '#FFFFFF', 'solid'],
  Chelsea: ['#034694', '#FFFFFF', 'solid'], 'Tottenham Hotspur': ['#FFFFFF', '#132257', 'solid'], 'Manchester United': ['#DA291C', '#111111', 'solid'],
  'Newcastle United': ['#111111', '#FFFFFF', 'stripes'], 'Aston Villa': ['#670E36', '#95BFE5', 'halves'], Brighton: ['#0057B8', '#FFFFFF', 'stripes'],
  'West Ham United': ['#7A263A', '#1BB1E7', 'halves'], 'Crystal Palace': ['#1B458F', '#C4122E', 'halves'], Brentford: ['#E30613', '#FFFFFF', 'stripes'],
  Fulham: ['#FFFFFF', '#111111', 'solid'], Wolverhampton: ['#FDB913', '#231F20', 'solid'], Everton: ['#003399', '#FFFFFF', 'solid'],
  Bournemouth: ['#DA291C', '#111111', 'stripes'], 'Nottingham Forest': ['#DD0000', '#FFFFFF', 'solid'], 'Leeds United': ['#FFFFFF', '#1D428A', 'solid'],
  Burnley: ['#6C1D45', '#99D6EA', 'halves'], Sunderland: ['#EB172B', '#FFFFFF', 'stripes'],
  // La Liga
  'Real Madrid': ['#FFFFFF', '#FEBE10', 'solid'], Barcelona: ['#004D98', '#A50044', 'stripes'], 'Atlético Madrid': ['#CB3524', '#FFFFFF', 'stripes'],
  'Athletic Bilbao': ['#EE2523', '#FFFFFF', 'stripes'], 'Real Sociedad': ['#0067B1', '#FFFFFF', 'stripes'], Villarreal: ['#FFE667', '#005187', 'solid'],
  'Real Betis': ['#00954C', '#FFFFFF', 'stripes'], Sevilla: ['#FFFFFF', '#D71920', 'solid'], Valencia: ['#FFFFFF', '#111111', 'solid'],
  Girona: ['#CD2534', '#FFFFFF', 'stripes'], 'Celta Vigo': ['#8AC3EE', '#FFFFFF', 'solid'], Osasuna: ['#D91A21', '#0A346F', 'solid'],
  Getafe: ['#005999', '#FFFFFF', 'solid'], 'Rayo Vallecano': ['#FFFFFF', '#E53027', 'sash'], Mallorca: ['#E20613', '#111111', 'solid'],
  'Alavés': ['#0761AF', '#FFFFFF', 'stripes'], Espanyol: ['#007FC8', '#FFFFFF', 'stripes'], Levante: ['#004D98', '#A50044', 'stripes'],
  Elche: ['#FFFFFF', '#05642C', 'hoops'], 'Real Oviedo': ['#0057A8', '#FFFFFF', 'solid'],
  // Serie A
  Inter: ['#0068A8', '#111111', 'stripes'], Napoli: ['#12A0D7', '#FFFFFF', 'solid'], Juventus: ['#111111', '#FFFFFF', 'stripes'],
  Milan: ['#FB090B', '#111111', 'stripes'], Atalanta: ['#1E71B8', '#111111', 'stripes'], Roma: ['#8E1F2F', '#F0BC42', 'solid'],
  Lazio: ['#87D8F7', '#FFFFFF', 'solid'], Fiorentina: ['#482E92', '#FFFFFF', 'solid'], Bologna: ['#A21C26', '#1A2F48', 'stripes'],
  Torino: ['#8A1E03', '#FFFFFF', 'solid'], Udinese: ['#111111', '#FFFFFF', 'stripes'], Genoa: ['#AD0A26', '#002D62', 'halves'],
  Como: ['#003DA5', '#FFFFFF', 'solid'], Cagliari: ['#A6192E', '#002D62', 'halves'], Lecce: ['#F6D600', '#D50000', 'stripes'],
  Parma: ['#FFD200', '#003DA5', 'solid'], Verona: ['#FFD200', '#003DA5', 'solid'], Sassuolo: ['#00A752', '#111111', 'stripes'],
  Cremonese: ['#C8102E', '#9EA2A2', 'stripes'], Pisa: ['#111111', '#0055A4', 'stripes'],
  // Bundesliga
  'Bayern München': ['#DC052D', '#FFFFFF', 'solid'], 'Bayer Leverkusen': ['#E32221', '#111111', 'solid'], 'Borussia Dortmund': ['#FDE100', '#111111', 'solid'],
  'RB Leipzig': ['#FFFFFF', '#DD0741', 'solid'], 'Eintracht Frankfurt': ['#111111', '#E1000F', 'solid'], 'VfB Stuttgart': ['#FFFFFF', '#E32219', 'hoops'],
  'SC Freiburg': ['#D50000', '#111111', 'solid'], 'Borussia Mönchengladbach': ['#FFFFFF', '#111111', 'solid'], Wolfsburg: ['#65B32E', '#FFFFFF', 'solid'],
  'Mainz 05': ['#C3141E', '#FFFFFF', 'solid'], 'Werder Bremen': ['#1D9053', '#FFFFFF', 'solid'], 'Union Berlin': ['#EB1923', '#FFFFFF', 'solid'],
  Augsburg: ['#BA3733', '#46714D', 'halves'], Hoffenheim: ['#1961B5', '#FFFFFF', 'solid'], Heidenheim: ['#E30613', '#003B79', 'halves'],
  'St. Pauli': ['#5A3825', '#FFFFFF', 'solid'], 'Hamburger SV': ['#FFFFFF', '#0A3F86', 'solid'], '1. FC Köln': ['#FFFFFF', '#ED1C24', 'solid'],
  // UEFA / CONMEBOL extras
  'Paris Saint-Germain': ['#004170', '#DA291C', 'solid'], Benfica: ['#E83030', '#FFFFFF', 'solid'], Porto: ['#00428C', '#FFFFFF', 'stripes'], PSV: ['#ED1C24', '#FFFFFF', 'stripes'],
  'River Plate': ['#FFFFFF', '#EB192E', 'sash'], 'Boca Juniors': ['#103F79', '#F3B229', 'hoops'], 'Racing Club': ['#6CB4E4', '#FFFFFF', 'stripes'],
  Estudiantes: ['#D50000', '#FFFFFF', 'stripes'], 'Peñarol': ['#FFD200', '#111111', 'stripes'], Nacional: ['#FFFFFF', '#00205B', 'solid'],
  'Colo-Colo': ['#FFFFFF', '#111111', 'solid'], 'Atlético Nacional': ['#00843D', '#FFFFFF', 'stripes'], 'LDU Quito': ['#FFFFFF', '#C8102E', 'solid'],
  Universitario: ['#F2E8C9', '#7A1E3A', 'solid'],
};
