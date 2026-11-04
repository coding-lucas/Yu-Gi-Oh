/**
 * Canonical market catalogue for football (soccer).
 * Every market priced, displayed or settled anywhere in AthosBet MUST be declared here.
 */
export const MARKET_TYPES = [
  'MATCH_RESULT',
  'DOUBLE_CHANCE',
  'DRAW_NO_BET',
  'BOTH_TEAMS_TO_SCORE',
  'TOTAL_GOALS',
  'CORRECT_SCORE',
] as const;
export type MarketType = (typeof MARKET_TYPES)[number];

/** Lines offered for TOTAL_GOALS. Only half lines are used so that no push is possible. */
export const TOTAL_GOALS_LINES = [0.5, 1.5, 2.5, 3.5, 4.5, 5.5] as const;

/** Correct-score grid offered (0..MAX each side) plus three "any other" buckets. */
export const CORRECT_SCORE_MAX = 4;
export const CORRECT_SCORE_OTHER = ['OTHER_HOME', 'OTHER_DRAW', 'OTHER_AWAY'] as const;

export function correctScoreSelections(): string[] {
  const out: string[] = [];
  for (let h = 0; h <= CORRECT_SCORE_MAX; h++) {
    for (let a = 0; a <= CORRECT_SCORE_MAX; a++) out.push(`${h}-${a}`);
  }
  return [...out, ...CORRECT_SCORE_OTHER];
}

export const MARKET_SELECTIONS: Record<Exclude<MarketType, 'CORRECT_SCORE'>, readonly string[]> = {
  MATCH_RESULT: ['HOME', 'DRAW', 'AWAY'],
  DOUBLE_CHANCE: ['HOME_DRAW', 'HOME_AWAY', 'DRAW_AWAY'],
  DRAW_NO_BET: ['HOME', 'AWAY'],
  BOTH_TEAMS_TO_SCORE: ['YES', 'NO'],
  TOTAL_GOALS: ['OVER', 'UNDER'],
};

export function selectionsFor(type: MarketType): readonly string[] {
  return type === 'CORRECT_SCORE' ? correctScoreSelections() : MARKET_SELECTIONS[type];
}

/** A market key uniquely identifies a market inside a match, e.g. `TOTAL_GOALS@2.5`. */
export function marketKey(type: MarketType, line?: number | null): string {
  return line === undefined || line === null ? type : `${type}@${line}`;
}

export function parseMarketKey(key: string): { type: MarketType; line: number | null } {
  const [type, line] = key.split('@');
  if (!(MARKET_TYPES as readonly string[]).includes(type)) throw new Error(`Unknown market type: ${type}`);
  return { type: type as MarketType, line: line === undefined ? null : Number(line) };
}

export function isValidSelection(type: MarketType, selection: string, line?: number | null): boolean {
  if (type === 'TOTAL_GOALS') {
    if (line === undefined || line === null || !Number.isFinite(line) || line < 0) return false;
  } else if (line !== undefined && line !== null) {
    return false;
  }
  return selectionsFor(type).includes(selection);
}

/** Human-readable, explicit settlement rules. Shown in the UI and referenced by settlement code. */
export const MARKET_RULES: Record<MarketType | 'GENERAL', { en: string; pt: string }> = {
  GENERAL: {
    en: 'All football markets are settled on the official result at the end of regular time (90 minutes plus stoppage time). Extra time and penalty shoot-outs do not count. If a match is cancelled, abandoned, or postponed and not played within 48 hours of the original kick-off, all its selections are void (odds 1.00). Results are taken from the official data provider; if an official result is corrected, bets are re-settled.',
    pt: 'Todos os mercados de futebol são liquidados pelo resultado oficial ao fim do tempo regulamentar (90 minutos mais acréscimos). Prorrogação e disputa de pênaltis não contam. Se a partida for cancelada, abandonada ou adiada e não for disputada em até 48 horas do horário original, todas as seleções são anuladas (odd 1,00). Os resultados vêm do provedor oficial de dados; se o resultado oficial for corrigido, as apostas são reliquidadas.',
  },
  MATCH_RESULT: {
    en: '1X2: predict whether the home team wins, the match is drawn, or the away team wins.',
    pt: '1X2: preveja vitória do mandante, empate ou vitória do visitante.',
  },
  DOUBLE_CHANCE: {
    en: 'Double chance: the selection wins if either of the two covered outcomes happens.',
    pt: 'Dupla chance: a seleção vence se qualquer um dos dois resultados cobertos ocorrer.',
  },
  DRAW_NO_BET: {
    en: 'Draw no bet: if the match ends in a draw, the selection is void and the stake is returned.',
    pt: 'Empate anula: se a partida terminar empatada, a seleção é anulada e o valor é devolvido.',
  },
  BOTH_TEAMS_TO_SCORE: {
    en: 'Both teams to score: "Yes" wins if each team scores at least one goal; own goals count for the team credited.',
    pt: 'Ambas marcam: "Sim" vence se cada equipe marcar ao menos um gol; gols contra contam para a equipe beneficiada.',
  },
  TOTAL_GOALS: {
    en: 'Total goals: over/under the stated line on the combined score. If the total equals an integer line the selection is void.',
    pt: 'Total de gols: mais/menos que a linha indicada no placar combinado. Se o total for igual a uma linha inteira, a seleção é anulada.',
  },
  CORRECT_SCORE: {
    en: 'Correct score: the exact final score. "Any other" buckets win when the score is outside the listed grid with that outcome.',
    pt: 'Placar exato: o placar final exato. As opções "outro" vencem quando o placar está fora da grade listada com aquele resultado.',
  },
};
